import { describe, expect, it } from 'vitest';
import { bandCoefs, biquadResponseDb, chainResponseDb } from './eqmath';

const SR = 48000;

describe('eq response math', () => {
  it('zero-gain peak bands are flat', () => {
    const bands = [bandCoefs(0, 1000, 0, 0.9, SR), bandCoefs(0, 5000, 0, 2, SR)];
    for (const f of [50, 200, 1000, 5000, 15000]) {
      expect(Math.abs(chainResponseDb(bands, f, SR))).toBeLessThan(0.01);
    }
  });

  it('a +12 dB peak boosts its center and leaves far bands alone', () => {
    const band = bandCoefs(0, 1000, 12, 1.5, SR);
    expect(biquadResponseDb(band, 1000, SR)).toBeCloseTo(12, 0);
    expect(Math.abs(biquadResponseDb(band, 60, SR))).toBeLessThan(1);
    expect(Math.abs(biquadResponseDb(band, 15000, SR))).toBeLessThan(1);
  });

  it('lo-cut rolls off below its corner', () => {
    const band = bandCoefs(3, 1000, 0, Math.SQRT1_2, SR);
    expect(biquadResponseDb(band, 1000, SR)).toBeCloseTo(-3, 0);
    expect(biquadResponseDb(band, 50, SR)).toBeLessThan(-30);
    expect(Math.abs(biquadResponseDb(band, 10000, SR))).toBeLessThan(0.5);
  });

  it('hi-cut rolls off above its corner', () => {
    const band = bandCoefs(4, 1000, 0, Math.SQRT1_2, SR);
    expect(biquadResponseDb(band, 12000, SR)).toBeLessThan(-30);
    expect(Math.abs(biquadResponseDb(band, 100, SR))).toBeLessThan(0.5);
  });

  it('shelves approach their gain in the shelf region', () => {
    const lo = bandCoefs(1, 200, 9, 0.9, SR);
    expect(biquadResponseDb(lo, 30, SR)).toBeGreaterThan(7);
    expect(Math.abs(biquadResponseDb(lo, 8000, SR))).toBeLessThan(1);
    const hi = bandCoefs(2, 5000, -9, 0.9, SR);
    expect(biquadResponseDb(hi, 18000, SR)).toBeLessThan(-7);
    expect(Math.abs(biquadResponseDb(hi, 200, SR))).toBeLessThan(1);
  });
});
