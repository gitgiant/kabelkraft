/**
 * Engine audio smoke test — drives the real AudioWorklet processor
 * (public/engine-worklet.js) inside Node, no browser needed: builds the
 * boot starter patches from registry defaults, presses play, and asserts
 * the output buffers carry signal. Catches "patch is silent" regressions
 * that unit tests of individual helpers can't see.
 */

/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { MODULE_DEFS } from '../core/registry';

const WORKLET_PATH = fileURLToPath(new URL('../../public/engine-worklet.js', import.meta.url));
const SAMPLE_RATE = 48000;
const BLOCK = 128;

interface FakePort {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage: (msg: unknown) => void;
  sent: unknown[];
}

interface Processor {
  port: FakePort;
  process(inputs: unknown[][], outputs: Float32Array[][], parameters: object): boolean;
}

/** Load the worklet source in an isolated VM realm and hand back the class. */
function loadProcessor(): { proc: Processor; sandbox: { currentTime: number } } {
  const registered = { cls: null as (new () => Processor) | null };
  const port: FakePort = { onmessage: null, sent: [], postMessage: (m) => port.sent.push(m) };
  class AudioWorkletProcessor {
    port = port;
  }
  const sandbox = {
    sampleRate: SAMPLE_RATE,
    currentTime: 0,
    AudioWorkletProcessor,
    registerProcessor: (_name: string, cls: new () => Processor) => {
      registered.cls = cls;
    },
    Date,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(WORKLET_PATH, 'utf8'), sandbox, { filename: 'engine-worklet.js' });
  if (!registered.cls) throw new Error('worklet did not register a processor');
  return { proc: new registered.cls(), sandbox };
}

/** Module snapshot exactly as engine.ts syncGraph would send it. */
function mod(type: string, id: string, overrides: Record<string, number> = {}) {
  const def = MODULE_DEFS.get(type);
  if (!def) throw new Error(`unknown module type ${type}`);
  const params: Record<string, number> = {};
  for (const p of def.params) params[p.id] = p.default;
  Object.assign(params, overrides);
  return { id, type, params, data: def.defaultData?.() };
}

type Snapshot = ReturnType<typeof mod>;

/** Wire snapshot; the type comes from the sending port, like the real graph. */
function wire(from: Snapshot, fromPort: string, to: Snapshot, toPort: string) {
  const port = MODULE_DEFS.get(from.type)!.ports.find(
    (p) => p.id === fromPort && p.direction === 'out',
  );
  if (!port) throw new Error(`${from.type} has no output port ${fromPort}`);
  return {
    type: port.type,
    fromModuleId: from.id,
    fromPortId: fromPort,
    toModuleId: to.id,
    toPortId: toPort,
  };
}

/** Run the patch for `seconds` of audio; return the peak output amplitude. */
function renderPeak(modules: Snapshot[], wires: ReturnType<typeof wire>[], seconds = 3): number {
  const { proc, sandbox } = loadProcessor();
  const send = (msg: unknown) => proc.port.onmessage!({ data: msg });
  send({ type: 'graph', modules, wires });
  send({ type: 'transport', playing: true, tempo: 120, songPosition: 0 });

  const inputs = [[], [], [], []];
  let peak = 0;
  const blocks = Math.ceil((seconds * SAMPLE_RATE) / BLOCK);
  for (let b = 0; b < blocks; b++) {
    const L = new Float32Array(BLOCK);
    const R = new Float32Array(BLOCK);
    proc.process(inputs, [[L, R]], {});
    for (let i = 0; i < BLOCK; i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (a > peak) peak = a;
    }
    sandbox.currentTime += BLOCK / SAMPLE_RATE;
  }
  return peak;
}

