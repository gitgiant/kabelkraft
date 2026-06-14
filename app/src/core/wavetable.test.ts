import { describe, expect, it } from 'vitest';
import { buildWavetable, defaultWavetable, framePoints, WT_FRAME } from './wavetable';

describe('wavetable', () => {
  it('default table is an 8-frame harmonic sweep, normalized', () => {
    const wt = defaultWavetable();
    expect(wt.frames).toBe(8);
    expect(wt.data.length).toBe(8 * WT_FRAME);
    // Each frame peaks at ~0.9 (normalized).
    for (let f = 0; f < wt.frames; f++) {
      let peak = 0;
      for (let i = 0; i < WT_FRAME; i++) peak = Math.max(peak, Math.abs(wt.data[f * WT_FRAME + i]));
      expect(peak).toBeCloseTo(0.9, 2);
    }
  });

  it('builds a multi-frame table from long PCM and one cycle from short PCM', () => {
    const long = new Float32Array(WT_FRAME * 3);
    expect(buildWavetable(long)!.frames).toBe(3);

    const short = new Float32Array(64).map((_, i) => Math.sin((i / 64) * 2 * Math.PI));
    const wt = buildWavetable(short)!;
    expect(wt.frames).toBe(1);
    expect(wt.data.length).toBe(WT_FRAME);

    expect(buildWavetable(new Float32Array(0))).toBeNull();
    expect(buildWavetable(undefined)).toBeNull();
  });

  it('framePoints decimates a frame to n in-range samples', () => {
    const wt = defaultWavetable();
    const pts = framePoints(wt, 0, 50);
    expect(pts.length).toBe(50);
    for (const v of pts) expect(Math.abs(v)).toBeLessThanOrEqual(1);
    // Frame 0 is a pure sine → starts near 0, quarter-way near peak.
    expect(Math.abs(pts[0])).toBeLessThan(0.1);
  });
});
