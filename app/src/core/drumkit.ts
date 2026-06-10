/**
 * Drum Machine data model + synthesized default kit (PRD §8.2).
 * No bundled sample pack: the default kit is rendered procedurally
 * (deterministic, seeded noise) so a fresh Drum Machine makes sound
 * immediately; every pad is replaceable with the user's own sample.
 */

import type { SampleData } from './samples';

export interface DrumPad {
  name: string;
  /** 0..1 */
  level: number;
  /** -1..1 */
  pan: number;
  /** Playback transpose in semitones, -12..12. */
  pitch: number;
  /** Choke group, 0 = off, 1..4. Triggering a pad cuts others in its group. */
  choke: number;
  /** Amp envelope attack, seconds. */
  attack: number;
  /** Amp envelope exponential decay, seconds; at max it is effectively bypassed. */
  decay: number;
}

export interface DrumStep {
  on: boolean;
  /** 0..1 */
  vel: number;
}

export const DRUM_PADS = 16;
export const DRUM_STEPS = 16;
export const DRUM_BASE_NOTE = 36; // C1, GM drum convention
export const DRUM_DECAY_MAX = 2;

const RATE = 44100;

/** Deterministic noise (PRD §9.8 spirit: fixed seeds, reproducible output). */
function makeNoise(n: number, seed = 1234567): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s / 0xffffffff) * 2 - 1;
  }
  return out;
}

/** Scale a rendered piece to a fixed peak so no pad clips or whispers. */
function normalize(buf: Float32Array, peak = 0.9): Float32Array {
  let max = 0;
  for (const v of buf) max = Math.max(max, Math.abs(v));
  if (max > 0) {
    const g = peak / max;
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
  }
  return buf;
}

function renderKick(): Float32Array {
  const n = Math.round(0.5 * RATE);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const freq = 45 + 110 * Math.exp(-t / 0.06); // pitch sweep down to the body
    phase += freq / RATE;
    out[i] = Math.sin(2 * Math.PI * phase) * Math.exp(-t / 0.18) * 0.95;
  }
  return out;
}

function renderTom(f0: number, f1: number, decay: number): Float32Array {
  const n = Math.round(0.45 * RATE);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const freq = f0 + (f1 - f0) * Math.exp(-t / 0.05);
    phase += freq / RATE;
    out[i] = Math.sin(2 * Math.PI * phase) * Math.exp(-t / decay) * 0.85;
  }
  return out;
}

function renderSnare(): Float32Array {
  const n = Math.round(0.3 * RATE);
  const out = new Float32Array(n);
  const noise = makeNoise(n, 24681357);
  let phase = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    phase += 190 / RATE;
    const tone = Math.sin(2 * Math.PI * phase) * Math.exp(-t / 0.06) * 0.45;
    const hp = noise[i] - prev; // one-zero highpass takes the boom out of the rattle
    prev = noise[i];
    out[i] = tone + hp * Math.exp(-t / 0.11) * 0.6;
  }
  return out;
}

function renderClap(): Float32Array {
  const n = Math.round(0.35 * RATE);
  const out = new Float32Array(n);
  const noise = makeNoise(n, 97531);
  const bursts = [0, 0.012, 0.026]; // classic multi-burst attack
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const hp = noise[i] - prev;
    prev = noise[i];
    let env = Math.exp(-(t - 0.026) / 0.09) * (t > 0.026 ? 1 : 0);
    for (const b of bursts) {
      if (t >= b && t < b + 0.012) env = Math.max(env, 1 - (t - b) / 0.012);
    }
    out[i] = hp * env * 0.7;
  }
  return out;
}

function renderRim(): Float32Array {
  const n = Math.round(0.08 * RATE);
  const out = new Float32Array(n);
  const noise = makeNoise(n, 1029384);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    out[i] =
      Math.sin(2 * Math.PI * 1700 * t) * Math.exp(-t / 0.01) * 0.6 +
      noise[i] * Math.exp(-t / 0.004) * 0.4;
  }
  return out;
}

function renderHat(decay: number, seed: number): Float32Array {
  const n = Math.round(Math.min(1, decay * 5) * RATE);
  const out = new Float32Array(n);
  const noise = makeNoise(n, seed);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const hp = noise[i] - prev;
    prev = noise[i];
    out[i] = hp * Math.exp(-t / decay) * 0.7;
  }
  return out;
}

interface KitPiece {
  name: string;
  choke: number;
  render(): Float32Array;
}

export const DEFAULT_KIT: KitPiece[] = [
  { name: 'Kick', choke: 0, render: renderKick },
  { name: 'Snare', choke: 0, render: renderSnare },
  { name: 'Clap', choke: 0, render: renderClap },
  { name: 'Rim', choke: 0, render: renderRim },
  { name: 'CH', choke: 1, render: () => renderHat(0.045, 555111) },
  { name: 'OH', choke: 1, render: () => renderHat(0.35, 555111) },
  { name: 'Tom L', choke: 0, render: () => renderTom(85, 150, 0.22) },
  { name: 'Tom H', choke: 0, render: () => renderTom(140, 240, 0.16) },
];

export function defaultDrumPads(): DrumPad[] {
  return Array.from({ length: DRUM_PADS }, (_, i) => ({
    name: DEFAULT_KIT[i]?.name ?? `Pad ${i + 1}`,
    level: 0.8,
    pan: 0,
    pitch: 0,
    choke: DEFAULT_KIT[i]?.choke ?? 0,
    attack: 0.001,
    decay: DRUM_DECAY_MAX, // bypass: the baked sample tail defines the sound
  }));
}

export function defaultDrumPattern(): DrumStep[][] {
  const pattern = Array.from({ length: DRUM_PADS }, () =>
    Array.from({ length: DRUM_STEPS }, () => ({ on: false, vel: 0.8 })),
  );
  // Starter beat so play immediately grooves: kick / snare / 8th hats.
  for (const s of [0, 8]) pattern[0][s] = { on: true, vel: 1 };
  for (const s of [4, 12]) pattern[1][s] = { on: true, vel: 0.9 };
  for (let s = 0; s < DRUM_STEPS; s += 2) pattern[4][s] = { on: true, vel: s % 4 === 0 ? 0.7 : 0.5 };
  return pattern;
}

/** PCM for the synthesized default kit, indexed by pad (null = empty slot). */
export function renderDefaultKit(): (SampleData | null)[] {
  return Array.from({ length: DRUM_PADS }, (_, i) => {
    const piece = DEFAULT_KIT[i];
    if (!piece) return null;
    return { name: piece.name, sampleRate: RATE, channels: [normalize(piece.render())] };
  });
}