describe('engine worklet produces audio (boot starters, headless)', () => {
  it('drum-synth idiom: sequencer-gated ADSR opens a VCA over a free osc', () => {
    const seq = mod('sequencer', 'seq1', { gate: 0.05 });
    seq.data = { steps: Array.from({ length: 16 }, () => ({ on: true, pitch: 60 })) };
    const env = mod('envelope', 'env1', { attack: 0.001, decay: 0.01, sustain: 1, release: 0.45 });
    const osc = mod('osc', 'osc1', { wave: 0 });
    const vca = mod('vca', 'vca1', { level: 0.9 });
    const out = mod('audioOut', 'out1');
    const peak = renderPeak(
      [seq, env, osc, vca, out],
      [
        wire(seq, 'notes', env, 'notes'),
        wire(env, 'out', vca, 'cv'),
        wire(osc, 'out', vca, 'in'),
        wire(vca, 'out', out, 'in'),
      ],
    );
    expect(peak).toBeGreaterThan(0.01);
  });

  it('boot patch: composer-driven component poly synth (voice/osc/vcf/vca)', () => {
    const composer = mod('composer', 'cmp1');
    const voice = mod('voice', 'voi1');
    const oscs = [1, 2, 3, 4].map((i) => mod('osc', `osc${i}`));
    const adsrA = mod('envelope', 'envA');
    const adsrF = mod('envelope', 'envF', { decay: 0.35, sustain: 0.25 });
    const vcf = mod('vcf', 'vcf1', { cutoff: 900, amt: 2.5 });
    const vca = mod('vca', 'vca1');
    const delay = mod('delay', 'dly1', { mix: 0.2 });
    const reverb = mod('reverb', 'rev1', { mix: 0.25 });
    const out = mod('audioOut', 'out1');

    const wires = [
      wire(composer, 'notes', voice, 'notes'),
      ...oscs.flatMap((osc) => [wire(voice, 'pitch', osc, 'pitch'), wire(osc, 'out', vcf, 'in')]),
      wire(voice, 'gate', adsrA, 'gate'),
      wire(voice, 'gate', adsrF, 'gate'),
      wire(adsrF, 'out', vcf, 'mod'),
      wire(vcf, 'out', vca, 'in'),
      wire(adsrA, 'out', vca, 'cv'),
      wire(vca, 'out', delay, 'in'),
      wire(delay, 'out', reverb, 'in'),
      wire(reverb, 'out', out, 'in'),
    ];
    const peak = renderPeak([composer, voice, ...oscs, adsrA, adsrF, vcf, vca, delay, reverb, out], wires);
    expect(peak).toBeGreaterThan(0.01);
  });

  it('pluck: sequencer-gated Karplus string rings (voice pitch + gate)', () => {
    const seq = mod('sequencer', 'seq1', { gate: 0.1 });
    seq.data = { steps: Array.from({ length: 16 }, () => ({ on: true, pitch: 57 })) };
    const voice = mod('voice', 'voi1', { voices: 2 });
    const pluck = mod('pluck', 'plk1', { decay: 4, damp: 0.2 });
    const out = mod('audioOut', 'out1');
    const peak = renderPeak(
      [seq, voice, pluck, out],
      [
        wire(seq, 'notes', voice, 'notes'),
        wire(voice, 'pitch', pluck, 'pitch'),
        wire(voice, 'gate', pluck, 'gate'),
        wire(pluck, 'out', out, 'in'),
      ],
    );
    expect(peak).toBeGreaterThan(0.01);
  });

  it('resonator: a noise oscillator drives a tuned waveguide comb', () => {
    const osc = mod('osc', 'osc1', { wave: 4, level: 0.5 }); // noise
    const res = mod('resonator', 'res1', { decay: 0.99, mix: 1 });
    const out = mod('audioOut', 'out1');
    const peak = renderPeak(
      [osc, res, out],
      [wire(osc, 'out', res, 'in'), wire(res, 'out', out, 'in')],
      1,
    );
    expect(peak).toBeGreaterThan(0.01);
  });

  it('addosc: additive partial bank drones; high pitch stays finite (Nyquist drop)', () => {
    const add = mod('addosc', 'add1', { partials: 64, octave: 3, semi: 11 });
    const out = mod('audioOut', 'out1');
    const peak = renderPeak([add, out], [wire(add, 'out', out, 'in')], 1);
    expect(Number.isFinite(peak)).toBe(true);
    expect(peak).toBeGreaterThan(0.01);
    expect(peak).toBeLessThan(2); // normalized — no runaway/clip from 64 partials
  });

  it('granular: live mode granulates an incoming oscillator into a drone', () => {
    const osc = mod('osc', 'osc1', { wave: 0, level: 0.8 });
    const gr = mod('granular', 'gr1', { source: 1, size: 60, density: 4 });
    const out = mod('audioOut', 'out1');
    const peak = renderPeak(
      [osc, gr, out],
      [wire(osc, 'out', gr, 'in'), wire(gr, 'out', out, 'in')],
      1,
    );
    expect(peak).toBeGreaterThan(0.01);
  });
});
