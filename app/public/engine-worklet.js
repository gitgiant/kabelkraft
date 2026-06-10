/**
 * KabelKraft audio engine v0 — runs inside an AudioWorklet.
 *
 * Plain JS (no bundler involvement) so it loads identically in dev and build.
 * Mirrors the audio-relevant subset of the patch graph: synth modules render
 * polyphonic voices, levels modules meter, audioOut sums into the device
 * output behind a default-on safety limiter (PRD §9.4).
 *
 * Message protocol: see src/engine/messages.ts.
 */

const MAX_VOICES = 16;
const LIMITER_CEILING = 0.95;
const METER_INTERVAL_S = 1 / 30;

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
    this.voices = [];
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice());
    this.outL = new Float32Array(128);
    this.outR = new Float32Array(128);
  }

  noteOn(voiceId, pitch, velocity) {
    let voice = this.voices.find((v) => !v.active);
    if (!voice) {
      // Steal the oldest voice.
      voice = this.voices.reduce((a, b) => (a.age > b.age ? a : b));
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

    this.outL.fill(0);
    const atkStep = 1 / (attack * sampleRate);
    const decStep = 1 / (decay * sampleRate);
    const relStep = 1 / (release * sampleRate);

    for (const v of this.voices) {
      if (!v.active) continue;
      const freq = 440 * Math.pow(2, (v.pitch + octave * 12 - 69) / 12);
      const phaseStep = freq / sampleRate;
      for (let i = 0; i < blockSize; i++) {
        // Envelope
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

        // Oscillator
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
    /** Audio wires: { fromModuleId, toModuleId } */
    this.wires = [];
    this.lastMeterTime = 0;
    this.clipLatch = new Map();
    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'graph': {
        const next = new Map();
        for (const m of msg.modules) {
          const existing = this.modules.get(m.id);
          if (existing && existing.type === m.type) {
            existing.params = m.params; // keep voice/limiter state across rewires
            next.set(m.id, existing);
          } else if (m.type === 'synth') {
            next.set(m.id, new SynthModule(m.id, m.params));
          } else if (m.type === 'levels') {
            next.set(m.id, new LevelsModule(m.id, m.params));
          } else if (m.type === 'audioOut') {
            next.set(m.id, new AudioOutModule(m.id, m.params));
          }
        }
        this.modules = next;
        this.wires = msg.wires.filter(
          (w) => this.modules.has(w.fromModuleId) && this.modules.has(w.toModuleId),
        );
        this.order = this.topoSort();
        break;
      }
      case 'param': {
        const mod = this.modules.get(msg.moduleId);
        if (mod) mod.params[msg.paramId] = msg.value;
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

  /**
   * Kahn's algorithm over audio wires. Cycles can't be built yet in Phase 0;
   * if one appears, remaining modules append in arbitrary order and read the
   * previous block's buffers — the one-block feedback delay of PRD §9.3.
   */
  topoSort() {
    const inDegree = new Map();
    for (const id of this.modules.keys()) inDegree.set(id, 0);
    for (const w of this.wires) inDegree.set(w.toModuleId, inDegree.get(w.toModuleId) + 1);
    const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    const order = [];
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const w of this.wires) {
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

  process(_inputs, outputs) {
    const out = outputs[0];
    const blockSize = out[0].length;
    out[0].fill(0);
    if (out[1]) out[1].fill(0);

    for (const id of this.order) {
      const mod = this.modules.get(id);
      if (!mod) continue;

      // Sinks/processors: sum incoming wires into the module's buffers first.
      if (mod.type === 'audioOut' || mod.type === 'levels') {
        mod.outL.fill(0);
        mod.outR.fill(0);
        for (const w of this.wires) {
          if (w.toModuleId !== id) continue;
          const src = this.modules.get(w.fromModuleId);
          if (!src) continue;
          for (let i = 0; i < blockSize; i++) {
            mod.outL[i] += src.outL[i];
            mod.outR[i] += src.outR[i];
          }
        }
      }

      mod.render(blockSize);

      if (mod.type === 'audioOut') {
        for (let i = 0; i < blockSize; i++) {
          out[0][i] += mod.outL[i];
          if (out[1]) out[1][i] += mod.outR[i];
        }
      }
    }

    this.postMeters(blockSize);
    return true;
  }

  postMeters(blockSize) {
    const now = currentTime;
    // Track clip latches every block so brief peaks aren't missed between posts.
    for (const mod of this.modules.values()) {
      let peak = 0;
      for (let i = 0; i < blockSize; i++) {
        const a = Math.abs(mod.outL[i]);
        if (a > peak) peak = a;
      }
      const prev = this.clipLatch.get(mod.id) || { peak: 0, sumSq: 0, n: 0, clipped: false };
      let sumSq = prev.sumSq;
      for (let i = 0; i < blockSize; i++) sumSq += mod.outL[i] * mod.outL[i];
      this.clipLatch.set(mod.id, {
        peak: Math.max(prev.peak, peak),
        sumSq,
        n: prev.n + blockSize,
        clipped: prev.clipped || peak > 1,
      });
    }

    if (now - this.lastMeterTime < METER_INTERVAL_S) return;
    this.lastMeterTime = now;
    const meters = {};
    for (const [id, acc] of this.clipLatch) {
      meters[id] = {
        peak: acc.peak,
        rms: acc.n ? Math.sqrt(acc.sumSq / acc.n) : 0,
        clipped: acc.clipped,
      };
    }
    this.clipLatch.clear();
    this.port.postMessage({ type: 'meters', meters });
  }
}

registerProcessor('kabelkraft-engine', EngineProcessor);
