import { describe, expect, it } from 'vitest';
import {
  copy,
  crossfadeLoop,
  fadeIn,
  fadeOut,
  insert,
  normalize,
  pitchShift,
  remove,
  reverse,
  timeStretch,
  trim,
} from './sampleops';

function ramp(n = 100): Float32Array[] {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = i / n;
  return [c];
}

describe('sample ops', () => {
  it('trim keeps only the region', () => {
    const out = trim(ramp(), { start: 20, end: 60 });
    expect(out[0].length).toBe(40);
    expect(out[0][0]).toBeCloseTo(0.2);
  });

  it('remove deletes the region and joins the rest', () => {
    const out = remove(ramp(), { start: 20, end: 60 });
    expect(out[0].length).toBe(60);
    expect(out[0][19]).toBeCloseTo(0.19);
    expect(out[0][20]).toBeCloseTo(0.6);
  });

  it('copy + insert round-trips', () => {
    const src = ramp();
    const clip = copy(src, { start: 10, end: 20 });
    expect(clip[0].length).toBe(10);
    const out = insert(src, 0, clip);
    expect(out[0].length).toBe(110);
    expect(out[0][0]).toBeCloseTo(0.1);
    expect(out[0][10]).toBeCloseTo(0); // original starts after the clip
  });

  it('insert reconciles mono clip into stereo target', () => {
    const stereo = [new Float32Array(10), new Float32Array(10)];
    const out = insert(stereo, 5, [new Float32Array([0.5, 0.5])]);
    expect(out).toHaveLength(2);
    expect(out[1][5]).toBeCloseTo(0.5);
  });

  it('normalize scales the peak to the target', () => {
    const out = normalize([new Float32Array([0.1, -0.25, 0.2])]);
    let peak = 0;
    for (const v of out[0]) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeCloseTo(0.95);
  });

  it('normalize touches only the region when given one', () => {
    const out = normalize([new Float32Array([0.1, 0.1, 0.1, 0.1])], { start: 2, end: 4 });
    expect(out[0][0]).toBeCloseTo(0.1);
    expect(out[0][3]).toBeCloseTo(0.95);
  });

  it('reverse flips the whole sample', () => {
    const out = reverse(ramp());
    expect(out[0][0]).toBeCloseTo(0.99);
    expect(out[0][99]).toBeCloseTo(0);
  });

  it('reverse flips only the region when given one', () => {
    const out = reverse(ramp(), { start: 0, end: 50 });
    expect(out[0][0]).toBeCloseTo(0.49);
    expect(out[0][99]).toBeCloseTo(0.99); // untouched tail
  });

  it('fades hit silence at their quiet end', () => {
    const ones = [new Float32Array(100).fill(1)];
    const fin = fadeIn(ones);
    expect(fin[0][0]).toBeCloseTo(0);
    expect(fin[0][99]).toBeCloseTo(0.99);
    const fout = fadeOut(ones);
    expect(fout[0][0]).toBeCloseTo(0.99);
    expect(fout[0][99]).toBeCloseTo(0);
  });

  it('pitch shift up shortens, down lengthens (tape-style)', () => {
    const up = pitchShift(ramp(1000), 12);
    expect(up[0].length).toBe(500);
    const down = pitchShift(ramp(1000), -12);
    expect(down[0].length).toBe(2000);
  });

  it('time stretch changes length, not content scale', () => {
    const n = 44100;
    const sine = new Float32Array(n);
    for (let i = 0; i < n; i++) sine[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.5;
    const out = timeStretch([sine], 2);
    expect(out[0].length).toBe(n * 2);
    // Mid-buffer amplitude stays in the same ballpark (windows sum to ~1).
    let peak = 0;
    for (let i = n; i < n + 4410; i++) peak = Math.max(peak, Math.abs(out[0][i]));
    expect(peak).toBeGreaterThan(0.3);
    expect(peak).toBeLessThan(0.7);
  });

  it('crossfadeLoop blends the seam and keeps length', () => {
    const src = ramp(1000);
    const out = crossfadeLoop(src, 200, 800, 100);
    expect(out[0].length).toBe(1000);
    // End of loop now contains material blended toward pre-loopStart values.
    expect(out[0][799]).toBeLessThan(src[0][799]);
    expect(out[0][99]).toBeCloseTo(src[0][99]); // outside the fade untouched
  });

  it('ops never mutate their input', () => {
    const src = ramp();
    const before = src[0].slice();
    reverse(src);
    normalize(src);
    fadeOut(src);
    trim(src, { start: 10, end: 20 });
    expect(src[0]).toEqual(before);
  });
});
