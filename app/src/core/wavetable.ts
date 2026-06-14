/**
 * Wavetable frame math, duplicated UI-side for the Wavetable Osc display.
 * MUST stay in sync with WtoscModule in public/engine-worklet.js
 * (buildWavetable / defaultWavetable / readWt). The worklet owns playback;
 * this only feeds the on-tile drawing.
 */

export const WT_FRAME = 2048;

export interface WtTable {
  data: Float32Array;
  frames: number;
}

/** Split raw PCM into 2048-sample frames; short PCM becomes a single cycle. */
export function buildWavetable(pcm: Float32Array | undefined): WtTable | null {
  if (!pcm || pcm.length === 0) return null;
  if (pcm.length >= WT_FRAME) {
    const frames = Math.max(1, Math.floor(pcm.length / WT_FRAME));
    return { data: pcm.subarray(0, frames * WT_FRAME), frames };
  }
  const data = new Float32Array(WT_FRAME);
  for (let i = 0; i < WT_FRAME; i++) {
    const pos = (i / WT_FRAME) * pcm.length;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    data[i] = pcm[i0] * (1 - frac) + pcm[(i0 + 1) % pcm.length] * frac;
  }
  return { data, frames: 1 };
}

/** Built-in 8-frame harmonic sweep (sine → richer sawtooth-ish spectra). */
export function defaultWavetable(): WtTable {
  const frames = 8;
  const data = new Float32Array(frames * WT_FRAME);
  for (let f = 0; f < frames; f++) {
    const harmonics = 1 + f * 3;
    let peak = 0;
    for (let i = 0; i < WT_FRAME; i++) {
      const ph = (i / WT_FRAME) * 2 * Math.PI;
      let s = 0;
      for (let h = 1; h <= harmonics; h++) s += Math.sin(h * ph) / h;
      data[f * WT_FRAME + i] = s;
      const a = Math.abs(s);
      if (a > peak) peak = a;
    }
    if (peak > 0) {
      const g = 0.9 / peak;
      for (let i = 0; i < WT_FRAME; i++) data[f * WT_FRAME + i] *= g;
    }
  }
  return { data, frames };
}

/** Decimate a single frame (at fractional frame index) to `n` points in [-1,1]. */
export function framePoints(wt: WtTable, framePosNorm: number, n: number): Float32Array {
  const framePos = Math.min(1, Math.max(0, framePosNorm)) * (wt.frames - 1);
  const f0 = Math.floor(framePos);
  const f1 = Math.min(wt.frames - 1, f0 + 1);
  const fFrac = framePos - f0;
  const f0b = f0 * WT_FRAME;
  const f1b = f1 * WT_FRAME;
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const i = Math.min(WT_FRAME - 1, Math.round((k / (n - 1)) * (WT_FRAME - 1)));
    out[k] = wt.data[f0b + i] * (1 - fFrac) + wt.data[f1b + i] * fFrac;
  }
  return out;
}
