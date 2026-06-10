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

const MODE_CLASSIC = 0;
const MODE_WAVETABLE = 1;
const MODE_FM = 2;

const WT_FRAME = 2048;
const FM_INDEX = 6; // op level 1.0 → 6 rad of phase modulation

/** FM algorithms: routes are [srcOp → dstOp] (0-based), carriers sum to out. */
const FM_ALGOS = [
  { routes: [[3, 2], [2, 1], [1, 0]], carriers: [0] },          // 4→3→2→1
  { routes: [[2, 1], [1, 0]], carriers: [0, 3] },               // 3→2→1, op4 parallel
  { routes: [[2, 1], [3, 1], [1, 0]], carriers: [0] },          // (3+4)→2→1
  { routes: [[1, 0], [2, 0], [3, 0]], carriers: [0] },          // (2+3+4)→1
  { routes: [[3, 2], [1, 0]], carriers: [0, 2] },               // 4→3, 2→1
  { routes: [], carriers: [0, 1, 2, 3] },                       // additive
];

class Voice {
  constructor() {
    this.active = false;
    this.voiceId = -1;
    this.pitch = 60; // target pitch (glide destination)
    this.curPitch = 60;
    this.velocity = 1;
    this.phase = 0;
    this.phase2 = 0;
    this.fmPhase = [0, 0, 0, 0];
    this.fmPrev3 = 0; // op4 output for feedback
    this.stage = 'off'; // attack | decay | sustain | release | off
    this.env = 0;
    this.fStage = 'off';
    this.fEnv = 0;
    this.svfLp = 0;
    this.svfBp = 0;
    this.age = 0;
  }

  noteOn(voiceId, pitch, velocity, glideFrom) {
    this.active = true;
    this.voiceId = voiceId;
    this.pitch = pitch;
    this.curPitch = glideFrom !== undefined ? glideFrom : pitch;
    this.velocity = velocity;
    this.stage = 'attack';
    this.fStage = 'attack';
    this.fEnv = 0;
    this.age = 0;
    // amp env continues from current level for click-free retrigger
  }

  noteOff() {
    if (this.stage !== 'off') this.stage = 'release';
    if (this.fStage !== 'off') this.fStage = 'release';
  }
}

class SynthModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'synth';
    this.params = params;
    /** Live values on control input ports (portId → 0..1). */
    this.controlIn = {};
    this.voices = [];
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice());
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    this.lastPitch = undefined; // glide start for the next note
    this.wavetable = null; // { data: Float32Array, frames }
  }

  /** Loadable wavetable (PRD §8.2): PCM is split into 2048-sample frames. */
  setWavetable(channels) {
    const pcm = channels[0];
    if (!pcm || pcm.length === 0) return;
    if (pcm.length >= WT_FRAME) {
      const frames = Math.max(1, Math.floor(pcm.length / WT_FRAME));
      this.wavetable = { data: pcm.subarray(0, frames * WT_FRAME), frames };
    } else {
      // Short file: treat it as one cycle, resample to a single frame.
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

  /** Built-in table so wavetable mode sounds without a file: sine→tri→saw→square. */
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

  maxVoices() {
    return Math.min(MAX_VOICES, Math.max(1, Math.round(this.params.voices ?? 8)));
  }

  noteOn(voiceId, pitch, velocity) {
    const limit = this.maxVoices();
    const activeVoices = this.voices.filter((v) => v.active);
    let voice;
    if (activeVoices.length >= limit) {
      voice = activeVoices.reduce((a, b) => (a.age > b.age ? a : b)); // steal oldest
    } else {
      voice = this.voices.find((v) => !v.active);
    }
    const glide = this.params.glide ?? 0;
    voice.noteOn(voiceId, pitch, velocity, glide > 0.001 ? this.lastPitch : undefined);
    this.lastPitch = pitch;
  }

  noteOff(voiceId) {
    for (const v of this.voices) {
      if (v.active && v.voiceId === voiceId) v.noteOff();
    }
  }

  oscClassic(v, phaseStep, wave, wave2, detuneRatio, mix, pwm) {
    let s1;
    const ph = v.phase;
    switch (wave) {
      case WAVE_SINE: s1 = Math.sin(2 * Math.PI * ph); break;
      case WAVE_TRIANGLE: s1 = 4 * Math.abs(ph - 0.5) - 1; break;
      case WAVE_SQUARE: s1 = ph < pwm ? 1 : -1; break;
      case WAVE_NOISE: s1 = Math.random() * 2 - 1; break;
      case WAVE_SAW:
      default: s1 = 2 * ph - 1; break;
    }
    v.phase += phaseStep;
    if (v.phase >= 1) v.phase -= 1;
    if (mix <= 0.001) return s1;
    let s2;
    const ph2 = v.phase2;
    switch (wave2) {
      case WAVE_SINE: s2 = Math.sin(2 * Math.PI * ph2); break;
      case WAVE_TRIANGLE: s2 = 4 * Math.abs(ph2 - 0.5) - 1; break;
      case WAVE_SQUARE: s2 = ph2 < pwm ? 1 : -1; break;
      case WAVE_NOISE: s2 = Math.random() * 2 - 1; break;
      case WAVE_SAW:
      default: s2 = 2 * ph2 - 1; break;
    }
    v.phase2 += phaseStep * detuneRatio;
    if (v.phase2 >= 1) v.phase2 -= 1;
    return s1 * (1 - mix) + s2 * mix;
  }

  oscWavetable(v, phaseStep, framePos) {
    const wt = this.wavetable || this.defaultWavetable();
    const f0 = Math.floor(framePos);
    const f1 = Math.min(wt.frames - 1, f0 + 1);
    const fFrac = framePos - f0;
    const idx = v.phase * WT_FRAME;
    const i0 = Math.floor(idx);
    const i1 = (i0 + 1) % WT_FRAME;
    const frac = idx - i0;
    const a = wt.data[f0 * WT_FRAME + i0] * (1 - frac) + wt.data[f0 * WT_FRAME + i1] * frac;
    const b = wt.data[f1 * WT_FRAME + i0] * (1 - frac) + wt.data[f1 * WT_FRAME + i1] * frac;
    v.phase += phaseStep;
    if (v.phase >= 1) v.phase -= 1;
    return a * (1 - fFrac) + b * fFrac;
  }

  oscFm(v, freq, algo, ratios, levels, fb, idxScale) {
    const outs = [0, 0, 0, 0];
    for (let op = 3; op >= 0; op--) {
      let mod = 0;
      for (const [src, dst] of algo.routes) {
        if (dst === op) mod += outs[src] * levels[src] * FM_INDEX * idxScale;
      }
      if (op === 3 && fb > 0) mod += v.fmPrev3 * fb * 3;
      outs[op] = Math.sin(2 * Math.PI * v.fmPhase[op] + mod);
      v.fmPhase[op] += (freq * ratios[op]) / sampleRate;
      if (v.fmPhase[op] >= 1) v.fmPhase[op] -= 1;
    }
    v.fmPrev3 = outs[3];
    let sum = 0;
    for (const c of algo.carriers) sum += outs[c] * levels[c];
    return sum / Math.sqrt(algo.carriers.length);
  }

  render(blockSize) {
    const p = this.params;
    const mode = Math.round(p.mode ?? MODE_CLASSIC);
    const octave = Math.round(p.octave ?? 0);
    const coarse = Math.round(p.coarse ?? 0);
    const fine = (p.fine ?? 0) / 100;
    const glide = p.glide ?? 0;
    const level = p.level ?? 0.8;
    const sustain = p.sustain ?? 0.7;
    const atkStep = 1 / (Math.max(0.001, p.attack ?? 0.01) * sampleRate);
    const decStep = 1 / (Math.max(0.001, p.decay ?? 0.15) * sampleRate);
    const relStep = 1 / (Math.max(0.001, p.release ?? 0.3) * sampleRate);
    const fSustain = p.fSustain ?? 0.5;
    const fAtkStep = 1 / (Math.max(0.001, p.fAttack ?? 0.01) * sampleRate);
    const fDecStep = 1 / (Math.max(0.001, p.fDecay ?? 0.2) * sampleRate);
    const fRelStep = 1 / (Math.max(0.001, p.fRelease ?? 0.3) * sampleRate);

    // Control inputs (0..1).
    const pmAmt = p.pmAmt ?? 2;
    const pitchModSemis =
      this.controlIn.pitchMod !== undefined ? (this.controlIn.pitchMod - 0.5) * 2 * pmAmt : 0;
    const cutoffModOct =
      this.controlIn.cutoffMod !== undefined ? (this.controlIn.cutoffMod - 0.5) * 2 * 3 : 0;
    const posCtrl = this.controlIn.posMod;

    const fType = Math.round(p.fType ?? 0);
    const cutoff = p.cutoff ?? 8000;
    const res = p.res ?? 0.2;
    const fAmt = p.fAmt ?? 0;
    const damp = 2 * (1 - Math.min(0.95, res));

    // Mode-specific, hoisted out of the sample loop.
    const wave = Math.round(p.waveform ?? WAVE_SAW);
    const wave2 = Math.round(p.wave2 ?? WAVE_SAW);
    const detuneRatio = Math.pow(2, (p.detune ?? 8) / 1200);
    const oscMix = p.oscMix ?? 0.3;
    const pwm = p.pwm ?? 0.5;
    const wtParam = posCtrl !== undefined ? posCtrl : (p.wtPos ?? 0);
    const algo = FM_ALGOS[Math.round(p.algo ?? 0)] || FM_ALGOS[0];
    const ratios = [p.r1 ?? 1, p.r2 ?? 2, p.r3 ?? 1, p.r4 ?? 1];
    const fmLevels = [p.l1 ?? 1, p.l2 ?? 0.5, p.l3 ?? 0, p.l4 ?? 0];
    const fmFb = p.fmFb ?? 0;
    const idxScale = posCtrl !== undefined ? posCtrl * 2 : 1;

    const glideCoef = glide > 0.001 ? 1 - Math.exp(-1 / (glide * 0.2 * sampleRate)) : 1;

    this.outL.fill(0);

    for (const v of this.voices) {
      if (!v.active) continue;

      // Per-voice cutoff once per block: filter env moves slowly vs. ~3 ms blocks.
      let f = 0;
      if (fType > 0) {
        const cutEff = Math.min(
          16000,
          Math.max(20, cutoff * Math.pow(2, v.fEnv * fAmt * 6 + cutoffModOct)),
        );
        f = Math.min(1, 2 * Math.sin(Math.PI * Math.min(0.45, cutEff / sampleRate)));
      }

      for (let i = 0; i < blockSize; i++) {
        if (v.stage === 'attack') {
          v.env += atkStep;
          if (v.env >= 1) { v.env = 1; v.stage = 'decay'; }
        } else if (v.stage === 'decay') {
          v.env -= decStep;
          if (v.env <= sustain) { v.env = sustain; v.stage = 'decay-hold'; }
        } else if (v.stage === 'release') {
          v.env -= relStep;
          if (v.env <= 0) { v.env = 0; v.stage = 'off'; v.active = false; break; }
        }
        if (v.fStage === 'attack') {
          v.fEnv += fAtkStep;
          if (v.fEnv >= 1) { v.fEnv = 1; v.fStage = 'decay'; }
        } else if (v.fStage === 'decay') {
          v.fEnv -= fDecStep;
          if (v.fEnv <= fSustain) { v.fEnv = fSustain; v.fStage = 'decay-hold'; }
        } else if (v.fStage === 'release') {
          v.fEnv -= fRelStep;
          if (v.fEnv <= 0) { v.fEnv = 0; v.fStage = 'off'; }
        }

        if (glideCoef < 1) v.curPitch += (v.pitch - v.curPitch) * glideCoef;
        else v.curPitch = v.pitch;

        const freq =
          440 * Math.pow(2, (v.curPitch + octave * 12 + coarse + fine + pitchModSemis - 69) / 12);
        const phaseStep = freq / sampleRate;

        let sample;
        if (mode === MODE_WAVETABLE) {
          const wt = this.wavetable || this.defaultWavetable();
          sample = this.oscWavetable(v, phaseStep, wtParam * (wt.frames - 1));
        } else if (mode === MODE_FM) {
          sample = this.oscFm(v, freq, algo, ratios, fmLevels, fmFb, idxScale);
        } else {
          sample = this.oscClassic(v, phaseStep, wave, wave2, detuneRatio, oscMix, pwm);
        }

        if (fType > 0) {
          // Chamberlin state-variable filter, one per voice.
          v.svfLp += f * v.svfBp;
          const hp = sample - v.svfLp - damp * v.svfBp;
          v.svfBp += f * hp;
          sample = fType === 1 ? v.svfLp : fType === 2 ? hp : v.svfBp;
        }

        this.outL[i] += sample * v.env * v.velocity * 0.3;
      }
      v.age++;
    }

    if (level !== 1) {
      for (let i = 0; i < blockSize; i++) this.outL[i] *= level;
    }
    this.outR.set(this.outL);
  }
}

class SamplerModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'sampler';
    this.params = params;
    this.controlIn = {};
    this.sample = null; // { sampleRate, chL, chR }
    this.voices = []; // { active, voiceId, pos, rate, velocity, stage, env, age }
    for (let i = 0; i < MAX_VOICES; i++) {
      this.voices.push({ active: false, voiceId: -1, pos: 0, rate: 1, velocity: 1, stage: 'off', env: 0, age: 0 });
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
      loopEnd: loopEnd || 0, // 0 = no explicit loop region
    };
    for (const v of this.voices) v.active = false;
  }

  noteOn(voiceId, pitch, velocity) {
    if (!this.sample) return;
    let voice = this.voices.find((v) => !v.active);
    if (!voice) voice = this.voices.reduce((a, b) => (a.age > b.age ? a : b));
    const root = this.params.root ?? 60;
    voice.active = true;
    voice.voiceId = voiceId;
    voice.pos = 0;
    // Pitch tracking + source/engine sample-rate compensation.
    voice.rate = Math.pow(2, (pitch - root) / 12) * (this.sample.sampleRate / sampleRate);
    voice.velocity = velocity;
    voice.stage = 'attack';
    voice.env = 0;
    voice.age = 0;
  }

  noteOff(voiceId) {
    for (const v of this.voices) {
      if (v.active && v.voiceId === voiceId) v.stage = 'release';
    }
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
    const { chL, chR, loopStart } = this.sample;
    const len = chL.length;
    // Explicit loop region from the Sample Editor; default = whole sample.
    const loopEnd =
      this.sample.loopEnd > loopStart + 1 ? Math.min(this.sample.loopEnd, len - 1) : len - 1;

    for (const v of this.voices) {
      if (!v.active) continue;
      for (let i = 0; i < blockSize; i++) {
        if (v.stage === 'attack') {
          v.env += atkStep;
          if (v.env >= 1) { v.env = 1; v.stage = 'decay'; }
        } else if (v.stage === 'decay') {
          v.env -= decStep;
          if (v.env <= sustain) { v.env = sustain; v.stage = 'sustain'; }
        } else if (v.stage === 'release') {
          v.env -= relStep;
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
        this.outL[i] += (chL[i0] * (1 - frac) + chL[i0 + 1] * frac) * g;
        this.outR[i] += (chR[i0] * (1 - frac) + chR[i0 + 1] * frac) * g;
        v.pos += v.rate;
      }
      v.age++;
    }
  }
}

