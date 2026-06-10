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

class Voice {
  constructor() {
    this.active = false;
    this.voiceId = -1;
    this.pitch = 60;
    this.velocity = 1;
    this.phase = 0;
    this.stage = 'off'; // attack | decay | sustain | release | off
    this.env = 0;
    this.age = 0;
  }

  noteOn(voiceId, pitch, velocity) {
    this.active = true;
    this.voiceId = voiceId;
    this.pitch = pitch;
    this.velocity = velocity;
    this.stage = 'attack';
    this.age = 0;
    // env continues from current level for click-free retrigger
  }

  noteOff() {
    if (this.stage !== 'off') this.stage = 'release';
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
  }

  noteOn(voiceId, pitch, velocity) {
    let voice = this.voices.find((v) => !v.active);
    if (!voice) {
      voice = this.voices.reduce((a, b) => (a.age > b.age ? a : b)); // steal oldest
    }
    voice.noteOn(voiceId, pitch, velocity);
  }

  noteOff(voiceId) {
    for (const v of this.voices) {
      if (v.active && v.voiceId === voiceId) v.noteOff();
    }
  }

  render(blockSize) {
    const p = this.params;
    const wave = Math.round(p.waveform ?? WAVE_SAW);
    const octave = Math.round(p.octave ?? 0);
    const attack = Math.max(0.001, p.attack ?? 0.01);
    const decay = Math.max(0.001, p.decay ?? 0.15);
    const sustain = p.sustain ?? 0.7;
    const release = Math.max(0.001, p.release ?? 0.3);
    const level = p.level ?? 0.8;
    // Control input: pitchMod 0..1 maps to ±pmAmt semitones around center.
    const pmAmt = p.pmAmt ?? 2;
    const pitchModSemis =
      this.controlIn.pitchMod !== undefined ? (this.controlIn.pitchMod - 0.5) * 2 * pmAmt : 0;

    this.outL.fill(0);
    const atkStep = 1 / (attack * sampleRate);
    const decStep = 1 / (decay * sampleRate);
    const relStep = 1 / (release * sampleRate);

    for (const v of this.voices) {
      if (!v.active) continue;
      const freq = 440 * Math.pow(2, (v.pitch + octave * 12 + pitchModSemis - 69) / 12);
      const phaseStep = freq / sampleRate;
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

        let sample;
        const ph = v.phase;
        switch (wave) {
          case WAVE_SINE: sample = Math.sin(2 * Math.PI * ph); break;
          case WAVE_TRIANGLE: sample = 4 * Math.abs(ph - 0.5) - 1; break;
          case WAVE_SQUARE: sample = ph < 0.5 ? 1 : -1; break;
          case WAVE_NOISE: sample = Math.random() * 2 - 1; break;
          case WAVE_SAW:
          default: sample = 2 * ph - 1; break;
        }
        v.phase += phaseStep;
        if (v.phase >= 1) v.phase -= 1;

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

class LevelsModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'levels';
    this.params = params;
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
  }

  render() {
    // Metering only; input buffers were summed into outL/outR by the host.
  }
}

class AudioOutModule {
  constructor(id, params) {
    this.id = id;
    this.type = 'audioOut';
    this.params = params;
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
    this.limiterEnv = 0;
  }

  render(blockSize) {
    const level = this.params.level ?? 0.8;
    const limiterOn = (this.params.limiter ?? 1) >= 0.5;
    const releaseCoef = Math.exp(-1 / (0.08 * sampleRate)); // ~80 ms release
    for (let i = 0; i < blockSize; i++) {
      let l = this.outL[i] * level;
      let r = this.outR[i] * level;
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
          } else if (m.type === 'levels') {
            next.set(m.id, new LevelsModule(m.id, m.params));
          } else if (m.type === 'audioOut') {
            next.set(m.id, new AudioOutModule(m.id, m.params));
          } else if (m.type === 'lfo') {
            next.set(m.id, new LfoModule(m.id, m.params));
          } else if (m.type === 'sequencer') {
            next.set(m.id, new SequencerModule(m.id, m.params, m.data));
          }
        }
        this.modules = next;
        const valid = (w) => this.modules.has(w.fromModuleId) && this.modules.has(w.toModuleId);
        this.audioWires = msg.wires.filter((w) => w.type === 'audio' && valid(w));
        this.noteWires = msg.wires.filter((w) => w.type === 'note' && valid(w));
        this.controlWires = msg.wires.filter((w) => w.type === 'control' && valid(w));
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
            if (mod.type === 'sequencer') {
              mod.allNotesOff((srcId, voiceId) => this.routeNoteOff(srcId, voiceId));
            }
          }
        }
        break;
      }
      case 'noteOn': {
        const mod = this.modules.get(msg.moduleId);
        if (mod && mod.type === 'synth') mod.noteOn(msg.voiceId, msg.pitch, msg.velocity);
        break;
      }
      case 'noteOff': {
        const mod = this.modules.get(msg.moduleId);
        if (mod && mod.type === 'synth') mod.noteOff(msg.voiceId);
        break;
      }
    }
  }

  routeNoteOn(srcId, voiceId, pitch, velocity) {
    for (const w of this.noteWires) {
      if (w.fromModuleId !== srcId) continue;
      const target = this.modules.get(w.toModuleId);
      if (target && target.type === 'synth') target.noteOn(voiceId, pitch, velocity);
    }
    this.noteActivity.add(srcId);
  }

  routeNoteOff(srcId, voiceId) {
    for (const w of this.noteWires) {
      if (w.fromModuleId !== srcId) continue;
      const target = this.modules.get(w.toModuleId);
      if (target && target.type === 'synth') target.noteOff(voiceId);
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

    for (const id of this.order) {
      const mod = this.modules.get(id);
      if (!mod) continue;

      if (mod.type === 'audioOut' || mod.type === 'levels') {
        mod.outL.fill(0);
        mod.outR.fill(0);
        for (const w of this.audioWires) {
          if (w.toModuleId !== id) continue;
          const src = this.modules.get(w.fromModuleId);
          if (!src || !src.outL) continue;
          for (let i = 0; i < blockSize; i++) {
            mod.outL[i] += src.outL[i];
            mod.outR[i] += src.outR[i];
          }
        }
      }

      if (mod.type === 'lfo') {
        mod.render(blockSize);
        continue;
      }
      if (mod.type === 'sequencer') continue;

      if (mod.type === 'synth') this.applyControlWires();
      mod.render(blockSize);

      if (mod.type === 'audioOut') {
        for (let i = 0; i < blockSize; i++) {
          out[0][i] += mod.outL[i];
          if (out[1]) out[1][i] += mod.outR[i];
        }
      }
    }

    this.sampleCount += blockSize;
    this.postStatus(blockSize);
    return true;
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
    for (const mod of this.modules.values()) {
      if (mod.type === 'sequencer') seqSteps[mod.id] = mod.currentStep;
      if (mod.type === 'lfo') controlValues[mod.id] = mod.value;
    }

    this.port.postMessage({
      type: 'status',
      meters,
      seqSteps,
      controlValues,
      noteActivity: [...this.noteActivity],
      songPosition: this.transport.posBeats,
    });
    this.noteActivity.clear();
  }
}

registerProcessor('kabelkraft-engine', EngineProcessor);
