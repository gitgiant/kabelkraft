/**
 * KabelKraft audio engine v0 — runs inside an AudioWorklet.
 *
 * Plain JS (no bundler involvement) so it loads identically in dev and build.
 * Mirrors the audio-relevant subset of the patch graph. The worklet owns the
 * transport clock: sequencers step sample-accurately against it, LFOs feed
 * control wires, synths render polyphonic voices, audioOut sums into the
 * device output behind a default-on safety limiter (PRD §9.4).
 *
 * Message protocol: see src/engine/messages.ts.
 */

const MAX_VOICES = 16;
const LIMITER_CEILING = 0.95;
const STATUS_INTERVAL_S = 1 / 30;

const WAVE_SINE = 0;
const WAVE_TRIANGLE = 1;
const WAVE_SQUARE = 2;
const WAVE_SAW = 3;
const WAVE_NOISE = 4;

const WT_FRAME = 2048;

/**
 * Sample-player component voice (replaces the monolithic Sampler). Note-in,
 * pitched playback with a built-in A/D/S/R amp env and per-voice pan. Extra
 * component params over the old sampler:
 *  - voices: poly cap (1 = mono → retrigger steals, the drum-pad behaviour);
 *  - trigNote: when >= 0, only fire on that incoming pitch (drum-map row);
 *  - fixedPitch: ignore incoming pitch, always play at root (drum one-shot);
 *  - chokeGroup: when > 0, a hit cuts active voices of OTHER smpl modules in
 *    the same group (open/closed hi-hat) — handled by the host via `chokeGroup`.
 */
class SmplModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'smpl';
    this.params = params;
    this.controlIn = {};
    this.host = null; // set by the host for cross-module choke
    this.sample = null; // { sampleRate, chL, chR, loopStart, loopEnd }
    this.voices = [];
    for (let i = 0; i < MAX_VOICES; i++) {
      this.voices.push({ active: false, voiceId: -1, pos: 0, rate: 1, velocity: 1, stage: 'off', env: 0, age: 0, pan: 0, relVel: 0.5, choked: false });
    }
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
  }

  setSample(sampleRate, channels, loopStart, loopEnd) {
    this.sample = {
      sampleRate,
      chL: channels[0],
      chR: channels[1] || channels[0],
      loopStart: Math.max(0, loopStart || 0),
      loopEnd: loopEnd || 0,
    };
    for (const v of this.voices) v.active = false;
  }

  /** Hard kill (stop ×2): cut all playing sample voices instantly. */
  panic() {
    for (const v of this.voices) {
      v.active = false;
      v.stage = 'off';
      v.env = 0;
    }
  }

  noteOn(voiceId, pitch, velocity, extras) {
    if (!this.sample) return;
    const tn = Math.round(this.params.trigNote ?? -1);
    if (tn >= 0 && Math.round(pitch) !== tn) return; // drum-map: only my row
    // Cross-module choke: cut same-group voices on other smpl modules.
    const group = Math.round(this.params.chokeGroup ?? 0);
    if (group > 0 && this.host) this.host.chokeGroup(this.id, group);
    // Poly cap (voices=1 → mono, retrigger steals).
    const cap = Math.max(1, Math.min(MAX_VOICES, Math.round(this.params.voices ?? 8)));
    let active = 0;
    for (const v of this.voices) if (v.active) active++;
    let voice = this.voices.find((v) => !v.active);
    if (!voice || active >= cap) {
      voice = this.voices.reduce((a, b) => (a.age > b.age ? a : b));
    }
    const root = this.params.root ?? 60;
    const fixed = (this.params.fixedPitch ?? 0) >= 0.5;
    const playPitch = fixed ? root : pitch;
    voice.active = true;
    voice.choked = false;
    voice.voiceId = voiceId;
    voice.pos = 0;
    voice.rate = Math.pow(2, (playPitch - root) / 12) * (this.sample.sampleRate / sampleRate);
    voice.velocity = velocity;
    voice.stage = 'attack';
    voice.env = 0;
    voice.age = 0;
    voice.pan = extras && extras.pan !== undefined ? extras.pan : 0;
    voice.relVel = 0.5;
  }

  noteOff(voiceId, release) {
    for (const v of this.voices) {
      if (v.active && v.voiceId === voiceId) {
        v.stage = 'release';
        if (release !== undefined) v.relVel = release;
      }
    }
  }

  /** Mark all sounding voices for a fast choke fade (called by the host). */
  choke() {
    for (const v of this.voices) if (v.active) v.choked = true;
  }

  render(blockSize) {
    this.outL.fill(0);
    this.outR.fill(0);
    if (!this.sample) return;
    const p = this.params;
    const loop = Math.round(p.mode ?? 0) === 1;
    const level = p.level ?? 0.8;
    const atkStep = 1 / (Math.max(0.001, p.attack ?? 0.005) * sampleRate);
    const decStep = 1 / (Math.max(0.001, p.decay ?? 0.1) * sampleRate);
    const sustain = p.sustain ?? 1;
    const relStep = 1 / (Math.max(0.001, p.release ?? 0.2) * sampleRate);
    const chokeCoef = Math.exp(-1 / (0.003 * sampleRate)); // ~3 ms choke fade
    const { chL, chR, loopStart } = this.sample;
    const len = chL.length;
    const loopEnd =
      this.sample.loopEnd > loopStart + 1 ? Math.min(this.sample.loopEnd, len - 1) : len - 1;

    for (const v of this.voices) {
      if (!v.active) continue;
      const relStepV = relStep * (0.5 + (v.relVel === undefined ? 0.5 : v.relVel));
      const pan = v.pan || 0;
      const gPanL = Math.min(1, 1 - pan);
      const gPanR = Math.min(1, 1 + pan);
      for (let i = 0; i < blockSize; i++) {
        if (v.choked) {
          v.env *= chokeCoef;
          if (v.env < 0.001) { v.env = 0; v.stage = 'off'; v.active = false; break; }
        } else if (v.stage === 'attack') {
          v.env += atkStep;
          if (v.env >= 1) { v.env = 1; v.stage = 'decay'; }
        } else if (v.stage === 'decay') {
          v.env -= decStep;
          if (v.env <= sustain) { v.env = sustain; v.stage = 'sustain'; }
        } else if (v.stage === 'release') {
          v.env -= relStepV;
          if (v.env <= 0) { v.env = 0; v.stage = 'off'; v.active = false; break; }
        }

        let i0 = Math.floor(v.pos);
        if (loop && i0 >= loopEnd && loopEnd > loopStart) {
          v.pos -= loopEnd - loopStart;
          i0 = Math.floor(v.pos);
        }
        if (i0 >= len - 1) {
          v.active = false;
          break;
        }
        const frac = v.pos - i0;
        const g = v.env * v.velocity * level;
        this.outL[i] += (chL[i0] * (1 - frac) + chL[i0 + 1] * frac) * g * gPanL;
        this.outR[i] += (chR[i0] * (1 - frac) + chR[i0 + 1] * frac) * g * gPanR;
        v.pos += v.rate;
      }
      v.age++;
    }
  }
}

const LFO_SINE = 0;
const LFO_TRIANGLE = 1;
const LFO_SQUARE = 2;
const LFO_SAW = 3;
const LFO_SH = 4;

class LfoModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'lfo';
    this.params = params;
    this.phase = 0;
    this.shValue = Math.random();
    /** Block-rate control output, 0..1. */
    this.value = 0.5;
  }

  render(blockSize) {
    const shape = Math.round(this.params.shape ?? LFO_SINE);
    const rate = this.params.rate ?? 2;
    const depth = this.params.depth ?? 0.5;
    const offset = this.params.offset ?? 0.5;

    let raw; // -1..1
    switch (shape) {
      case LFO_TRIANGLE: raw = 4 * Math.abs(this.phase - 0.5) - 1; break;
      case LFO_SQUARE: raw = this.phase < 0.5 ? 1 : -1; break;
      case LFO_SAW: raw = 2 * this.phase - 1; break;
      case LFO_SH: raw = this.shValue * 2 - 1; break;
      case LFO_SINE:
      default: raw = Math.sin(2 * Math.PI * this.phase); break;
    }
    this.value = Math.min(1, Math.max(0, offset + raw * depth * 0.5));

    this.phase += (rate * blockSize) / sampleRate;
    if (this.phase >= 1) {
      this.phase -= Math.floor(this.phase);
      this.shValue = Math.random();
    }
  }
}

// ---------------------------------------------------------------------------
// Polyphonic component plumbing (build-your-own-synth chains, PRD §8.2/§8.6)
//
// A control wire value is a scalar (mono) or a Float32Array — one value per
// voice lane, produced by a Voice module. Audio between poly-aware components
// flows as per-lane stereo buffers (polyL/polyR + polyLanes on the source,
// polyIn on the destination). Poly sources always also fill the summed
// outL/outR, so any plain stereo input collapses the lanes to a mix and the
// 28 pre-poly modules need no changes.
// ---------------------------------------------------------------------------

const SILENT_BLOCK = new Float32Array(128);

/** Block-rate (control) modules: rendered then skipped by the audio dispatch. */
const CONTROL_RATE_TYPES = new Set([
  'lfo', 'adsr', 'random',
  'voice', 'knob', 'slider', 'xy', 'button', 'quantizer', 'sah', 'slew', 'cmath', 'modmatrix',
]);

/** Read a control value for one lane; scalars apply to every lane. */
function cval(v, lane) {
  if (v === undefined) return undefined;
  if (typeof v === 'number') return v;
  return v[lane < v.length ? lane : v.length - 1];
}

/** Lane count of a control value: 0 = mono scalar. */
function cwidth(v) {
  return v !== undefined && typeof v !== 'number' ? v.length : 0;
}

function makePolyIn() {
  return { lanes: 0, L: [], R: [] };
}

function ensureLanes(mod, n) {
  while (mod.polyL.length < n) {
    mod.polyL.push(new Float32Array(128));
    mod.polyR.push(new Float32Array(128));
  }
}

/**
 * Control envelope with two gate sources:
 * - note input: any held note keeps the gate open (monophonic, original path);
 * - 'gate' control input: when polyphonic (from a Voice module) one envelope
 *   runs per lane, so every voice gets its own contour.
 */
class AdsrModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'adsr';
    this.params = params;
    this.controlIn = {};
    this.held = new Set();
    this.stage = 'off'; // attack | decay | sustain | release | off
    this.env = 0;
    this.value = 0;
    this.controlOut = { out: 0 };
    this.lanes = []; // per-lane { stage, env } for gate mode
    this.gateOut = null;
  }

  noteOn(voiceId) {
    this.held.add(voiceId);
    this.stage = 'attack';
  }

  noteOff(voiceId) {
    this.held.delete(voiceId);
    if (this.held.size === 0 && this.stage !== 'off') this.stage = 'release';
  }

  /** Hard kill (stop ×2): silence instantly instead of riding out a release. */
  panic() {
    this.held.clear();
    this.stage = 'off';
    this.env = 0;
    this.value = 0;
    this.controlOut.out = 0;
    for (const st of this.lanes) {
      st.stage = 'off';
      st.env = 0;
    }
    if (this.gateOut) this.gateOut.fill(0);
  }

  /** Advance one envelope state (`{stage, env}`) by `step` seconds. */
  advance(st, step) {
    const p = this.params;
    if (st.stage === 'attack') {
      st.env += step / Math.max(0.001, p.attack ?? 0.05);
      if (st.env >= 1) { st.env = 1; st.stage = 'decay'; }
    } else if (st.stage === 'decay') {
      const sustain = p.sustain ?? 0.6;
      st.env -= step / Math.max(0.001, p.decay ?? 0.2);
      if (st.env <= sustain) { st.env = sustain; st.stage = 'sustain'; }
    } else if (st.stage === 'release') {
      st.env -= step / Math.max(0.001, p.release ?? 0.3);
      if (st.env <= 0) { st.env = 0; st.stage = 'off'; }
    }
    return st.env;
  }

  gateLane(st, open) {
    if (open && (st.stage === 'off' || st.stage === 'release')) st.stage = 'attack';
    else if (!open && st.stage !== 'off' && st.stage !== 'release') st.stage = 'release';
  }

  render(blockSize) {
    const step = blockSize / sampleRate;
    const gate = this.controlIn.gate;

    if (gate !== undefined) {
      const width = cwidth(gate);
      const n = Math.max(1, width);
      while (this.lanes.length < n) this.lanes.push({ stage: 'off', env: 0 });
      if (width > 0) {
        if (!this.gateOut || this.gateOut.length !== width) this.gateOut = new Float32Array(width);
        for (let v = 0; v < width; v++) {
          const st = this.lanes[v];
          this.gateLane(st, gate[v] > 0.5);
          this.gateOut[v] = this.advance(st, step);
        }
        this.controlOut.out = this.gateOut;
        this.value = this.gateOut[0];
      } else {
        const st = this.lanes[0];
        this.gateLane(st, gate > 0.5);
        this.value = this.advance(st, step);
        this.controlOut.out = this.value;
      }
      return;
    }

    this.value = this.advance(this, step); // note-gated path: `this` carries stage/env
    this.controlOut.out = this.value;
  }
}

/**
 * Voice allocator — root of a component synth chain: polyphonic note stream
 * in, per-voice pitch/gate/velocity control lanes out. Pitch is MIDI/127.
 */
class VoiceModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'voice';
    this.params = params;
    this.controlIn = {};
    this.slots = [];
    for (let i = 0; i < MAX_VOICES; i++) {
      this.slots.push({ active: false, voiceId: -1, pitch: 60, curPitch: 60, vel: 0, age: 0, retrig: false });
    }
    this.controlOut = { pitch: new Float32Array(0), gate: new Float32Array(0), vel: new Float32Array(0) };
    this.lastPitch = undefined;
  }

  count() {
    return Math.min(MAX_VOICES, Math.max(1, Math.round(this.params.voices ?? 4)));
  }

  noteOn(voiceId, pitch, velocity) {
    const usable = this.slots.slice(0, this.count());
    let slot = usable.find((s) => !s.active);
    if (!slot) slot = usable.reduce((a, b) => (a.age > b.age ? a : b)); // steal oldest
    // A stolen voice dips its gate for one block so envelopes retrigger;
    // its pitch glides from where it was. Fresh voices glide from the last note.
    slot.retrig = slot.active;
    slot.active = true;
    slot.voiceId = voiceId;
    slot.vel = velocity;
    slot.age = 0;
    const glide = this.params.glide ?? 0;
    if (!(glide > 0.001)) slot.curPitch = pitch;
    else if (!slot.retrig && this.lastPitch !== undefined) slot.curPitch = this.lastPitch;
    slot.pitch = pitch;
    this.lastPitch = pitch;
  }

  noteOff(voiceId) {
    for (const s of this.slots) {
      if (s.active && s.voiceId === voiceId) s.active = false;
    }
  }

  /** Hard kill: drop every slot so gates read 0 next block (stop ×2). A slot
   * can wedge open if its note-off got lost (e.g. the source wire was deleted
   * mid-note) — panic is the escape hatch. */
  panic() {
    for (const s of this.slots) {
      s.active = false;
      s.retrig = false;
    }
  }

  render(blockSize) {
    const n = this.count();
    let out = this.controlOut;
    if (out.pitch.length !== n) {
      out = this.controlOut = {
        pitch: new Float32Array(n),
        gate: new Float32Array(n),
        vel: new Float32Array(n),
      };
    }
    const glide = this.params.glide ?? 0;
    const k = glide > 0.001 ? 1 - Math.exp((-(blockSize / sampleRate) * 4) / glide) : 1;
    for (let i = 0; i < n; i++) {
      const s = this.slots[i];
      s.curPitch += (s.pitch - s.curPitch) * k;
      out.pitch[i] = Math.min(1, Math.max(0, s.curPitch / 127));
      out.gate[i] = s.active && !s.retrig ? 1 : 0;
      out.vel[i] = s.vel;
      if (s.active) {
        s.age++;
        s.retrig = false;
      }
    }
  }
}

/** Oscillator component: pitch control in (MIDI/127, poly-aware), audio out. */
class OscModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'osc';
    this.params = params;
    this.controlIn = {};
    this.polyIn = { fm: makePolyIn() };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    this.polyL = [];
    this.polyR = [];
    this.polyLanes = 0;
    this.phases = new Float64Array(MAX_VOICES);
  }

  render(blockSize) {
    const p = this.params;
    const wave = Math.round(p.wave ?? WAVE_SAW);
    const offs = Math.round(p.octave ?? 0) * 12 + Math.round(p.semi ?? 0) + (p.fine ?? 0) / 100;
    const pwm = p.pwm ?? 0.5;
    const fmAmt = p.fmAmt ?? 0;
    const level = p.level ?? 0.8;

    const pitchIn = this.controlIn.pitch;
    const lanes = Math.min(MAX_VOICES, cwidth(pitchIn));
    this.polyLanes = lanes;
    const n = Math.max(1, lanes);
    ensureLanes(this, n);
    this.outL.fill(0);

    const fm = this.polyIn.fm;
    for (let v = 0; v < n; v++) {
      const base = lanes > 0 ? pitchIn[v] * 127 : pitchIn !== undefined ? pitchIn * 127 : 60;
      const freq = 440 * Math.pow(2, (base + offs - 69) / 12);
      const phaseStep = freq / sampleRate;
      const fmBuf = fm.lanes > 0 ? fm.L[Math.min(v, fm.lanes - 1)] : SILENT_BLOCK;
      const L = this.polyL[v];
      let ph = this.phases[v];
      for (let i = 0; i < blockSize; i++) {
        let pp = ph;
        if (fmAmt > 0) {
          pp += fmAmt * fmBuf[i];
          pp -= Math.floor(pp);
        }
        let s;
        switch (wave) {
          case WAVE_SINE: s = Math.sin(2 * Math.PI * pp); break;
          case WAVE_TRIANGLE: s = 4 * Math.abs(pp - 0.5) - 1; break;
          case WAVE_SQUARE: s = pp < pwm ? 1 : -1; break;
          case WAVE_NOISE: s = Math.random() * 2 - 1; break;
          case WAVE_SAW:
          default: s = 2 * pp - 1; break;
        }
        s *= level;
        L[i] = s;
        this.outL[i] += s;
        ph += phaseStep;
        if (ph >= 1) ph -= 1;
      }
      this.polyR[v].set(L);
      this.phases[v] = ph;
    }
    this.outR.set(this.outL);
  }
}

/**
 * Wavetable oscillator component (ported from the Synth's wavetable mode).
 * Per-voice phase like OscModule; Position (wtPos param + posMod control)
 * scans across the loaded table's frames. FM audio input phase-modulates.
 */
class WtoscModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'wtosc';
    this.params = params;
    this.controlIn = {};
    this.polyIn = { fm: makePolyIn() };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    this.polyL = [];
    this.polyR = [];
    this.polyLanes = 0;
    this.phases = new Float64Array(MAX_VOICES);
    this.wavetable = null;
  }

  /** Loadable wavetable: PCM split into 2048-sample frames (mirrors Synth). */
  setWavetable(channels) {
    const pcm = channels[0];
    if (!pcm || pcm.length === 0) return;
    if (pcm.length >= WT_FRAME) {
      const frames = Math.max(1, Math.floor(pcm.length / WT_FRAME));
      this.wavetable = { data: pcm.subarray(0, frames * WT_FRAME), frames };
    } else {
      const data = new Float32Array(WT_FRAME);
      for (let i = 0; i < WT_FRAME; i++) {
        const pos = (i / WT_FRAME) * pcm.length;
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        data[i] = pcm[i0] * (1 - frac) + pcm[(i0 + 1) % pcm.length] * frac;
      }
      this.wavetable = { data, frames: 1 };
    }
  }

  defaultWavetable() {
    const frames = 4;
    const data = new Float32Array(frames * WT_FRAME);
    for (let i = 0; i < WT_FRAME; i++) {
      const ph = i / WT_FRAME;
      data[i] = Math.sin(2 * Math.PI * ph);
      data[WT_FRAME + i] = 4 * Math.abs(ph - 0.5) - 1;
      data[2 * WT_FRAME + i] = 2 * ph - 1;
      data[3 * WT_FRAME + i] = ph < 0.5 ? 1 : -1;
    }
    this.wavetable = { data, frames };
    return this.wavetable;
  }

  render(blockSize) {
    const p = this.params;
    const offs = Math.round(p.octave ?? 0) * 12 + Math.round(p.semi ?? 0) + (p.fine ?? 0) / 100;
    const fmAmt = p.fmAmt ?? 0;
    const level = p.level ?? 0.8;
    const wtPos = p.wtPos ?? 0;
    const wt = this.wavetable || this.defaultWavetable();

    const pitchIn = this.controlIn.pitch;
    const posModIn = this.controlIn.posMod;
    const lanes = Math.min(MAX_VOICES, cwidth(pitchIn));
    this.polyLanes = lanes;
    const n = Math.max(1, lanes);
    ensureLanes(this, n);
    this.outL.fill(0);

    const fm = this.polyIn.fm;
    for (let v = 0; v < n; v++) {
      const base = lanes > 0 ? pitchIn[v] * 127 : pitchIn !== undefined ? pitchIn * 127 : 60;
      const freq = 440 * Math.pow(2, (base + offs - 69) / 12);
      const phaseStep = freq / sampleRate;
      const pm = cval(posModIn, v);
      const framePos = Math.min(1, Math.max(0, wtPos + (pm !== undefined ? pm : 0))) * (wt.frames - 1);
      const f0 = Math.floor(framePos);
      const f1 = Math.min(wt.frames - 1, f0 + 1);
      const fFrac = framePos - f0;
      const fmBuf = fm.lanes > 0 ? fm.L[Math.min(v, fm.lanes - 1)] : SILENT_BLOCK;
      const L = this.polyL[v];
      let ph = this.phases[v];
      for (let i = 0; i < blockSize; i++) {
        let pp = ph;
        if (fmAmt > 0) {
          pp += fmAmt * fmBuf[i];
          pp -= Math.floor(pp);
        }
        const idx = pp * WT_FRAME;
        const i0 = Math.floor(idx);
        const i1 = (i0 + 1) % WT_FRAME;
        const frac = idx - i0;
        const a = wt.data[f0 * WT_FRAME + i0] * (1 - frac) + wt.data[f0 * WT_FRAME + i1] * frac;
        const b = wt.data[f1 * WT_FRAME + i0] * (1 - frac) + wt.data[f1 * WT_FRAME + i1] * frac;
        const s = (a * (1 - fFrac) + b * fFrac) * level;
        L[i] = s;
        this.outL[i] += s;
        ph += phaseStep;
        if (ph >= 1) ph -= 1;
      }
      this.polyR[v].set(L);
      this.phases[v] = ph;
    }
    this.outR.set(this.outL);
  }
}

/** Multimode filter component: Chamberlin SVF per voice lane (mirrors the Synth's). */
class VcfModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'vcf';
    this.params = params;
    this.controlIn = {};
    this.polyIn = { in: makePolyIn() };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    this.polyL = [];
    this.polyR = [];
    this.polyLanes = 0;
    this.state = [];
    for (let i = 0; i < MAX_VOICES; i++) this.state.push({ lpL: 0, bpL: 0, lpR: 0, bpR: 0 });
  }

  render(blockSize) {
    const p = this.params;
    const mode = Math.round(p.mode ?? 0); // lowpass | highpass | bandpass | notch
    const cutoff = p.cutoff ?? 1200;
    const amt = p.amt ?? 0;
    const damp = 2 * (1 - Math.min(0.95, p.res ?? 0.2));
    const modIn = this.controlIn.mod;

    const pin = this.polyIn.in;
    this.polyLanes = pin.lanes;
    const n = Math.max(1, pin.lanes);
    ensureLanes(this, n);
    this.outL.fill(0);
    this.outR.fill(0);

    // Double-sampled SVF raises the stable cutoff ceiling; the clamp keeps
    // f² + 2·damp·f < 4 (discrete SVF stability bound) with margin.
    const fMax = -damp + Math.sqrt(damp * damp + 3.6);

    for (let v = 0; v < n; v++) {
      const srcL = pin.lanes > 0 ? pin.L[v] : SILENT_BLOCK;
      const srcR = pin.lanes > 0 ? pin.R[v] : SILENT_BLOCK;
      const m = cval(modIn, v);
      const cutEff = Math.min(18000, Math.max(20, cutoff * (m !== undefined ? Math.pow(2, m * amt) : 1)));
      const f = Math.min(fMax, 2 * Math.sin((Math.PI * cutEff) / (2 * sampleRate)));
      const st = this.state[v];
      const L = this.polyL[v];
      const R = this.polyR[v];
      for (let i = 0; i < blockSize; i++) {
        let hpL = 0;
        let hpR = 0;
        for (let k = 0; k < 2; k++) {
          st.lpL += f * st.bpL;
          hpL = srcL[i] - st.lpL - damp * st.bpL;
          st.bpL += f * hpL;
          st.lpR += f * st.bpR;
          hpR = srcR[i] - st.lpR - damp * st.bpR;
          st.bpR += f * hpR;
        }
        L[i] = mode === 0 ? st.lpL : mode === 1 ? hpL : mode === 2 ? st.bpL : hpL + st.lpL;
        R[i] = mode === 0 ? st.lpR : mode === 1 ? hpR : mode === 2 ? st.bpR : hpR + st.lpR;
        this.outL[i] += L[i];
        this.outR[i] += R[i];
      }
    }
  }
}

/** VCA component: audio × CV × level, per voice lane. */
class VcaModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'vca';
    this.params = params;
    this.controlIn = {};
    this.polyIn = { in: makePolyIn() };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    this.polyL = [];
    this.polyR = [];
    this.polyLanes = 0;
  }

  render(blockSize) {
    const level = this.params.level ?? 1;
    const cvIn = this.controlIn.cv;
    const pin = this.polyIn.in;
    this.polyLanes = pin.lanes;
    const n = Math.max(1, pin.lanes);
    ensureLanes(this, n);
    this.outL.fill(0);
    this.outR.fill(0);

    for (let v = 0; v < n; v++) {
      const srcL = pin.lanes > 0 ? pin.L[v] : SILENT_BLOCK;
      const srcR = pin.lanes > 0 ? pin.R[v] : SILENT_BLOCK;
      const cv = cval(cvIn, v);
      const g = level * (cv !== undefined ? Math.min(1, Math.max(0, cv)) : 1);
      const L = this.polyL[v];
      const R = this.polyR[v];
      for (let i = 0; i < blockSize; i++) {
        L[i] = srcL[i] * g;
        R[i] = srcR[i] * g;
        this.outL[i] += L[i];
        this.outR[i] += R[i];
      }
    }
  }
}

/** Knob / Slider / Button (PRD §8.6): the UI writes the 'value' param; emit it. */
class ControlSourceModule {
  constructor(id, params, type) {
    this.id = id;
    this.type = type;
    this.params = params;
    this.value = 0;
  }

  render() {
    this.value = Math.min(1, Math.max(0, this.params.value ?? 0));
  }
}

/** XY pad (PRD §8.6): two control outputs from one puck. */
class XyModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'xy';
    this.params = params;
    this.controlOut = { x: 0.5, y: 0.5 };
    this.value = 0.5;
  }

  render() {
    this.controlOut.x = Math.min(1, Math.max(0, this.params.x ?? 0.5));
    this.controlOut.y = Math.min(1, Math.max(0, this.params.y ?? 0.5));
    this.value = this.controlOut.x;
  }
}