const DRUM_PADS = 16;
const DRUM_BASE_NOTE = 36;

/**
 * 16-pad drum machine: one-shot sample playback, mono per pad (retrigger
 * cuts), per-pad level/pan/pitch/choke/attack/decay from the data blob,
 * built-in step sequencer (velocity + swing) driven by runSequencers.
 */
class DrumModule {
  constructor(id, params, data) {
    this.id = id;
    this.type = 'drum';
    this.params = params;
    this.data = data || { pads: [], pattern: [] };
    this.samples = new Array(DRUM_PADS).fill(null); // { sampleRate, chL, chR }
    this.voices = [];
    for (let i = 0; i < DRUM_PADS; i++) {
      this.voices.push({
        active: false, pos: 0, rate: 1, gain: 0, gL: 0.707, gR: 0.707,
        env: 0, stage: 'off', atkStep: 1, decayCoef: 1, choked: false, sample: null,
      });
    }
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    this.lastStepIndex = -1;
    this.currentStep = 0;
    /** Swing-delayed hits: { atSample, pad, vel }. */
    this.pendingHits = [];
  }

  setSample(pad, sampleRate, channels) {
    if (pad < 0 || pad >= DRUM_PADS) return;
    this.samples[pad] = { sampleRate, chL: channels[0], chR: channels[1] || channels[0] };
    this.voices[pad].active = false;
  }

