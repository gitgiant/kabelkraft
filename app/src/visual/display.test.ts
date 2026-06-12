import { describe, expect, it } from 'vitest';
import { FrameGate, visDisplayOf, VIS_RATES, VIS_RES_SCALES } from './display';

describe('visDisplayOf', () => {
  it('defaults to 60 fps / full resolution', () => {
    expect(visDisplayOf(undefined)).toEqual({ fps: 60, res: 1 });
    expect(visDisplayOf({})).toEqual({ fps: 60, res: 1 });
  });

  it('accepts only the locked rate/scale sets', () => {
    for (const fps of VIS_RATES) expect(visDisplayOf({ fps }).fps).toBe(fps);
    for (const res of VIS_RES_SCALES) expect(visDisplayOf({ res }).res).toBe(res);
    expect(visDisplayOf({ fps: 30, res: 2 })).toEqual({ fps: 60, res: 1 });
    expect(visDisplayOf({ fps: 'fast', res: null })).toEqual({ fps: 60, res: 1 });
  });
});

describe('FrameGate', () => {
  /** Run rAF callbacks at `hz` for one second, count renders the gate allows. */
  function passes(displayHz: number, fps: number): number {
    const gate = new FrameGate();
    const step = 1000 / displayHz;
    let count = 0;
    for (let t = step; t <= 1000; t += step) {
      if (gate.due(t, fps)) count++;
    }
    return count;
  }

  it('divides a fast display down to the cap', () => {
    const n = passes(240, 60);
    expect(n).toBeGreaterThanOrEqual(58);
    expect(n).toBeLessThanOrEqual(62);
  });

  it('passes every callback when the cap meets the display rate', () => {
    expect(passes(60, 60)).toBe(60);
    expect(passes(240, 240)).toBe(240);
  });

  it('a high cap on a slow display is uncapped', () => {
    expect(passes(60, 240)).toBe(60);
  });
});