/** Scale tables — keep in sync with src/core/scales.ts (same pattern as eqmath). */
const QUANT_SCALES = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  [0, 2, 4, 5, 7, 9, 11],
  [0, 2, 3, 5, 7, 8, 10],
  [0, 2, 4, 7, 9],
  [0, 3, 5, 7, 10],
  [0, 3, 5, 6, 7, 10],
  [0, 2, 3, 5, 7, 9, 10],
  [0, 2, 4, 5, 7, 9, 10],
];

function quantizePitch(midi, scaleIdx, root) {
  const table = QUANT_SCALES[scaleIdx] || QUANT_SCALES[0];
  const rounded = Math.round(midi);
  let best = rounded;
  let bestDist = Infinity;
  for (let off = -11; off <= 11; off++) {
    const cand = rounded + off;
    if (cand < 0 || cand > 127) continue;
    const pc = (((cand - root) % 12) + 12) % 12;
    if (!table.includes(pc)) continue;
    const dist = Math.abs(midi - cand);
    if (dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) < 1e-9 && cand < best)) {
      best = cand;
      bestDist = dist;
    }
  }
  return best;
}

/** Snaps a pitch control (MIDI/127) to the nearest scale note, per lane. */
class QuantizerModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'quantizer';
    this.params = params;
    this.controlIn = {};
    this.controlOut = { out: 60 / 127 };
    this.value = 60 / 127;
    this.buf = null;
  }

  render() {
    const scale = Math.round(this.params.scale ?? 1);
    const root = Math.round(this.params.root ?? 0);
    const inV = this.controlIn.in;
    const width = cwidth(inV);
    if (width > 0) {
      if (!this.buf || this.buf.length !== width) this.buf = new Float32Array(width);
      for (let v = 0; v < width; v++) this.buf[v] = quantizePitch(inV[v] * 127, scale, root) / 127;
      this.controlOut.out = this.buf;
      this.value = this.buf[0];
    } else {
      const x = inV !== undefined ? inV : 60 / 127;
      this.value = quantizePitch(x * 127, scale, root) / 127;
      this.controlOut.out = this.value;
    }
  }
}

/** Sample & Hold: captures the input on each rising trig edge (>0.5), per lane. */
class SahModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'sah';
    this.params = params;
    this.controlIn = {};
    this.held = new Float32Array(MAX_VOICES);
    this.prev = new Float32Array(MAX_VOICES);
    this.controlOut = { out: 0 };
    this.value = 0;
    this.buf = null;
  }

  render() {
    const inV = this.controlIn.in;
    const trig = this.controlIn.trig;
    const width = Math.max(cwidth(inV), cwidth(trig));
    const n = Math.max(1, width);
    for (let v = 0; v < n; v++) {
      const t = cval(trig, v) ?? 0;
      if (t > 0.5 && this.prev[v] <= 0.5) {
        const x = cval(inV, v);
        if (x !== undefined) this.held[v] = Math.min(1, Math.max(0, x));
      }
      this.prev[v] = t;
    }
    if (width > 0) {
      if (!this.buf || this.buf.length !== width) this.buf = new Float32Array(width);
      this.buf.set(this.held.subarray(0, width));
      this.controlOut.out = this.buf;
    } else {
      this.controlOut.out = this.held[0];
    }
    this.value = this.held[0];
  }
}

/** Slew limiter: full 0–1 range takes Rise/Fall seconds, per lane. */
class SlewModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'slew';
    this.params = params;
    this.controlIn = {};
    this.cur = new Float32Array(MAX_VOICES);
    this.controlOut = { out: 0 };
    this.value = 0;
    this.buf = null;
  }

  render(blockSize) {
    const dt = blockSize / sampleRate;
    const rise = this.params.rise ?? 0.1;
    const fall = this.params.fall ?? 0.1;
    const up = rise > 0.001 ? dt / rise : 2; // >1 = effectively instant
    const down = fall > 0.001 ? dt / fall : 2;
    const inV = this.controlIn.in;
    const width = cwidth(inV);
    const n = Math.max(1, width);
    for (let v = 0; v < n; v++) {
      const target = cval(inV, v);
      if (target === undefined) continue;
      const d = target - this.cur[v];
      this.cur[v] += Math.max(-down, Math.min(up, d));
    }
    if (width > 0) {
      if (!this.buf || this.buf.length !== width) this.buf = new Float32Array(width);
      this.buf.set(this.cur.subarray(0, width));
      this.controlOut.out = this.buf;
    } else {
      this.controlOut.out = this.cur[0];
    }
    this.value = this.cur[0];
  }
}

/** Control math: attenuvert A and B, combine, offset, clamp — per lane. */
class CmathModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'cmath';
    this.params = params;
    this.controlIn = {};
    this.controlOut = { out: 0 };
    this.value = 0;
    this.buf = null;
  }

  render() {
    const p = this.params;
    const mode = Math.round(p.mode ?? 0); // a+b | a×b | min | max
    const gA = p.gainA ?? 1;
    const gB = p.gainB ?? 1;
    const off = p.offset ?? 0;
    const a = this.controlIn.a;
    const b = this.controlIn.b;
    const width = Math.max(cwidth(a), cwidth(b));
    const n = Math.max(1, width);
    if (width > 0 && (!this.buf || this.buf.length !== width)) this.buf = new Float32Array(width);
    for (let v = 0; v < n; v++) {
      const av = (cval(a, v) ?? 0) * gA;
      const bv = (cval(b, v) ?? 0) * gB;
      const y = mode === 0 ? av + bv : mode === 1 ? av * bv : mode === 2 ? Math.min(av, bv) : Math.max(av, bv);
      const clamped = Math.min(1, Math.max(0, y + off));
      if (width > 0) this.buf[v] = clamped;
      else this.value = clamped;
    }
    this.controlOut.out = width > 0 ? this.buf : this.value;
    if (width > 0) this.value = this.buf[0];
  }
}

/** 4×4 modulation matrix: out_j = clamp01(Σ_i m_ij × in_i), per lane. */
class ModMatrixModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'modmatrix';
    this.params = params;
    this.controlIn = {};
    this.controlOut = { out1: 0, out2: 0, out3: 0, out4: 0 };
    this.value = 0;
    this.bufs = [null, null, null, null];
  }

  render() {
    const ins = [this.controlIn.in1, this.controlIn.in2, this.controlIn.in3, this.controlIn.in4];
    let width = 0;
    for (const v of ins) width = Math.max(width, cwidth(v));
    const n = Math.max(1, width);
    for (let j = 1; j <= 4; j++) {
      let buf = this.bufs[j - 1];
      if (width > 0 && (!buf || buf.length !== width)) buf = this.bufs[j - 1] = new Float32Array(width);
      let scalar = 0;
      for (let v = 0; v < n; v++) {
        let y = 0;
        for (let i = 1; i <= 4; i++) {
          const amt = this.params[`m${i}${j}`] ?? 0;
          if (amt === 0) continue;
          y += amt * (cval(ins[i - 1], v) ?? 0);
        }
        const clamped = Math.min(1, Math.max(0, y));
        if (width > 0) buf[v] = clamped;
        else scalar = clamped;
      }
      this.controlOut[`out${j}`] = width > 0 ? buf : scalar;
    }
    const o1 = this.controlOut.out1;
    this.value = typeof o1 === 'number' ? o1 : o1[0];
  }
}

const RANDOM_WALK = 0;
const RANDOM_SH = 1;

class RandomModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'random';
    this.params = params;
    this.phase = 0;
    this.current = Math.random();
    this.target = Math.random();
    this.value = 0.5;
  }

  render(blockSize) {
    const p = this.params;
    const mode = Math.round(p.mode ?? RANDOM_WALK);
    const rate = p.rate ?? 1;
    const depth = p.depth ?? 0.5;
    const offset = p.offset ?? 0.5;

    this.phase += (rate * blockSize) / sampleRate;
    if (this.phase >= 1) {
      this.phase -= Math.floor(this.phase);
      this.current = mode === RANDOM_SH ? this.target : this.current;
      this.target = Math.random();
    }
    const raw = mode === RANDOM_WALK
      ? this.current + (this.target - this.current) * this.phase // glide between targets
      : this.target; // stepped
    if (mode === RANDOM_WALK && this.phase >= 0.999) this.current = this.target;
    this.value = Math.min(1, Math.max(0, offset + (raw - 0.5) * depth));
  }
}

class RecorderModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'recorder';
    this.params = params;
    this.inputs = { in: makeStereoBuf() };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    this.recording = false;
    this.chunksL = [];
    this.chunksR = [];
    this.pendingSamples = 0;
  }

  render(blockSize) {
    for (let i = 0; i < blockSize; i++) {
      this.outL[i] = this.inputs.in.L[i];
      this.outR[i] = this.inputs.in.R[i];
    }
    if (this.recording) {
      this.chunksL.push(this.outL.slice(0, blockSize));
      this.chunksR.push(this.outR.slice(0, blockSize));
      this.pendingSamples += blockSize;
    }
  }

  /** Concatenate pending chunks for transfer to the main thread. */
  drain() {
    if (this.pendingSamples === 0) return null;
    const chL = new Float32Array(this.pendingSamples);
    const chR = new Float32Array(this.pendingSamples);
    let offset = 0;
    for (let i = 0; i < this.chunksL.length; i++) {
      chL.set(this.chunksL[i], offset);
      chR.set(this.chunksR[i], offset);
      offset += this.chunksL[i].length;
    }
    this.chunksL = [];
    this.chunksR = [];
    this.pendingSamples = 0;
    return { chL, chR };
  }
}

class SequencerModule {
  constructor(id, params, data) {
    this.id = id;
    this.type = 'sequencer';
    this.params = params;
    this.data = data || { steps: [] };
    this.lastStepIndex = -1;
    this.currentStep = 0;
    /** Active notes: { voiceId, offAtSample } — noteOffs are time-scheduled. */
    this.activeNotes = [];
  }

  stepsPerBeat() {
    const division = Math.round(this.params.division ?? 2);
    return [1, 2, 4][division] ?? 4;
  }

  /** Called when the transport stops: release everything. */
  allNotesOff(emitOff) {
    for (const n of this.activeNotes) emitOff(this.id, n.voiceId);
    this.activeNotes = [];
    this.lastStepIndex = -1;
  }
}

/**
 * Arpeggiator (PRD §8.3): collects held notes, emits a stepped stream.
 * Locks to the transport while playing; free-runs at the master tempo
 * when stopped so keyboard players hear it immediately.
 */
/** Note relay: re-emits incoming notes to its own out wires (host fan-out). */
class NotethruModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'notethru';
    this.params = params;
  }

  noteOn(voiceId, pitch, velocity, extras) {
    if (this.host) this.host.routeNoteOn(this.id, voiceId, pitch, velocity, undefined, extras);
  }

  noteOff(voiceId, release) {
    if (this.host) this.host.routeNoteOff(this.id, voiceId, release);
  }
}

class ArpModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'arp';
    this.params = params;
    this.held = []; // { voiceId, pitch } in press order
    this.physHeld = 0; // physically-down count (latch bookkeeping)
    this.lastStepIndex = -1;
    this.freeBeats = 0;
    this.upDownDir = 1;
    this.activeNotes = []; // { voiceId, offAtSample }
  }

  latchOn() {
    return Math.round(this.params.latch ?? 0) === 1;
  }

  noteOn(voiceId, pitch) {
    // Latch: first press after a full release starts a new chord.
    if (this.latchOn() && this.physHeld === 0 && this.held.length > 0) this.held = [];
    this.held.push({ voiceId, pitch });
    this.physHeld++;
  }

  noteOff(voiceId) {
    this.physHeld = Math.max(0, this.physHeld - 1);
    if (!this.latchOn()) this.held = this.held.filter((h) => h.voiceId !== voiceId);
  }

  stepsPerBeat() {
    const division = Math.round(this.params.division ?? 2);
    return [1, 2, 4, 8][division] || 4;
  }

  /** Expanded, ordered pitch sequence for the current chord. */
  sequence() {
    if (this.held.length === 0) return [];
    const octaves = Math.max(1, Math.round(this.params.octaves ?? 1));
    const base = this.held.map((h) => h.pitch);
    const expanded = [];
    for (let o = 0; o < octaves; o++) for (const p of base) expanded.push(p + o * 12);
    const mode = Math.round(this.params.mode ?? 0);
    if (mode === 0) expanded.sort((a, b) => a - b); // up
    else if (mode === 1) expanded.sort((a, b) => b - a); // down
    else if (mode === 2) {
      // up-down: ascend then descend without repeating the endpoints
      expanded.sort((a, b) => a - b);
      const down = expanded.slice(1, -1).reverse();
      return expanded.concat(down);
    }
    // 3 random: order irrelevant (picked at step time); 4 as-played: press order
    return expanded;
  }

  allNotesOff(emitOff) {
    for (const n of this.activeNotes) emitOff(this.id, n.voiceId);
    this.activeNotes = [];
    this.lastStepIndex = -1;
  }

  /** Hard kill (stop ×2): also drop the held/latched chord so the free-running
   * clock stops emitting new steps. */
  panic() {
    this.held = [];
    this.physHeld = 0;
  }
}

/**
 * Composer (PRD §8.3, piano roll): one clip of free-time notes
 * ({ start, length } in beats, per-note vel/prob) looped over data.length
 * beats against the transport. Notes fire when their start crosses the
 * current block's beat window.
 */
class ComposerModule {
  constructor(id, params, data) {
    this.id = id;
    this.type = 'composer';
    this.params = params;
    this.data = data || { notes: [], length: 16 };
    this.activeNotes = []; // { voiceId, offAtSample }
  }

  allNotesOff(emitOff) {
    for (const n of this.activeNotes) emitOff(this.id, n.voiceId);
    this.activeNotes = [];
  }
}

/** Control source driven from the main thread (MIDI In CC). */
class MidiInModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'midiIn';
    this.params = params;
    this.value = 0; // read by control wires; set via 'control' messages
  }
}