  padCfg(i) {
    return (this.data.pads || [])[i] || null;
  }

  noteOn(voiceId, pitch, velocity) {
    const pad = (((Math.round(pitch) - DRUM_BASE_NOTE) % DRUM_PADS) + DRUM_PADS) % DRUM_PADS;
    this.trigger(pad, velocity);
  }

  noteOff() {} // one-shots: gate end is meaningless

  trigger(pad, vel) {
    const smp = this.samples[pad];
    if (!smp) return;
    const cfg = this.padCfg(pad) || {};
    const choke = cfg.choke || 0;
    if (choke > 0) {
      for (let i = 0; i < DRUM_PADS; i++) {
        if (i === pad) continue;
        const other = this.padCfg(i);
        if (other && other.choke === choke && this.voices[i].active) this.voices[i].choked = true;
      }
    }
    const v = this.voices[pad];
    v.active = true;
    v.choked = false;
    v.pos = 0;
    v.sample = smp;
    v.rate = Math.pow(2, (cfg.pitch || 0) / 12) * (smp.sampleRate / sampleRate);
    v.gain = vel * (cfg.level !== undefined ? cfg.level : 0.8);
    // Equal-power pan, same law as the mixer.
    const angle = (((cfg.pan || 0) + 1) * Math.PI) / 4;
    v.gL = Math.cos(angle);
    v.gR = Math.sin(angle);
    v.atkStep = 1 / (Math.max(0.0005, cfg.attack !== undefined ? cfg.attack : 0.001) * sampleRate);
    v.decayCoef = Math.exp(-1 / (Math.max(0.01, cfg.decay !== undefined ? cfg.decay : 2) * sampleRate));
    v.env = 0;
    v.stage = 'attack';
  }