/** Collects note/CC events for the main thread to send to a MIDI port. */
class MidiOutModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'midiOut';
    this.params = params;
    this.controlIn = {};
    this.pending = [];
    this.lastCc = -1;
  }

  noteOn(voiceId, pitch, velocity) {
    if (!this.held) this.held = new Map();
    this.held.set(voiceId, Math.round(pitch));
    this.pending.push({ moduleId: this.id, kind: 'on', pitch: Math.round(pitch), velocity });
  }

  noteOff(voiceId) {
    const pitch = this.held && this.held.get(voiceId);
    if (pitch === undefined) return;
    this.held.delete(voiceId);
    this.pending.push({ moduleId: this.id, kind: 'off', pitch });
  }

  /** Per block: emit a CC event when the control input moved a step. */
  collectCc() {
    const v = this.controlIn.cc;
    if (v === undefined) return;
    const cc = Math.round(Math.min(1, Math.max(0, v)) * 127);
    if (cc !== this.lastCc) {
      this.lastCc = cc;
      this.pending.push({ moduleId: this.id, kind: 'cc', value: cc });
    }
  }
}

/**
 * Modules with audio inputs declare `this.inputs = { portId: {L, R} }`;
 * the host zeroes and sums incoming wires into them before render().
 */
function makeStereoBuf() {
  return { L: new Float32Array(128), R: new Float32Array(128) };
}

/**
 * Audio/note sink feeding the main-thread visual engine (VISUALIZER_ENGINE_PLAN.md).
 * Ships raw audio only — analysis (FFT/bands) runs UI-side. With a SAB ring
 * attached, audio streams gaplessly through shared memory and status posts
 * carry just notes/ctrl/onset; without one, status falls back to raw
 * 1024-sample windows. Layout must mirror src/visual/ring.ts exactly.
 */
const VIS_RING_CAP = 16384;
const VIS_RING_HEADER = 16;

class VisualizerModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'visualizer';
    this.params = params;
    this.inputs = { in: makeStereoBuf() };
    this.controlIn = {};
    this.capL = new Float32Array(FFT_N);
    this.capR = new Float32Array(FFT_N);
    this.capIdx = 0;
    this.recentNotes = [];
    this.ring = null;
    this.prevRms = 0;
    this.onsetAcc = 0;
  }

  attachRing(sab) {
    this.ring = {
      head: new Int32Array(sab, 0, 1),
      chL: new Float32Array(sab, VIS_RING_HEADER, VIS_RING_CAP),
      chR: new Float32Array(sab, VIS_RING_HEADER + VIS_RING_CAP * 4, VIS_RING_CAP),
      written: 0,
    };
  }

  noteOn(voiceId, pitch) {
    if (this.recentNotes.length < 32) this.recentNotes.push(pitch);
  }

  noteOff() {}

  render(blockSize) {
    const L = this.inputs.in.L;
    const R = this.inputs.in.R;
    let sumSq = 0;
    for (let i = 0; i < blockSize; i++) {
      this.capL[this.capIdx] = L[i];
      this.capR[this.capIdx] = R[i];
      this.capIdx = (this.capIdx + 1) % FFT_N;
      const m = (L[i] + R[i]) * 0.5;
      sumSq += m * m;
    }
    if (this.ring) {
      const r = this.ring;
      let w = r.written % VIS_RING_CAP;
      for (let i = 0; i < blockSize; i++) {
        r.chL[w] = L[i];
        r.chR[w] = R[i];
        w = (w + 1) % VIS_RING_CAP;
      }
      r.written += blockSize;
      // Keep the counter far from Int32 overflow; multiples of the capacity
      // preserve the ring position readers derive from it.
      if (r.written >= 1 << 30) r.written -= 1 << 30;
      Atomics.store(r.head, 0, r.written);
    }
    // Onset = positive block-energy flux; gapless here, unlike UI-side frames.
    const rms = Math.sqrt(sumSq / blockSize);
    const flux = rms - this.prevRms;
    if (flux > 0.03 && rms > 0.02) this.onsetAcc = Math.max(this.onsetAcc, Math.min(1, flux * 8));
    this.prevRms = rms;
  }

  /** Posted with each status message; drains the note + onset accumulators. */
  visData() {
    const notes = this.recentNotes;
    this.recentNotes = [];
    const onset = this.onsetAcc;
    this.onsetAcc = 0;
    const base = {
      notes,
      ctrl: this.controlIn.mod !== undefined ? this.controlIn.mod : -1,
      onset,
    };
    if (this.ring) return base;
    const waveL = new Array(FFT_N);
    const waveR = new Array(FFT_N);
    for (let i = 0; i < FFT_N; i++) {
      const idx = (this.capIdx + i) % FFT_N;
      waveL[i] = this.capL[idx];
      waveR[i] = this.capR[idx];
    }
    return { ...base, waveL, waveR };
  }
}

/** Note sink for the Note Names text producer — collects pitches for the status stream. */
class NotenamesModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'notenames';
    this.params = params;
    this.recentNotes = [];
  }

  noteOn(voiceId, pitch) {
    if (this.recentNotes.length < 16) this.recentNotes.push(pitch);
  }

  noteOff() {}

  /** Drained with each status post. */
  drainNotes() {
    const notes = this.recentNotes;
    this.recentNotes = [];
    return notes;
  }
}

class LevelsModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'levels';
    this.params = params;
    this.inputs = { in: makeStereoBuf() };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
  }

  render(blockSize) {
    // Metering only: pass input through to out buffers so meters read it.
    for (let i = 0; i < blockSize; i++) {
      this.outL[i] = this.inputs.in.L[i];
      this.outR[i] = this.inputs.in.R[i];
    }
  }
}

class AudioOutModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'audioOut';
    this.params = params;
    this.inputs = { in: makeStereoBuf() };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    this.limiterEnv = 0;
  }

  render(blockSize) {
    const level = this.params.level ?? 0.8;
    const limiterOn = (this.params.limiter ?? 1) >= 0.5;
    const releaseCoef = Math.exp(-1 / (0.08 * sampleRate)); // ~80 ms release
    for (let i = 0; i < blockSize; i++) {
      let l = this.inputs.in.L[i] * level;
      let r = this.inputs.in.R[i] * level;
      if (limiterOn) {
        const peak = Math.max(Math.abs(l), Math.abs(r));
        this.limiterEnv = Math.max(peak, this.limiterEnv * releaseCoef);
        if (this.limiterEnv > LIMITER_CEILING) {
          const gain = LIMITER_CEILING / this.limiterEnv;
          l *= gain;
          r *= gain;
        }
      }
      this.outL[i] = l;
      this.outR[i] = r;
    }
  }
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/** Beats per echo for each sync option (index 1+; 0 = free ms time). */
const DELAY_SYNC_BEATS = [0, 0.25, 0.5, 0.75, 1, 1.5, 2];

class DelayModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'delay';
    this.params = params;
    this.inputs = { in: makeStereoBuf() };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    const max = Math.ceil(2.5 * sampleRate);
    this.bufL = new Float32Array(max);
    this.bufR = new Float32Array(max);
    this.writeIdx = 0;
    this.curTime = ((params.time ?? 350) / 1000) * sampleRate;
    this.tempo = 120; // injected by the host each block
    this.toneL = 0;
    this.toneR = 0;
  }

  panic() {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.toneL = 0;
    this.toneR = 0;
  }

  render(blockSize) {
    const len = this.bufL.length;
    const sync = Math.round(this.params.sync ?? 0);
    const timeS = sync > 0
      ? DELAY_SYNC_BEATS[sync] * (60 / this.tempo)
      : (this.params.time ?? 350) / 1000;
    const target = Math.min(len - 2, Math.max(1, timeS * sampleRate));
    const fb = this.params.feedback ?? 0.4;
    const mix = this.params.mix ?? 0.35;
    const pingpong = (this.params.pingpong ?? 0) >= 0.5;
    // One-pole lowpass in the feedback path (PRD §8.4 "filter in feedback").
    const tone = this.params.tone ?? 16000;
    const k = 1 - Math.exp((-2 * Math.PI * tone) / sampleRate);

    for (let i = 0; i < blockSize; i++) {
      this.curTime += (target - this.curTime) * 0.0005; // slew to avoid clicks
      let readPos = this.writeIdx - this.curTime;
      if (readPos < 0) readPos += len;
      const i0 = Math.floor(readPos);
      const frac = readPos - i0;
      const i1 = (i0 + 1) % len;
      const dL = this.bufL[i0] * (1 - frac) + this.bufL[i1] * frac;
      const dR = this.bufR[i0] * (1 - frac) + this.bufR[i1] * frac;
      this.toneL += (dL - this.toneL) * k;
      this.toneR += (dR - this.toneR) * k;
      const inL = this.inputs.in.L[i];
      const inR = this.inputs.in.R[i];
      if (pingpong) {
        // Mono input feeds the left line; echoes bounce L→R→L.
        const mono = (inL + inR) * 0.5;
        this.bufL[this.writeIdx] = mono + this.toneR * fb;
        this.bufR[this.writeIdx] = this.toneL * fb;
      } else {
        this.bufL[this.writeIdx] = inL + this.toneL * fb;
        this.bufR[this.writeIdx] = inR + this.toneR * fb;
      }
      this.outL[i] = inL * (1 - mix) + dL * mix;
      this.outR[i] = inR * (1 - mix) + dR * mix;
      this.writeIdx = (this.writeIdx + 1) % len;
    }
  }
}

class Comb {
  constructor(size) {
    this.buf = new Float32Array(size);
    this.idx = 0;
    this.store = 0;
  }
  process(x, feedback, damp) {
    const y = this.buf[this.idx];
    this.store = y * (1 - damp) + this.store * damp;
    this.buf[this.idx] = x + this.store * feedback;
    this.idx = (this.idx + 1) % this.buf.length;
    return y;
  }
  clear() {
    this.buf.fill(0);
    this.store = 0;
  }
}

class Allpass {
  constructor(size) {
    this.buf = new Float32Array(size);
    this.idx = 0;
  }
  clear() {
    this.buf.fill(0);
  }
  process(x, g) {
    const y = this.buf[this.idx];
    this.buf[this.idx] = x + y * g;
    this.idx = (this.idx + 1) % this.buf.length;
    return y - x;
  }
}

const COMB_TUNINGS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNINGS = [556, 441, 341, 225];
const STEREO_SPREAD = 23;
/** Comb-length scale per algorithm: room / hall / plate. */
const REVERB_ALGO_SCALE = [0.8, 1.5, 0.55];

class ReverbModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'reverb';
    this.params = params;
    this.inputs = { in: makeStereoBuf() };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    this.tuningKey = '';
    this.rebuild(1);
    this.predelayBuf = new Float32Array(Math.ceil(0.25 * sampleRate));
    this.pdIdx = 0;
    this.hpL = 0; this.hpR = 0; // wet low-cut state
    this.lpL = 0; this.lpR = 0; // wet high-cut state
  }

  panic() {
    for (const c of this.combsL) c.clear();
    for (const c of this.combsR) c.clear();
    for (const a of this.allpassL) a.clear();
    for (const a of this.allpassR) a.clear();
    this.predelayBuf.fill(0);
    this.hpL = this.hpR = this.lpL = this.lpR = 0;
  }

  rebuild(scale) {
    const srScale = (sampleRate / 44100) * scale;
    const sz = (n) => Math.max(8, Math.round(n * srScale));
    this.combsL = COMB_TUNINGS.map((n) => new Comb(sz(n)));
    this.combsR = COMB_TUNINGS.map((n) => new Comb(sz(n + STEREO_SPREAD)));
    this.allpassL = ALLPASS_TUNINGS.map((n) => new Allpass(sz(n)));
    this.allpassR = ALLPASS_TUNINGS.map((n) => new Allpass(sz(n + STEREO_SPREAD)));
  }

  render(blockSize) {
    const p = this.params;
    const algo = Math.round(p.algo ?? 0);
    const size = p.size ?? 0.5;
    // Size + algorithm change the comb lengths; rebuild only when they move.
    const scale = (REVERB_ALGO_SCALE[algo] || 1) * (0.7 + size * 0.6);
    const key = scale.toFixed(3);
    if (key !== this.tuningKey) {
      this.tuningKey = key;
      this.rebuild(scale);
    }

    const feedback = 0.6 + (p.decay ?? 0.5) * 0.38;
    const damp = (p.damp ?? 0.5) * 0.4 * (algo === 2 ? 0.5 : 1); // plate stays bright
    const diffusion = 0.25 + (p.diffusion ?? 0.5) * 0.45;
    const mix = p.mix ?? 0.3;
    const pdSamples = Math.min(
      this.predelayBuf.length - 1,
      Math.round(((p.predelay ?? 0) / 1000) * sampleRate),
    );
    const kHp = 1 - Math.exp((-2 * Math.PI * (p.lowcut ?? 20)) / sampleRate);
    const kLp = 1 - Math.exp((-2 * Math.PI * (p.highcut ?? 16000)) / sampleRate);

    for (let i = 0; i < blockSize; i++) {
      const inL = this.inputs.in.L[i];
      const inR = this.inputs.in.R[i];
      // Pre-delay on the reverb input only (dry path stays immediate).
      this.predelayBuf[this.pdIdx] = (inL + inR) * 0.015;
      let readIdx = this.pdIdx - pdSamples;
      if (readIdx < 0) readIdx += this.predelayBuf.length;
      const input = this.predelayBuf[readIdx];
      this.pdIdx = (this.pdIdx + 1) % this.predelayBuf.length;

      let wetL = 0;
      let wetR = 0;
      for (const c of this.combsL) wetL += c.process(input, feedback, damp);
      for (const c of this.combsR) wetR += c.process(input, feedback, damp);
      for (const a of this.allpassL) wetL = a.process(wetL, diffusion);
      for (const a of this.allpassR) wetR = a.process(wetR, diffusion);

      // Wet-path low cut (one-pole HP) and high cut (one-pole LP).
      this.hpL += (wetL - this.hpL) * kHp;
      this.hpR += (wetR - this.hpR) * kHp;
      wetL -= this.hpL;
      wetR -= this.hpR;
      this.lpL += (wetL - this.lpL) * kLp;
      this.lpR += (wetR - this.lpR) * kLp;

      this.outL[i] = inL * (1 - mix) + this.lpL * mix * 3;
      this.outR[i] = inR * (1 - mix) + this.lpR * mix * 3;
    }
  }
}