  render(blockSize) {
    this.outL.fill(0);
    this.outR.fill(0);
    const master = this.params.level !== undefined ? this.params.level : 0.8;
    const chokeCoef = Math.exp(-1 / (0.003 * sampleRate)); // ~3 ms choke fade
    for (let pi = 0; pi < DRUM_PADS; pi++) {
      const v = this.voices[pi];
      if (!v.active || !v.sample) continue;
      const { chL, chR } = v.sample;
      const len = chL.length;
      for (let i = 0; i < blockSize; i++) {
        if (v.choked) {
          v.env *= chokeCoef;
          if (v.env < 0.001) { v.active = false; break; }
        } else if (v.stage === 'attack') {
          v.env += v.atkStep;
          if (v.env >= 1) { v.env = 1; v.stage = 'decay'; }
        } else {
          v.env *= v.decayCoef;
          if (v.env < 0.001) { v.active = false; break; }
        }
        const i0 = Math.floor(v.pos);
        if (i0 >= len - 1) { v.active = false; break; }
        const frac = v.pos - i0;
        const g = v.env * v.gain * master;
        this.outL[i] += (chL[i0] * (1 - frac) + chL[i0 + 1] * frac) * g * v.gL;
        this.outR[i] += (chR[i0] * (1 - frac) + chR[i0 + 1] * frac) * g * v.gR;
        v.pos += v.rate;
      }
    }
  }

  stepsPerBeat() {
    const division = Math.round(this.params.division !== undefined ? this.params.division : 1);
    return [2, 4, 8][division] || 4;
  }

  /** Transport stopped: drop scheduled hits, reset the step cursor. */
  resetSteps() {
    this.pendingHits = [];
    this.lastStepIndex = -1;
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

/** Note-gated control envelope (monophonic; any held note keeps the gate open). */
class AdsrModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'adsr';
    this.params = params;
    this.held = new Set();
    this.stage = 'off'; // attack | decay | sustain | release | off
    this.env = 0;
    this.value = 0;
  }

  noteOn(voiceId) {
    this.held.add(voiceId);
    this.stage = 'attack';
  }

  noteOff(voiceId) {
    this.held.delete(voiceId);
    if (this.held.size === 0 && this.stage !== 'off') this.stage = 'release';
  }

  render(blockSize) {
    const p = this.params;
    const step = blockSize / sampleRate;
    if (this.stage === 'attack') {
      this.env += step / Math.max(0.001, p.attack ?? 0.05);
      if (this.env >= 1) { this.env = 1; this.stage = 'decay'; }
    } else if (this.stage === 'decay') {
      const sustain = p.sustain ?? 0.6;
      this.env -= step / Math.max(0.001, p.decay ?? 0.2);
      if (this.env <= sustain) { this.env = sustain; this.stage = 'sustain'; }
    } else if (this.stage === 'release') {
      this.env -= step / Math.max(0.001, p.release ?? 0.3);
      if (this.env <= 0) { this.env = 0; this.stage = 'off'; }
    }
    this.value = this.env;
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
}

/**
 * Composer (PRD §8.3): pattern bank arranged into a song. One song slot =
 * one bar of 16 sixteenths; each of the 4 tracks emits on its own out port.
 */
class ComposerModule {
  constructor(id, params, data) {
    this.id = id;
    this.type = 'composer';
    this.params = params;
    this.data = data || { patterns: [], song: [] };
    this.lastStepIndex = -1;
    this.activeNotes = []; // { voiceId, offAtSample }
  }

  allNotesOff(emitOff) {
    for (const n of this.activeNotes) emitOff(this.id, n.voiceId);
    this.activeNotes = [];
    this.lastStepIndex = -1;
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

/** Audio/note sink feeding the main-thread visualizer (PRD §8.5). */
class VisualizerModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'visualizer';
    this.params = params;
    this.inputs = { in: makeStereoBuf() };
    this.controlIn = {};
    this.capture = new Float32Array(FFT_N);
    this.capIdx = 0;
    this.recentNotes = [];
  }

  noteOn(voiceId, pitch) {
    if (this.recentNotes.length < 32) this.recentNotes.push(pitch);
  }

  noteOff() {}

  render(blockSize) {
    for (let i = 0; i < blockSize; i++) {
      this.capture[this.capIdx] = (this.inputs.in.L[i] + this.inputs.in.R[i]) * 0.5;
      this.capIdx = (this.capIdx + 1) % FFT_N;
    }
  }

  /** Posted with each status message; drains the note queue. */
  visData() {
    const wave = new Array(256);
    // Last 1024 captured samples, decimated ×4.
    for (let i = 0; i < 256; i++) {
      wave[i] = this.capture[(this.capIdx + FFT_N - 1024 + i * 4) % FFT_N];
    }
    const notes = this.recentNotes;
    this.recentNotes = [];
    return {
      wave,
      spectrum: computeSpectrum(this.capture, this.capIdx),
      notes,
      ctrl: this.controlIn.mod !== undefined ? this.controlIn.mod : -1,
    };
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
}

class Allpass {
  constructor(size) {
    this.buf = new Float32Array(size);
    this.idx = 0;
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
  }

  render(blockSize) {
    const master = this.params.master ?? 0.8;
    this.outL.fill(0);
    this.outR.fill(0);
    for (let ch = 1; ch <= 4; ch++) {
      const lvl = this.params[`lvl${ch}`] ?? 0.8;
      if (lvl === 0) continue;
      const pan = this.params[`pan${ch}`] ?? 0;
      // Equal-power pan law.
      const angle = ((pan + 1) * Math.PI) / 4;
      const gL = lvl * Math.cos(angle);
      const gR = lvl * Math.sin(angle);
      const input = this.inputs[`in${ch}`];
      for (let i = 0; i < blockSize; i++) {
        this.outL[i] += input.L[i] * gL;
        this.outR[i] += input.R[i] * gR;
      }
    }
    for (let i = 0; i < blockSize; i++) {
      this.outL[i] *= master;
      this.outR[i] *= master;
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
          } else if (m.type === 'synth') {
            next.set(m.id, new SynthModule(m.id, m.params));
          } else if (m.type === 'sampler') {
            next.set(m.id, new SamplerModule(m.id, m.params));
          } else if (m.type === 'drum') {
            next.set(m.id, new DrumModule(m.id, m.params, m.data));
          } else if (m.type === 'levels') {
            next.set(m.id, new LevelsModule(m.id, m.params));
          } else if (m.type === 'visualizer') {
            next.set(m.id, new VisualizerModule(m.id, m.params));
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
          }
        }
        this.modules = next;
        const valid = (w) => this.modules.has(w.fromModuleId) && this.modules.has(w.toModuleId);
        this.audioWires = msg.wires.filter((w) => w.type === 'audio' && valid(w));
        this.noteWires = msg.wires.filter((w) => w.type === 'note' && valid(w));
        this.controlWires = msg.wires.filter((w) => w.type === 'control' && valid(w));
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
            if (mod.type === 'drum') mod.resetSteps();
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
        if (mod && mod.type === 'sampler') mod.setSample(msg.sampleRate, msg.channels, msg.loopStart, msg.loopEnd);
        else if (mod && mod.type === 'drum') mod.setSample(msg.pad || 0, msg.sampleRate, msg.channels);
        else if (mod && mod.type === 'synth') mod.setWavetable(msg.channels);
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
    }
  }