const DIST_SOFT = 0;
const DIST_HARD = 1;
const DIST_TUBE = 2;
const DIST_FOLD = 3;

class DistortionModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'distortion';
    this.params = params;
    this.inputs = { in: makeStereoBuf() };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    this.toneL = 0;
    this.toneR = 0;
  }

  shape(x, algo, drive) {
    switch (algo) {
      case DIST_HARD: return Math.min(1, Math.max(-1, x * drive));
      case DIST_TUBE: return x < 0 ? Math.tanh(x * drive * 0.6) : Math.tanh(x * drive);
      case DIST_FOLD: {
        // Foldback: wrap the overdriven signal as a triangle wave.
        const f = x * drive * 0.25 + 0.25;
        return 4 * Math.abs(f - Math.floor(f + 0.5)) - 1;
      }
      case DIST_SOFT:
      default: return Math.tanh(x * drive);
    }
  }

  render(blockSize) {
    const algo = Math.round(this.params.algo ?? DIST_SOFT);
    const drive = this.params.drive ?? 6;
    const tone = this.params.tone ?? 5000;
    const trim = this.params.trim ?? 0.7;
    const mix = this.params.mix ?? 1;
    const k = 1 - Math.exp((-2 * Math.PI * tone) / sampleRate); // one-pole LP
    for (let i = 0; i < blockSize; i++) {
      const inL = this.inputs.in.L[i];
      const inR = this.inputs.in.R[i];
      this.toneL += (this.shape(inL, algo, drive) - this.toneL) * k;
      this.toneR += (this.shape(inR, algo, drive) - this.toneR) * k;
      this.outL[i] = (inL * (1 - mix) + this.toneL * mix) * trim;
      this.outR[i] = (inR * (1 - mix) + this.toneR * mix) * trim;
    }
  }
}

/** RBJ biquad, direct form II transposed. */
class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.z1 = 0; this.z2 = 0;
  }
  set(b0, b1, b2, a0, a1, a2) {
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  lowShelf(freq, dB) {
    const A = Math.pow(10, dB / 40);
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const cos = Math.cos(w0);
    const alpha = (Math.sin(w0) / 2) * Math.SQRT2;
    const sA = 2 * Math.sqrt(A) * alpha;
    this.set(
      A * (A + 1 - (A - 1) * cos + sA),
      2 * A * (A - 1 - (A + 1) * cos),
      A * (A + 1 - (A - 1) * cos - sA),
      A + 1 + (A - 1) * cos + sA,
      -2 * (A - 1 + (A + 1) * cos),
      A + 1 + (A - 1) * cos - sA,
    );
  }
  highShelf(freq, dB) {
    const A = Math.pow(10, dB / 40);
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const cos = Math.cos(w0);
    const alpha = (Math.sin(w0) / 2) * Math.SQRT2;
    const sA = 2 * Math.sqrt(A) * alpha;
    this.set(
      A * (A + 1 + (A - 1) * cos + sA),
      -2 * A * (A - 1 + (A + 1) * cos),
      A * (A + 1 + (A - 1) * cos - sA),
      A + 1 - (A - 1) * cos + sA,
      2 * (A - 1 - (A + 1) * cos),
      A + 1 - (A - 1) * cos - sA,
    );
  }
  peak(freq, dB, q) {
    const A = Math.pow(10, dB / 40);
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    this.set(1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A);
  }
  lowpass(freq, q) {
    const w0 = (2 * Math.PI * Math.min(freq, sampleRate * 0.49)) / sampleRate;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    this.set((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
  }
  highpass(freq, q) {
    const w0 = (2 * Math.PI * Math.min(freq, sampleRate * 0.49)) / sampleRate;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    this.set((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

class EqModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'eq';
    this.params = params;
    this.inputs = { in: makeStereoBuf() };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    this.bands = { L: [new Biquad(), new Biquad(), new Biquad()], R: [new Biquad(), new Biquad(), new Biquad()] };
    this.coefKey = '';
  }

  render(blockSize) {
    const p = this.params;
    const key = `${p.lowGain},${p.lowFreq},${p.midGain},${p.midFreq},${p.highGain},${p.highFreq}`;
    if (key !== this.coefKey) {
      this.coefKey = key;
      for (const ch of ['L', 'R']) {
        this.bands[ch][0].lowShelf(p.lowFreq ?? 120, p.lowGain ?? 0);
        this.bands[ch][1].peak(p.midFreq ?? 1000, p.midGain ?? 0, 0.7);
        this.bands[ch][2].highShelf(p.highFreq ?? 8000, p.highGain ?? 0);
      }
    }
    const [l0, l1, l2] = this.bands.L;
    const [r0, r1, r2] = this.bands.R;
    for (let i = 0; i < blockSize; i++) {
      this.outL[i] = l2.process(l1.process(l0.process(this.inputs.in.L[i])));
      this.outR[i] = r2.process(r1.process(r0.process(this.inputs.in.R[i])));
    }
  }
}

// -- FFT for the parametric EQ spectrum display ------------------------------

const FFT_N = 1024;
const FFT_BINS = 64;
const fftRe = new Float32Array(FFT_N);
const fftIm = new Float32Array(FFT_N);
const hannWin = new Float32Array(FFT_N);
for (let i = 0; i < FFT_N; i++) hannWin[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N);

function fftInPlace(re, im) {
  const n = re.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

/** 64 log-spaced (20 Hz – 20 kHz) magnitude bins in dB from a capture ring. */
function computeSpectrum(capture, capIdx) {
  for (let i = 0; i < FFT_N; i++) {
    fftRe[i] = capture[(capIdx + i) % FFT_N] * hannWin[i];
    fftIm[i] = 0;
  }
  fftInPlace(fftRe, fftIm);
  const out = new Array(FFT_BINS);
  const binHz = sampleRate / FFT_N;
  for (let b = 0; b < FFT_BINS; b++) {
    const fLo = 20 * Math.pow(10, (3 * b) / FFT_BINS);
    const fHi = 20 * Math.pow(10, (3 * (b + 1)) / FFT_BINS);
    const i0 = Math.max(1, Math.floor(fLo / binHz));
    const i1 = Math.min(FFT_N / 2 - 1, Math.max(i0, Math.ceil(fHi / binHz)));
    let peak = 0;
    for (let i = i0; i <= i1; i++) {
      const m = fftRe[i] * fftRe[i] + fftIm[i] * fftIm[i];
      if (m > peak) peak = m;
    }
    out[b] = 10 * Math.log10(peak / (FFT_N * FFT_N) + 1e-12) + 30; // rough display calibration
  }
  return out;
}

class PeqModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'peq';
    this.params = params;
    this.inputs = { in: makeStereoBuf() };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    this.bandsL = [];
    this.bandsR = [];
    for (let i = 0; i < 6; i++) {
      this.bandsL.push(new Biquad());
      this.bandsR.push(new Biquad());
    }
    this.coefKey = '';
    this.capture = new Float32Array(FFT_N);
    this.capIdx = 0;
  }

  applyBand(bq, type, freq, gain, q) {
    switch (type) {
      case 1: bq.lowShelf(freq, gain); break;
      case 2: bq.highShelf(freq, gain); break;
      case 3: bq.highpass(freq, q); break; // lo-cut
      case 4: bq.lowpass(freq, q); break; // hi-cut
      case 0:
      default: bq.peak(freq, gain, q); break;
    }
  }

  render(blockSize) {
    const p = this.params;
    let key = '';
    for (let n = 1; n <= 6; n++) key += `${p[`b${n}type`]},${p[`b${n}freq`]},${p[`b${n}gain`]},${p[`b${n}q`]};`;
    if (key !== this.coefKey) {
      this.coefKey = key;
      for (let i = 0; i < 6; i++) {
        const n = i + 1;
        const type = Math.round(p[`b${n}type`] ?? 0);
        const freq = p[`b${n}freq`] ?? 1000;
        const gain = p[`b${n}gain`] ?? 0;
        const q = p[`b${n}q`] ?? 0.9;
        this.applyBand(this.bandsL[i], type, freq, gain, q);
        this.applyBand(this.bandsR[i], type, freq, gain, q);
      }
    }

    for (let i = 0; i < blockSize; i++) {
      let l = this.inputs.in.L[i];
      let r = this.inputs.in.R[i];
      // Capture the input for the spectrum display before filtering.
      this.capture[this.capIdx] = (l + r) * 0.5;
      this.capIdx = (this.capIdx + 1) % FFT_N;
      for (let b = 0; b < 6; b++) {
        l = this.bandsL[b].process(l);
        r = this.bandsR[b].process(r);
      }
      this.outL[i] = l;
      this.outR[i] = r;
    }
  }

  spectrum() {
    return computeSpectrum(this.capture, this.capIdx);
  }
}

/** 3-band compressor over LR4 (cascaded butterworth) crossovers. */
class MultibandModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'mbcomp';
    this.params = params;
    this.inputs = { in: makeStereoBuf() };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    // Per channel: [loLP×2, restHP×2, midLP×2, hiHP×2]
    this.filters = { L: [], R: [] };
    for (let i = 0; i < 8; i++) {
      this.filters.L.push(new Biquad());
      this.filters.R.push(new Biquad());
    }
    this.coefKey = '';
    this.gr = [0, 0, 0];
    this.grDb = 0;
  }

  render(blockSize) {
    const p = this.params;
    const xLo = p.xLo ?? 200;
    const xHi = Math.max(xLo * 1.5, p.xHi ?? 2000);
    const key = `${xLo},${xHi}`;
    if (key !== this.coefKey) {
      this.coefKey = key;
      for (const ch of ['L', 'R']) {
        const f = this.filters[ch];
        f[0].lowpass(xLo, Math.SQRT1_2); f[1].lowpass(xLo, Math.SQRT1_2);
        f[2].highpass(xLo, Math.SQRT1_2); f[3].highpass(xLo, Math.SQRT1_2);
        f[4].lowpass(xHi, Math.SQRT1_2); f[5].lowpass(xHi, Math.SQRT1_2);
        f[6].highpass(xHi, Math.SQRT1_2); f[7].highpass(xHi, Math.SQRT1_2);
      }
    }

    const solos = [p.s1 ?? 0, p.s2 ?? 0, p.s3 ?? 0].map((s) => s >= 0.5);
    const anySolo = solos.some(Boolean);
    const bands = [1, 2, 3].map((n) => ({
      thr: p[`t${n}`] ?? -24,
      slope: 1 - 1 / Math.max(1, p[`r${n}`] ?? 3),
      aA: Math.exp(-1 / (Math.max(0.0001, (p[`a${n}`] ?? 10) / 1000) * sampleRate)),
      aR: Math.exp(-1 / (Math.max(0.001, (p[`rl${n}`] ?? 150) / 1000) * sampleRate)),
      makeup: Math.pow(10, (p[`g${n}`] ?? 0) / 20),
      muted: anySolo && !solos[n - 1],
    }));

    const fL = this.filters.L;
    const fR = this.filters.R;
    let blockGr = 0;

    for (let i = 0; i < blockSize; i++) {
      const inL = this.inputs.in.L[i];
      const inR = this.inputs.in.R[i];
      const loL = fL[1].process(fL[0].process(inL));
      const loR = fR[1].process(fR[0].process(inR));
      const restL = fL[3].process(fL[2].process(inL));
      const restR = fR[3].process(fR[2].process(inR));
      const midL = fL[5].process(fL[4].process(restL));
      const midR = fR[5].process(fR[4].process(restR));
      const hiL = fL[7].process(fL[6].process(restL));
      const hiR = fR[7].process(fR[6].process(restR));
      const sig = [[loL, loR], [midL, midR], [hiL, hiR]];

      let outL = 0;
      let outR = 0;
      for (let b = 0; b < 3; b++) {
        const band = bands[b];
        if (band.muted) continue;
        const level = Math.max(Math.abs(sig[b][0]), Math.abs(sig[b][1]));
        const db = 20 * Math.log10(level + DB_FLOOR);
        const target = Math.max(0, db - band.thr) * band.slope;
        this.gr[b] = target > this.gr[b]
          ? target + (this.gr[b] - target) * band.aA
          : target + (this.gr[b] - target) * band.aR;
        if (this.gr[b] > blockGr) blockGr = this.gr[b];
        const gain = Math.pow(10, -this.gr[b] / 20) * band.makeup;
        outL += sig[b][0] * gain;
        outR += sig[b][1] * gain;
      }
      this.outL[i] = outL;
      this.outR[i] = outR;
    }
    this.grDb = blockGr;
  }
}

class ChorusModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'chorus';
    this.params = params;
    this.inputs = { in: makeStereoBuf() };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    const size = Math.ceil(0.06 * sampleRate);
    this.bufL = new Float32Array(size);
    this.bufR = new Float32Array(size);
    this.wIdx = 0;
    this.phase = 0;
  }

  panic() {
    this.bufL.fill(0);
    this.bufR.fill(0);
  }

  render(blockSize) {
    const p = this.params;
    const rate = p.rate ?? 0.8;
    const depth = p.depth ?? 0.5;
    const voices = Math.min(3, Math.max(1, Math.round(p.voices ?? 2)));
    const width = p.width ?? 0.7;
    const mix = p.mix ?? 0.4;
    const len = this.bufL.length;
    const baseDelay = 0.018 * sampleRate;
    const modDepth = 0.008 * depth * sampleRate;
    const phaseStep = rate / sampleRate;

    for (let i = 0; i < blockSize; i++) {
      const inL = this.inputs.in.L[i];
      const inR = this.inputs.in.R[i];
      this.bufL[this.wIdx] = inL;
      this.bufR[this.wIdx] = inR;
      let wetL = 0;
      let wetR = 0;
      for (let v = 0; v < voices; v++) {
        const lfo = Math.sin(2 * Math.PI * (this.phase + v / voices));
        let readPos = this.wIdx - (baseDelay + modDepth * lfo);
        if (readPos < 0) readPos += len;
        const i0 = Math.floor(readPos);
        const frac = readPos - i0;
        const i1 = (i0 + 1) % len;
        const tapL = this.bufL[i0] * (1 - frac) + this.bufL[i1] * frac;
        const tapR = this.bufR[i0] * (1 - frac) + this.bufR[i1] * frac;
        // Spread voices across the stereo field by `width`.
        const pan = voices === 1 ? 0 : (v / (voices - 1) - 0.5) * 2 * width;
        const angle = ((pan + 1) * Math.PI) / 4;
        wetL += tapL * Math.cos(angle);
        wetR += tapR * Math.sin(angle);
      }
      const norm = 1 / Math.sqrt(voices);
      this.outL[i] = inL * (1 - mix) + wetL * norm * mix * 1.4;
      this.outR[i] = inR * (1 - mix) + wetR * norm * mix * 1.4;
      this.wIdx = (this.wIdx + 1) % len;
      this.phase += phaseStep;
      if (this.phase >= 1) this.phase -= 1;
    }
  }
}

class FlangerModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'flanger';
    this.params = params;
    this.inputs = { in: makeStereoBuf() };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    const size = Math.ceil(0.02 * sampleRate);
    this.bufL = new Float32Array(size);
    this.bufR = new Float32Array(size);
    this.wIdx = 0;
    this.phase = 0;
  }

  panic() {
    this.bufL.fill(0);
    this.bufR.fill(0);
  }

  render(blockSize) {
    const p = this.params;
    const rate = p.rate ?? 0.25;
    const depth = p.depth ?? 0.7;
    const fb = p.feedback ?? 0.5;
    const manualS = ((p.manual ?? 2) / 1000) * sampleRate;
    const mix = p.mix ?? 0.5;
    const len = this.bufL.length;
    const phaseStep = rate / sampleRate;

    for (let i = 0; i < blockSize; i++) {
      const lfo = 0.5 + 0.5 * Math.sin(2 * Math.PI * this.phase);
      const delay = Math.min(len - 2, Math.max(1, manualS * (0.15 + 0.85 * (1 - depth * lfo))));
      let readPos = this.wIdx - delay;
      if (readPos < 0) readPos += len;
      const i0 = Math.floor(readPos);
      const frac = readPos - i0;
      const i1 = (i0 + 1) % len;
      const tapL = this.bufL[i0] * (1 - frac) + this.bufL[i1] * frac;
      const tapR = this.bufR[i0] * (1 - frac) + this.bufR[i1] * frac;
      const inL = this.inputs.in.L[i];
      const inR = this.inputs.in.R[i];
      this.bufL[this.wIdx] = inL + tapL * fb;
      this.bufR[this.wIdx] = inR + tapR * fb;
      this.outL[i] = inL * (1 - mix) + tapL * mix;
      this.outR[i] = inR * (1 - mix) + tapR * mix;
      this.wIdx = (this.wIdx + 1) % len;
      this.phase += phaseStep;
      if (this.phase >= 1) this.phase -= 1;
    }
  }
}

class BitcrusherModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'bitcrusher';
    this.params = params;
    this.inputs = { in: makeStereoBuf() };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    this.holdL = 0;
    this.holdR = 0;
    this.count = 0;
  }

  render(blockSize) {
    const p = this.params;
    const bits = Math.max(1, Math.round(p.bits ?? 8));
    const down = Math.max(1, Math.round(p.down ?? 4));
    const mix = p.mix ?? 1;
    const steps = Math.pow(2, bits - 1);

    for (let i = 0; i < blockSize; i++) {
      const inL = this.inputs.in.L[i];
      const inR = this.inputs.in.R[i];
      if (++this.count >= down) {
        this.count = 0;
        this.holdL = Math.round(inL * steps) / steps;
        this.holdR = Math.round(inR * steps) / steps;
      }
      this.outL[i] = inL * (1 - mix) + this.holdL * mix;
      this.outR[i] = inR * (1 - mix) + this.holdR * mix;
    }
  }
}

const DB_FLOOR = 1e-6;

class CompressorModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'compressor';
    this.params = params;
    this.inputs = { in: makeStereoBuf(), sc: makeStereoBuf() };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    this.scWired = false; // set by the host on graph changes
    this.gr = 0; // smoothed gain reduction, dB
    this.grDb = 0; // block max for the UI meter
  }

  render(blockSize) {
    const p = this.params;
    const threshold = p.threshold ?? -24;
    const ratio = Math.max(1, p.ratio ?? 4);
    const knee = p.knee ?? 6;
    const makeup = Math.pow(10, (p.makeup ?? 0) / 20);
    const aA = Math.exp(-1 / (Math.max(0.0001, (p.attack ?? 10) / 1000) * sampleRate));
    const aR = Math.exp(-1 / (Math.max(0.001, (p.release ?? 150) / 1000) * sampleRate));
    const det = this.scWired ? this.inputs.sc : this.inputs.in;
    const slope = 1 - 1 / ratio;
    let blockGr = 0;

    for (let i = 0; i < blockSize; i++) {
      const level = Math.max(Math.abs(det.L[i]), Math.abs(det.R[i]));
      const db = 20 * Math.log10(level + DB_FLOOR);
      const over = db - threshold;
      let target;
      if (2 * over < -knee) target = 0;
      else if (knee > 0 && 2 * Math.abs(over) <= knee) {
        const x = over + knee / 2;
        target = ((x * x) / (2 * knee)) * slope; // soft knee
      } else target = over * slope;
      // dB-domain envelope: fast toward more reduction, slow back out.
      this.gr = target > this.gr ? target + (this.gr - target) * aA : target + (this.gr - target) * aR;
      if (this.gr > blockGr) blockGr = this.gr;
      const gain = Math.pow(10, -this.gr / 20) * makeup;
      this.outL[i] = this.inputs.in.L[i] * gain;
      this.outR[i] = this.inputs.in.R[i] * gain;
    }
    this.grDb = blockGr;
  }
}

class LimiterModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'limiter';
    this.params = params;
    this.inputs = { in: makeStereoBuf() };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    // 5 ms lookahead: gain reacts to the signal before it arrives.
    this.lookahead = Math.max(1, Math.round(0.005 * sampleRate));
    this.dlyL = new Float32Array(this.lookahead);
    this.dlyR = new Float32Array(this.lookahead);
    this.dIdx = 0;
    this.gr = 0;
    this.grDb = 0;
  }

  render(blockSize) {
    const p = this.params;
    const ceiling = p.ceiling ?? -0.3;
    const aA = Math.exp(-1 / (0.001 * sampleRate)); // ~1 ms clamp-down
    const aR = Math.exp(-1 / (Math.max(0.001, (p.release ?? 80) / 1000) * sampleRate));
    let blockGr = 0;

    for (let i = 0; i < blockSize; i++) {
      const inL = this.inputs.in.L[i];
      const inR = this.inputs.in.R[i];
      const level = Math.max(Math.abs(inL), Math.abs(inR));
      const db = 20 * Math.log10(level + DB_FLOOR);
      const target = Math.max(0, db - ceiling);
      this.gr = target > this.gr ? target + (this.gr - target) * aA : target + (this.gr - target) * aR;
      if (this.gr > blockGr) blockGr = this.gr;
      const gain = Math.pow(10, -this.gr / 20);
      // Output the delayed sample under the fresh gain.
      this.outL[i] = this.dlyL[this.dIdx] * gain;
      this.outR[i] = this.dlyR[this.dIdx] * gain;
      this.dlyL[this.dIdx] = inL;
      this.dlyR[this.dIdx] = inR;
      this.dIdx = (this.dIdx + 1) % this.lookahead;
    }
    this.grDb = blockGr;
  }
}

class ModulatorModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'modulator';
    this.params = params;
    this.inputs = { in: makeStereoBuf(), carrier: makeStereoBuf() };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    this.carrierWired = false; // set by the host on graph changes
    this.phase = 0;
  }

  render(blockSize) {
    const p = this.params;
    const am = Math.round(p.mode ?? 0) === 1;
    const freq = p.freq ?? 440;
    const mix = p.mix ?? 1;
    const phaseStep = freq / sampleRate;

    for (let i = 0; i < blockSize; i++) {
      const inL = this.inputs.in.L[i];
      const inR = this.inputs.in.R[i];
      let cL;
      let cR;
      if (this.carrierWired) {
        cL = this.inputs.carrier.L[i];
        cR = this.inputs.carrier.R[i];
      } else {
        cL = cR = Math.sin(2 * Math.PI * this.phase);
        this.phase += phaseStep;
        if (this.phase >= 1) this.phase -= 1;
      }
      const wetL = am ? inL * (0.5 + 0.5 * cL) : inL * cL;
      const wetR = am ? inR * (0.5 + 0.5 * cR) : inR * cR;
      this.outL[i] = inL * (1 - mix) + wetL * mix;
      this.outR[i] = inR * (1 - mix) + wetR * mix;
    }
  }
}

// DJ-style channel strip used by the mixer: kill EQ + bipolar LP/HP filter.
const MIX_EQ_FREQS = [120, 1000, 8000];
const MIX_FILTER_Q = 1.3;
const MIX_FILTER_DEADZONE = 0.05;

class MixerStrip {
  constructor() {
    // [loL, midL, hiL] / [loR, midR, hiR] + one filter biquad per side.
    this.eqL = [new Biquad(), new Biquad(), new Biquad()];
    this.eqR = [new Biquad(), new Biquad(), new Biquad()];
    this.fL = new Biquad();
    this.fR = new Biquad();
    this.coefKey = '';
    this.eqFlat = true;
    this.filterOn = false;
  }

  /** Recompute coefficients when the strip's EQ/filter params changed. */
  update(lo, mid, hi, filt) {
    const key = `${lo},${mid},${hi},${filt}`;
    if (key === this.coefKey) return;
    this.coefKey = key;
    this.eqFlat = lo === 0 && mid === 0 && hi === 0;
    if (!this.eqFlat) {
      for (const b of [this.eqL, this.eqR]) {
        b[0].lowShelf(MIX_EQ_FREQS[0], lo);
        b[1].peak(MIX_EQ_FREQS[1], mid, 0.7);
        b[2].highShelf(MIX_EQ_FREQS[2], hi);
      }
    }
    // One knob: center off, left sweeps a lowpass down, right a highpass up.
    this.filterOn = Math.abs(filt) > MIX_FILTER_DEADZONE;
    if (this.filterOn) {
      const t = (Math.abs(filt) - MIX_FILTER_DEADZONE) / (1 - MIX_FILTER_DEADZONE);
      if (filt < 0) {
        const f = 20000 * Math.pow(80 / 20000, t);
        this.fL.lowpass(f, MIX_FILTER_Q);
        this.fR.lowpass(f, MIX_FILTER_Q);
      } else {
        const f = 20 * Math.pow(8000 / 20, t);
        this.fL.highpass(f, MIX_FILTER_Q);
        this.fR.highpass(f, MIX_FILTER_Q);
      }
    }
  }

  processL(x) {
    if (!this.eqFlat) x = this.eqL[2].process(this.eqL[1].process(this.eqL[0].process(x)));
    return this.filterOn ? this.fL.process(x) : x;
  }

  processR(x) {
    if (!this.eqFlat) x = this.eqR[2].process(this.eqR[1].process(this.eqR[0].process(x)));
    return this.filterOn ? this.fR.process(x) : x;
  }
}

class MixerModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'mixer';
    this.params = params;
    this.inputs = {
      in1: makeStereoBuf(),
      in2: makeStereoBuf(),
      in3: makeStereoBuf(),
      in4: makeStereoBuf(),
    };
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    // Strips 1–4 are input channels; strip 5 is the master bus.
    this.strips = [];
    this.audioOuts = {};
    for (let ch = 1; ch <= 5; ch++) {
      this.strips.push(new MixerStrip());
      this.audioOuts[`send${ch}`] = makeStereoBuf();
    }
    this.busL = new Float32Array(128);
    this.busR = new Float32Array(128);
    // Per-channel meter peaks (post-EQ/filter, pre-fader), drained by postStatus.
    this.chPeak = [0, 0, 0, 0];
  }

  render(blockSize) {
    const p = this.params;
    this.busL.fill(0);
    this.busR.fill(0);
    for (let ch = 1; ch <= 4; ch++) {
      const strip = this.strips[ch - 1];
      strip.update(p[`eqLo${ch}`] ?? 0, p[`eqMid${ch}`] ?? 0, p[`eqHi${ch}`] ?? 0, p[`filt${ch}`] ?? 0);
      const lvl = p[`lvl${ch}`] ?? 0.8;
      const send = p[`send${ch}`] ?? 0;
      const pan = p[`pan${ch}`] ?? 0;
      // Equal-power pan law.
      const angle = ((pan + 1) * Math.PI) / 4;
      const gL = Math.cos(angle);
      const gR = Math.sin(angle);
      const input = this.inputs[`in${ch}`];
      const sendBuf = this.audioOuts[`send${ch}`];
      let peak = this.chPeak[ch - 1];
      for (let i = 0; i < blockSize; i++) {
        const l = strip.processL(input.L[i]);
        const r = strip.processR(input.R[i]);
        const a = Math.max(Math.abs(l), Math.abs(r));
        if (a > peak) peak = a;
        const fl = l * lvl;
        const fr = r * lvl;
        // Send taps post-fader, pre-pan (stereo).
        sendBuf.L[i] = fl * send;
        sendBuf.R[i] = fr * send;
        this.busL[i] += fl * gL;
        this.busR[i] += fr * gR;
      }
      this.chPeak[ch - 1] = peak;
    }

    // Master strip (ch 5) processes the summed bus the same way.
    const strip = this.strips[4];
    strip.update(p.eqLo5 ?? 0, p.eqMid5 ?? 0, p.eqHi5 ?? 0, p.filt5 ?? 0);
    const lvl = p.lvl5 ?? 0.8;
    const send = p.send5 ?? 0;
    const pan = p.pan5 ?? 0;
    const angle = ((pan + 1) * Math.PI) / 4;
    const gL = Math.SQRT2 * Math.cos(angle); // balance: unity at center
    const gR = Math.SQRT2 * Math.sin(angle);
    const sendBuf = this.audioOuts.send5;
    for (let i = 0; i < blockSize; i++) {
      const fl = strip.processL(this.busL[i]) * lvl;
      const fr = strip.processR(this.busR[i]) * lvl;
      sendBuf.L[i] = fl * send;
      sendBuf.R[i] = fr * send;
      this.outL[i] = fl * gL;
      this.outR[i] = fr * gR;
    }
  }
}

class EngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.modules = new Map();
    this.order = [];
    this.audioWires = [];
    this.noteWires = [];
    this.controlWires = [];
    this.transport = { playing: false, tempo: 120, posBeats: 0 };
    this.sampleCount = 0;
    this.nextVoiceId = 1e9; // engine-internal ids, distinct from main-thread ids
    this.lastStatusTime = 0;
    this.meterAcc = new Map();
    this.noteActivity = new Set();
    // DSP health (Options → Debug): process() time vs quantum budget, plus an
    // underrun approximation — the browser exposes no underrun event, so we
    // count status windows where wall time outran the audio clock.
    this.procTimeMs = 0;
    this.procBlocks = 0;
    this.underruns = 0;
    this.lastWallMs = 0;
    this.lastAudioTime = 0;
    this.visRings = new Map(); // moduleId → SAB, survives graph rebuilds
    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'graph': {
        const next = new Map();
        for (const m of msg.modules) {
          const existing = this.modules.get(m.id);
          if (existing && existing.type === m.type) {
            existing.params = m.params; // keep voice/limiter/step state across rewires
            if (m.data) existing.data = m.data;
            next.set(m.id, existing);
          } else if (m.type === 'smpl') {
            const inst = new SmplModule(m.id, m.params);
            inst.host = this;
            next.set(m.id, inst);
          } else if (m.type === 'wtosc') {
            next.set(m.id, new WtoscModule(m.id, m.params));
          } else if (m.type === 'levels') {
            next.set(m.id, new LevelsModule(m.id, m.params));
          } else if (m.type === 'visualizer') {
            next.set(m.id, new VisualizerModule(m.id, m.params));
          } else if (m.type === 'notenames') {
            next.set(m.id, new NotenamesModule(m.id, m.params));
          } else if (m.type === 'audioOut') {
            next.set(m.id, new AudioOutModule(m.id, m.params));
          } else if (m.type === 'lfo') {
            next.set(m.id, new LfoModule(m.id, m.params));
          } else if (m.type === 'sequencer') {
            next.set(m.id, new SequencerModule(m.id, m.params, m.data));
          } else if (m.type === 'arp') {
            next.set(m.id, new ArpModule(m.id, m.params));
          } else if (m.type === 'composer') {
            next.set(m.id, new ComposerModule(m.id, m.params, m.data));
          } else if (m.type === 'notethru') {
            const inst = new NotethruModule(m.id, m.params);
            inst.host = this;
            next.set(m.id, inst);
          } else if (m.type === 'delay') {
            next.set(m.id, new DelayModule(m.id, m.params));
          } else if (m.type === 'reverb') {
            next.set(m.id, new ReverbModule(m.id, m.params));
          } else if (m.type === 'distortion') {
            next.set(m.id, new DistortionModule(m.id, m.params));
          } else if (m.type === 'eq') {
            next.set(m.id, new EqModule(m.id, m.params));
          } else if (m.type === 'chorus') {
            next.set(m.id, new ChorusModule(m.id, m.params));
          } else if (m.type === 'flanger') {
            next.set(m.id, new FlangerModule(m.id, m.params));
          } else if (m.type === 'bitcrusher') {
            next.set(m.id, new BitcrusherModule(m.id, m.params));
          } else if (m.type === 'compressor') {
            next.set(m.id, new CompressorModule(m.id, m.params));
          } else if (m.type === 'limiter') {
            next.set(m.id, new LimiterModule(m.id, m.params));
          } else if (m.type === 'modulator') {
            next.set(m.id, new ModulatorModule(m.id, m.params));
          } else if (m.type === 'peq') {
            next.set(m.id, new PeqModule(m.id, m.params));
          } else if (m.type === 'mbcomp') {
            next.set(m.id, new MultibandModule(m.id, m.params));
          } else if (m.type === 'midiIn') {
            next.set(m.id, new MidiInModule(m.id, m.params));
          } else if (m.type === 'midiOut') {
            next.set(m.id, new MidiOutModule(m.id, m.params));
          } else if (m.type === 'mixer') {
            next.set(m.id, new MixerModule(m.id, m.params));
          } else if (m.type === 'adsr') {
            next.set(m.id, new AdsrModule(m.id, m.params));
          } else if (m.type === 'random') {
            next.set(m.id, new RandomModule(m.id, m.params));
          } else if (m.type === 'recorder') {
            next.set(m.id, new RecorderModule(m.id, m.params));
          } else if (m.type === 'voice') {
            next.set(m.id, new VoiceModule(m.id, m.params));
          } else if (m.type === 'osc') {
            next.set(m.id, new OscModule(m.id, m.params));
          } else if (m.type === 'vcf') {
            next.set(m.id, new VcfModule(m.id, m.params));
          } else if (m.type === 'vca') {
            next.set(m.id, new VcaModule(m.id, m.params));
          } else if (m.type === 'knob' || m.type === 'slider' || m.type === 'button') {
            next.set(m.id, new ControlSourceModule(m.id, m.params, m.type));
          } else if (m.type === 'xy') {
            next.set(m.id, new XyModule(m.id, m.params));
          } else if (m.type === 'quantizer') {
            next.set(m.id, new QuantizerModule(m.id, m.params));
          } else if (m.type === 'sah') {
            next.set(m.id, new SahModule(m.id, m.params));
          } else if (m.type === 'slew') {
            next.set(m.id, new SlewModule(m.id, m.params));
          } else if (m.type === 'cmath') {
            next.set(m.id, new CmathModule(m.id, m.params));
          } else if (m.type === 'modmatrix') {
            next.set(m.id, new ModMatrixModule(m.id, m.params));
          }
        }
        this.modules = next;
        // (Re)attach visual rings — new VisualizerModule instances start bare.
        // The main thread re-sends rings after every graph message, so entries
        // for deleted modules can be dropped here without losing in-flight ones.
        for (const [id, sab] of this.visRings) {
          const mod = this.modules.get(id);
          if (!mod) this.visRings.delete(id);
          else if (mod.type === 'visualizer' && !mod.ring) mod.attachRing(sab);
        }
        const valid = (w) => this.modules.has(w.fromModuleId) && this.modules.has(w.toModuleId);
        this.audioWires = msg.wires.filter((w) => w.type === 'audio' && valid(w));
        this.noteWires = msg.wires.filter((w) => w.type === 'note' && valid(w));
        this.controlWires = msg.wires.filter((w) => w.type === 'control' && valid(w));
        // Drop stale control values so unwiring stops the modulation
        // (inputs fall back to their manual values, PRD §9.5).
        for (const mod of this.modules.values()) {
          if (mod.controlIn) mod.controlIn = {};
        }
        // Sidechain-style inputs fall back to the main input when unwired.
        for (const mod of this.modules.values()) {
          if (mod.type === 'compressor') {
            mod.scWired = this.audioWires.some((w) => w.toModuleId === mod.id && w.toPortId === 'sc');
          } else if (mod.type === 'modulator') {
            mod.carrierWired = this.audioWires.some(
              (w) => w.toModuleId === mod.id && w.toPortId === 'carrier',
            );
          }
        }
        this.order = this.topoSort();
        break;
      }
      case 'param': {
        const mod = this.modules.get(msg.moduleId);
        if (mod) mod.params[msg.paramId] = msg.value;
        break;
      }
      case 'visRing': {
        // SAB audio ring for one visualizer; may arrive before its module.
        this.visRings.set(msg.moduleId, msg.sab);
        const mod = this.modules.get(msg.moduleId);
        if (mod && mod.type === 'visualizer') mod.attachRing(msg.sab);
        break;
      }
      case 'data': {
        const mod = this.modules.get(msg.moduleId);
        if (mod && mod.data) mod.data[msg.key] = msg.value;
        break;
      }
      case 'transport': {
        const wasPlaying = this.transport.playing;
        this.transport.playing = msg.playing;
        this.transport.tempo = msg.tempo;
        if (msg.songPosition !== undefined) this.transport.posBeats = msg.songPosition;
        if (wasPlaying && !msg.playing) {
          for (const mod of this.modules.values()) {
            if (mod.type === 'sequencer' || mod.type === 'composer') {
              mod.allNotesOff((srcId, voiceId) => this.routeNoteOff(srcId, voiceId));
            }
          }
        }
        break;
      }
      case 'noteOn': {
        const mod = this.modules.get(msg.moduleId);
        if (mod && mod.noteOn) mod.noteOn(msg.voiceId, msg.pitch, msg.velocity);
        break;
      }
      case 'noteOff': {
        const mod = this.modules.get(msg.moduleId);
        if (mod && mod.noteOff) mod.noteOff(msg.voiceId);
        break;
      }
      case 'sample': {
        const mod = this.modules.get(msg.moduleId);
        if (mod && mod.type === 'smpl') mod.setSample(msg.sampleRate, msg.channels, msg.loopStart, msg.loopEnd);
        else if (mod && mod.type === 'wtosc') mod.setWavetable(msg.channels);
        break;
      }
      case 'control': {
        const mod = this.modules.get(msg.moduleId);
        if (mod && mod.type === 'midiIn') mod.value = msg.value;
        break;
      }
      case 'recordStart': {
        const mod = this.modules.get(msg.moduleId);
        if (mod && mod.type === 'recorder') mod.recording = true;
        break;
      }
      case 'recordStop': {
        const mod = this.modules.get(msg.moduleId);
        if (mod && mod.type === 'recorder') {
          mod.recording = false;
          this.flushRecorder(mod);
        }
        break;
      }
      case 'panic': {
        // Kill voices + zero every stateful audio buffer so a runaway feedback
        // loop (or hung note / reverb tail) is cut instantly.
        for (const mod of this.modules.values()) {
          if (mod.allNotesOff) mod.allNotesOff((srcId, voiceId) => this.routeNoteOff(srcId, voiceId));
          if (mod.panic) mod.panic(); // deep clear for feedback effects
          if (mod.outL) mod.outL.fill(0);
          if (mod.outR) mod.outR.fill(0);
          if (mod.polyL) for (const b of mod.polyL) b.fill(0);
          if (mod.polyR) for (const b of mod.polyR) b.fill(0);
          if (mod.inputs) {
            for (const key in mod.inputs) {
              const port = mod.inputs[key];
              if (port && port.L) port.L.fill(0);
              if (port && port.R) port.R.fill(0);
            }
          }
        }
        break;
      }
    }
  }

  routeNoteOn(srcId, voiceId, pitch, velocity, fromPortId, extras) {
    for (const w of this.noteWires) {
      if (w.fromModuleId !== srcId) continue;
      // Multi-out sources route per output port.
      if (fromPortId && w.fromPortId && w.fromPortId !== fromPortId) continue;
      const target = this.modules.get(w.toModuleId);
      // extras: per-note expression { pan, modX, modY } from the piano roll.
      if (target && target.noteOn) target.noteOn(voiceId, pitch, velocity, extras);
    }
    this.noteActivity.add(srcId);
  }

  /** Choke: a smpl hit cuts same-group voices on every OTHER smpl module. */
  chokeGroup(exceptId, group) {
    for (const m of this.modules.values()) {
      if (m.type === 'smpl' && m.id !== exceptId && Math.round(m.params.chokeGroup ?? 0) === group) {
        m.choke();
      }
    }
  }

  routeNoteOff(srcId, voiceId, release) {
    for (const w of this.noteWires) {
      if (w.fromModuleId !== srcId) continue;
      const target = this.modules.get(w.toModuleId);
      if (target && target.noteOff) target.noteOff(voiceId, release);
    }
  }

  /**
   * Kahn's algorithm over audio + control wires, so control chains
   * (LFO → Slew → Quantizer → Osc) settle within one block. On a cycle the
   * remaining modules append in arbitrary order and read the previous
   * block's values — the one-block feedback delay of PRD §9.3.
   */
  topoSort() {
    const edges = [...this.audioWires, ...this.controlWires];
    const inDegree = new Map();
    for (const id of this.modules.keys()) inDegree.set(id, 0);
    for (const w of edges) inDegree.set(w.toModuleId, inDegree.get(w.toModuleId) + 1);
    const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    const order = [];
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const w of edges) {
        if (w.fromModuleId !== id) continue;
        const d = inDegree.get(w.toModuleId) - 1;
        inDegree.set(w.toModuleId, d);
        if (d === 0) queue.push(w.toModuleId);
      }
    }
    for (const id of this.modules.keys()) {
      if (!order.includes(id)) order.push(id); // cycle fallback
    }
    return order;
  }

  /** Advance sequencers across this block, emitting step notes. */
  runSequencers(blockSize) {
    const t = this.transport;
    const blockEnd = this.sampleCount + blockSize;

    for (const mod of this.modules.values()) {
      if (mod.type === 'arp') {
        this.runArp(mod, blockSize, blockEnd);
        continue;
      }
      if (mod.type === 'composer') {
        this.runComposer(mod, blockSize, blockEnd);
        continue;
      }
      if (mod.type !== 'sequencer') continue;

      // Scheduled note-offs (gate end), checked every block.
      mod.activeNotes = mod.activeNotes.filter((n) => {
        if (n.offAtSample <= blockEnd) {
          this.routeNoteOff(mod.id, n.voiceId);
          return false;
        }
        return true;
      });

      if (!t.playing) continue;
      const steps = (mod.data && mod.data.steps) || [];
      if (steps.length === 0) continue;

      // Blocks (~3 ms) are far shorter than any step, so at most one step
      // boundary falls inside a block.
      const spb = mod.stepsPerBeat();
      const idx = Math.floor(t.posBeats * spb);
      if (idx !== mod.lastStepIndex) {
        mod.lastStepIndex = idx;
        mod.currentStep = ((idx % steps.length) + steps.length) % steps.length;
        const step = steps[mod.currentStep];
        if (step && step.on) {
          const voiceId = this.nextVoiceId++;
          const stepDurSamples = (60 / t.tempo / spb) * sampleRate;
          const gate = mod.params.gate ?? 0.5;
          this.routeNoteOn(mod.id, voiceId, step.pitch, 0.9);
          mod.activeNotes.push({ voiceId, offAtSample: this.sampleCount + stepDurSamples * gate });
        }
      }
    }

    if (t.playing) {
      t.posBeats += (t.tempo / 60) * (blockSize / sampleRate);
    }
  }

  /**
   * Advance one composer across this block: fire clip notes whose start
   * falls inside the block's beat window, mapped into the loop. Blocks tile
   * the timeline with half-open windows, so each note fires exactly once
   * per pass (minus probability rolls).
   */
  runComposer(mod, blockSize, blockEnd) {
    const t = this.transport;

    mod.activeNotes = mod.activeNotes.filter((n) => {
      if (n.offAtSample <= blockEnd) {
        this.routeNoteOff(mod.id, n.voiceId, n.release);
        return false;
      }
      return true;
    });

    if (!t.playing) return;
    const notes = (mod.data && mod.data.notes) || [];
    const len = Math.max(1, (mod.data && mod.data.length) || 16);
    if (notes.length === 0) return;

    const blockBeats = (t.tempo / 60) * (blockSize / sampleRate);
    const start = ((t.posBeats % len) + len) % len;
    const end = start + blockBeats;

    for (const note of notes) {
      // Notes at/past the loop end are inert — folding them modulo the loop
      // would replay a long MIDI import's tail on top of the loop start.
      const s = note.start;
      if (s >= len) continue;
      const hit = (s >= start && s < end) || (end > len && s < end - len);
      if (!hit) continue;
      const prob = note.prob === undefined ? 1 : note.prob;
      if (prob < 1 && Math.random() > prob) continue;
      const voiceId = this.nextVoiceId++;
      this.routeNoteOn(
        mod.id,
        voiceId,
        note.pitch,
        note.vel === undefined ? 0.8 : note.vel,
        'notes',
        { pan: note.pan || 0, modX: note.modX || 0, modY: note.modY || 0 },
      );
      const durSamples = (note.length * 60 / t.tempo) * sampleRate;
      mod.activeNotes.push({
        voiceId,
        offAtSample: this.sampleCount + durSamples,
        release: note.release === undefined ? 0.5 : note.release,
      });
    }
  }

  /** Advance one arpeggiator across this block. */
  runArp(mod, blockSize, blockEnd) {
    const t = this.transport;

    // Gate-end note-offs.
    mod.activeNotes = mod.activeNotes.filter((n) => {
      if (n.offAtSample <= blockEnd) {
        this.routeNoteOff(mod.id, n.voiceId);
        return false;
      }
      return true;
    });

    // Transport drives the clock while playing; free-run at tempo otherwise.
    let beats;
    if (t.playing) {
      beats = t.posBeats;
      mod.freeBeats = t.posBeats;
    } else {
      mod.freeBeats += (t.tempo / 60) * (blockSize / sampleRate);
      beats = mod.freeBeats;
    }

    const seq = mod.sequence();
    if (seq.length === 0) {
      mod.lastStepIndex = -1;
      return;
    }
    const spb = mod.stepsPerBeat();
    const idx = Math.floor(beats * spb);
    if (idx === mod.lastStepIndex) return;
    mod.lastStepIndex = idx;

    const mode = Math.round(mod.params.mode ?? 0);
    const pitch = mode === 3
      ? seq[Math.floor(Math.random() * seq.length)]
      : seq[((idx % seq.length) + seq.length) % seq.length];
    const voiceId = this.nextVoiceId++;
    const stepDurSamples = (60 / t.tempo / spb) * sampleRate;
    const gate = mod.params.gate ?? 0.6;
    this.routeNoteOn(mod.id, voiceId, pitch, 0.85);
    mod.activeNotes.push({ voiceId, offAtSample: this.sampleCount + stepDurSamples * gate });
  }

  /** Advance one drum machine's internal step sequencer across this block. */
  pullControls(mod) {
    if (!mod.controlIn) return;
    for (const w of this.controlWires) {
      if (w.toModuleId !== mod.id) continue;
      const src = this.modules.get(w.fromModuleId);
      if (!src) continue;
      const v = src.controlOut && src.controlOut[w.fromPortId] !== undefined
        ? src.controlOut[w.fromPortId]
        : src.value;
      if (v !== undefined) mod.controlIn[w.toPortId] = v;
    }
  }

  process(_inputs, outputs) {
    const procStart = Date.now();
    const out = outputs[0];
    const blockSize = out[0].length;
    out[0].fill(0);
    if (out[1]) out[1].fill(0);

    this.runSequencers(blockSize);

    for (const id of this.order) {
      const mod = this.modules.get(id);
      if (!mod) continue;

      this.pullControls(mod);

      // Sum incoming audio wires into the module's input buffers: plain
      // stereo ports get the lane-collapsed mix (src.outL/outR), poly-aware
      // ports (polyIn) keep per-voice lanes.
      if (mod.inputs || mod.polyIn) {
        if (mod.inputs) {
          for (const key in mod.inputs) {
            mod.inputs[key].L.fill(0);
            mod.inputs[key].R.fill(0);
          }
        }
        if (mod.polyIn) {
          for (const key in mod.polyIn) {
            const pi = mod.polyIn[key];
            for (let v = 0; v < pi.L.length; v++) {
              pi.L[v].fill(0);
              pi.R[v].fill(0);
            }
            pi.lanes = 0;
          }
        }
        for (const w of this.audioWires) {
          if (w.toModuleId !== id) continue;
          const src = this.modules.get(w.fromModuleId);
          if (!src || !src.outL) continue;
          const pi = mod.polyIn && mod.polyIn[w.toPortId];
          if (pi) {
            const lanes = src.polyLanes > 0 ? src.polyLanes : 1;
            while (pi.L.length < lanes) {
              pi.L.push(new Float32Array(128));
              pi.R.push(new Float32Array(128));
            }
            for (let v = 0; v < lanes; v++) {
              const sL = src.polyLanes > 0 ? src.polyL[v] : src.outL;
              const sR = src.polyLanes > 0 ? src.polyR[v] : src.outR;
              const dL = pi.L[v];
              const dR = pi.R[v];
              for (let i = 0; i < blockSize; i++) {
                dL[i] += sL[i];
                dR[i] += sR[i];
              }
            }
            pi.lanes = Math.max(pi.lanes, lanes);
            continue;
          }
          const dst = mod.inputs && mod.inputs[w.toPortId];
          if (!dst) continue;
          // Secondary audio outs (mixer send poles) live in src.audioOuts.
          const aux = src.audioOuts && w.fromPortId && src.audioOuts[w.fromPortId];
          const sL = aux ? aux.L : src.outL;
          const sR = aux ? aux.R : src.outR;
          for (let i = 0; i < blockSize; i++) {
            dst.L[i] += sL[i];
            dst.R[i] += sR[i];
          }
        }
      }

      if (CONTROL_RATE_TYPES.has(mod.type)) {
        mod.render(blockSize);
        continue;
      }
      if (mod.type === 'sequencer' || mod.type === 'arp' || mod.type === 'composer' || mod.type === 'notethru' || mod.type === 'midiIn' || mod.type === 'notenames') continue;
      if (mod.type === 'midiOut') {
        mod.collectCc();
        continue;
      }

      // Effect bypass (PRD §8.4): pass the main input straight through.
      if (mod.inputs && mod.inputs.in && (mod.params.bypass ?? 0) >= 0.5) {
        for (let i = 0; i < blockSize; i++) {
          mod.outL[i] = mod.inputs.in.L[i];
          mod.outR[i] = mod.inputs.in.R[i];
        }
        if (mod.grDb !== undefined) mod.grDb = 0;
        continue;
      }

      if (mod.type === 'delay') mod.tempo = this.transport.tempo; // sync mode needs the clock
      mod.render(blockSize);

      if (mod.type === 'audioOut') {
        for (let i = 0; i < blockSize; i++) {
          out[0][i] += mod.outL[i];
          if (out[1]) out[1][i] += mod.outR[i];
        }
      }
    }

    this.sampleCount += blockSize;

    // Ship MIDI Out events promptly (per block) — status cadence is too slow.
    let midiEvents = null;
    for (const mod of this.modules.values()) {
      if (mod.type === 'midiOut' && mod.pending.length > 0) {
        midiEvents = (midiEvents || []).concat(mod.pending);
        mod.pending = [];
      }
    }
    if (midiEvents) this.port.postMessage({ type: 'midi', events: midiEvents });

    // Stream recorder captures in ~0.25 s chunks.
    for (const mod of this.modules.values()) {
      if (mod.type === 'recorder' && mod.recording && mod.pendingSamples >= sampleRate / 4) {
        this.flushRecorder(mod);
      }
    }

    this.procTimeMs += Date.now() - procStart;
    this.procBlocks++;
    this.postStatus(blockSize);
    return true;
  }

  flushRecorder(mod) {
    const data = mod.drain();
    if (!data) return;
    this.port.postMessage(
      { type: 'recordData', moduleId: mod.id, sampleRate, chL: data.chL, chR: data.chR },
      [data.chL.buffer, data.chR.buffer],
    );
  }

  postStatus(blockSize) {
    // Accumulate meters every block so brief peaks aren't missed between posts.
    for (const mod of this.modules.values()) {
      if (!mod.outL) continue;
      let peak = 0;
      let sumSq = 0;
      for (let i = 0; i < blockSize; i++) {
        const a = Math.abs(mod.outL[i]);
        if (a > peak) peak = a;
        sumSq += mod.outL[i] * mod.outL[i];
      }
      const prev = this.meterAcc.get(mod.id) || { peak: 0, sumSq: 0, n: 0, clipped: false };
      this.meterAcc.set(mod.id, {
        peak: Math.max(prev.peak, peak),
        sumSq: prev.sumSq + sumSq,
        n: prev.n + blockSize,
        clipped: prev.clipped || peak > 1,
      });

      // Mixer channel meters (pre-fader), keyed "<id>:chN".
      if (mod.chPeak) {
        for (let c = 0; c < mod.chPeak.length; c++) {
          const key = `${mod.id}:ch${c + 1}`;
          const p = this.meterAcc.get(key) || { peak: 0, sumSq: 0, n: 0, clipped: false };
          this.meterAcc.set(key, {
            peak: Math.max(p.peak, mod.chPeak[c]),
            sumSq: 0,
            n: 0,
            clipped: p.clipped || mod.chPeak[c] > 1,
          });
          mod.chPeak[c] = 0;
        }
      }
    }

    const now = currentTime;
    if (now - this.lastStatusTime < STATUS_INTERVAL_S) return;
    this.lastStatusTime = now;

    // DSP load + underrun approximation over the elapsed status window: if
    // wall time advanced well past the audio clock, output stalled somewhere.
    const wallMs = Date.now();
    const budgetMs = (this.procBlocks * blockSize * 1000) / sampleRate;
    const load = budgetMs > 0 ? this.procTimeMs / budgetMs : 0;
    if (this.lastWallMs > 0) {
      const wallDelta = wallMs - this.lastWallMs;
      const audioDelta = (now - this.lastAudioTime) * 1000;
      if (wallDelta - audioDelta > 30) this.underruns++;
    }
    this.lastWallMs = wallMs;
    this.lastAudioTime = now;
    const perf = { load, underruns: this.underruns };
    this.procTimeMs = 0;
    this.procBlocks = 0;

    const meters = {};
    for (const [id, acc] of this.meterAcc) {
      meters[id] = {
        peak: acc.peak,
        rms: acc.n ? Math.sqrt(acc.sumSq / acc.n) : 0,
        clipped: acc.clipped,
      };
    }
    this.meterAcc.clear();

    const seqSteps = {};
    const controlValues = {};
    const gainReduction = {};
    const spectra = {};
    const visData = {};
    const textNotes = {};
    for (const mod of this.modules.values()) {
      if (mod.type === 'sequencer') seqSteps[mod.id] = mod.currentStep;
      if (mod.value !== undefined) controlValues[mod.id] = mod.value;
      if (mod.grDb !== undefined) gainReduction[mod.id] = mod.grDb;
      if (mod.type === 'peq') spectra[mod.id] = mod.spectrum();
      if (mod.type === 'visualizer') visData[mod.id] = mod.visData();
      if (mod.type === 'notenames') {
        const notes = mod.drainNotes();
        if (notes.length > 0) textNotes[mod.id] = notes;
      }
    }

    this.port.postMessage({
      type: 'status',
      meters,
      seqSteps,
      controlValues,
      gainReduction,
      spectra,
      visData,
      textNotes,
      noteActivity: [...this.noteActivity],
      songPosition: this.transport.posBeats,
      perf,
    });
    this.noteActivity.clear();
  }
}

registerProcessor('kabelkraft-engine', EngineProcessor);