  routeNoteOn(srcId, voiceId, pitch, velocity, fromPortId) {
    for (const w of this.noteWires) {
      if (w.fromModuleId !== srcId) continue;
      // Multi-out sources (composer tracks) route per output port.
      if (fromPortId && w.fromPortId && w.fromPortId !== fromPortId) continue;
      const target = this.modules.get(w.toModuleId);
      if (target && target.noteOn) target.noteOn(voiceId, pitch, velocity);
    }
    this.noteActivity.add(srcId);
  }

  routeNoteOff(srcId, voiceId) {
    for (const w of this.noteWires) {
      if (w.fromModuleId !== srcId) continue;
      const target = this.modules.get(w.toModuleId);
      if (target && target.noteOff) target.noteOff(voiceId);
    }
  }

  /**
   * Kahn's algorithm over audio wires. Cycles can't be built yet in Phase 0;
   * if one appears, remaining modules append in arbitrary order and read the
   * previous block's buffers — the one-block feedback delay of PRD §9.3.
   */
  topoSort() {
    const inDegree = new Map();
    for (const id of this.modules.keys()) inDegree.set(id, 0);
    for (const w of this.audioWires) inDegree.set(w.toModuleId, inDegree.get(w.toModuleId) + 1);
    const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    const order = [];
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const w of this.audioWires) {
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
      if (mod.type === 'drum') {
        this.runDrum(mod, blockEnd);
        continue;
      }
      if (mod.type === 'arp') {
        this.runArp(mod, blockSize, blockEnd);
        continue;
      }
      if (mod.type === 'composer') {
        this.runComposer(mod, blockEnd);
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

  /** Advance one composer across this block: song slot → pattern → step. */
  runComposer(mod, blockEnd) {
    const t = this.transport;

    mod.activeNotes = mod.activeNotes.filter((n) => {
      if (n.offAtSample <= blockEnd) {
        this.routeNoteOff(mod.id, n.voiceId);
        return false;
      }
      return true;
    });

    if (!t.playing) return;
    const patterns = (mod.data && mod.data.patterns) || [];
    const song = (mod.data && mod.data.song) || [];
    if (patterns.length === 0 || song.length === 0) return;

    const idx = Math.floor(t.posBeats * 4); // sixteenths
    if (idx === mod.lastStepIndex) return;
    mod.lastStepIndex = idx;

    const bar = Math.floor(idx / 16);
    const slot = ((bar % song.length) + song.length) % song.length;
    const pIdx = song[slot];
    if (pIdx === undefined || pIdx < 0) return;
    const pattern = patterns[pIdx];
    if (!pattern) return;
    const step = ((idx % 16) + 16) % 16;

    const gate = mod.params.gate ?? 0.5;
    const stepDurSamples = (60 / t.tempo / 4) * sampleRate;
    for (let track = 0; track < pattern.length; track++) {
      const st = pattern[track][step];
      if (!st || !st.on) continue;
      const voiceId = this.nextVoiceId++;
      this.routeNoteOn(mod.id, voiceId, st.pitch, 0.9, `out${track + 1}`);
      mod.activeNotes.push({ voiceId, offAtSample: this.sampleCount + stepDurSamples * gate });
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
  runDrum(mod, blockEnd) {
    const t = this.transport;

    // Fire swing-delayed hits that fall inside this block.
    mod.pendingHits = mod.pendingHits.filter((h) => {
      if (h.atSample <= blockEnd) {
        mod.trigger(h.pad, h.vel);
        this.noteActivity.add(mod.id);
        return false;
      }
      return true;
    });

    if (!t.playing) return;
    const pattern = (mod.data && mod.data.pattern) || [];
    if (pattern.length === 0) return;

    const spb = mod.stepsPerBeat();
    const idx = Math.floor(t.posBeats * spb);
    if (idx === mod.lastStepIndex) return;
    mod.lastStepIndex = idx;
    const stepCount = (pattern[0] || []).length || 16;
    const step = ((idx % stepCount) + stepCount) % stepCount;
    mod.currentStep = step;

    // Swing: off-beat steps land late by swing × step duration.
    const stepDurSamples = (60 / t.tempo / spb) * sampleRate;
    const delay = step % 2 === 1 ? (mod.params.swing || 0) * stepDurSamples : 0;

    for (let pad = 0; pad < pattern.length; pad++) {
      const st = pattern[pad][step];
      if (!st || !st.on) continue;
      if (delay > 0) {
        mod.pendingHits.push({ atSample: this.sampleCount + delay, pad, vel: st.vel });
      } else {
        mod.trigger(pad, st.vel);
        this.noteActivity.add(mod.id);
      }
    }
  }

  /** Push LFO values along control wires into target modules' control inputs. */
  applyControlWires() {
    for (const w of this.controlWires) {
      const src = this.modules.get(w.fromModuleId);
      const dst = this.modules.get(w.toModuleId);
      if (!src || !dst || src.value === undefined || !dst.controlIn) continue;
      dst.controlIn[w.toPortId] = src.value;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const blockSize = out[0].length;
    out[0].fill(0);
    if (out[1]) out[1].fill(0);

    this.runSequencers(blockSize);
    // Control wires once per block: synth mod inputs, MIDI Out CC, etc.
    this.applyControlWires();

    for (const id of this.order) {
      const mod = this.modules.get(id);
      if (!mod) continue;

      // Sum incoming audio wires into the module's per-port input buffers.
      if (mod.inputs) {
        for (const key in mod.inputs) {
          mod.inputs[key].L.fill(0);
          mod.inputs[key].R.fill(0);
        }
        for (const w of this.audioWires) {
          if (w.toModuleId !== id) continue;
          const src = this.modules.get(w.fromModuleId);
          const dst = mod.inputs[w.toPortId];
          if (!src || !src.outL || !dst) continue;
          for (let i = 0; i < blockSize; i++) {
            dst.L[i] += src.outL[i];
            dst.R[i] += src.outR[i];
          }
        }
      }

      if (mod.type === 'lfo' || mod.type === 'adsr' || mod.type === 'random') {
        mod.render(blockSize);
        continue;
      }
      if (mod.type === 'sequencer' || mod.type === 'arp' || mod.type === 'composer' || mod.type === 'midiIn') continue;
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
    }

    const now = currentTime;
    if (now - this.lastStatusTime < STATUS_INTERVAL_S) return;
    this.lastStatusTime = now;

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
    for (const mod of this.modules.values()) {
      if (mod.type === 'sequencer' || mod.type === 'drum') seqSteps[mod.id] = mod.currentStep;
      if (mod.value !== undefined) controlValues[mod.id] = mod.value;
      if (mod.grDb !== undefined) gainReduction[mod.id] = mod.grDb;
      if (mod.type === 'peq') spectra[mod.id] = mod.spectrum();
      if (mod.type === 'visualizer') visData[mod.id] = mod.visData();
    }

    this.port.postMessage({
      type: 'status',
      meters,
      seqSteps,
      controlValues,
      gainReduction,
      spectra,
      visData,
      noteActivity: [...this.noteActivity],
      songPosition: this.transport.posBeats,
    });
    this.noteActivity.clear();
  }
}

registerProcessor('kabelkraft-engine', EngineProcessor);
