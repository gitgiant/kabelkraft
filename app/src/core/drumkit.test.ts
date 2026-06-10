import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KIT,
  DRUM_PADS,
  DRUM_STEPS,
  defaultDrumPads,
  defaultDrumPattern,
  renderDefaultKit,
} from './drumkit';

describe('default drum kit', () => {
  it('renders 8 kit pieces into the 16 pad slots', () => {
    const kit = renderDefaultKit();
    expect(kit).toHaveLength(DRUM_PADS);
    expect(kit.filter((s) => s !== null)).toHaveLength(DEFAULT_KIT.length);
    for (const sample of kit) {
      if (!sample) continue;
      expect(sample.sampleRate).toBe(44100);
      expect(sample.channels[0].length).toBeGreaterThan(0);
    }
  });

  it('stays within ±1 (no clipping into the limiter)', () => {
    for (const sample of renderDefaultKit()) {
      if (!sample) continue;
      let peak = 0;
      for (const v of sample.channels[0]) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeGreaterThan(0.1); // audible
      expect(peak).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic (seeded noise, PRD §9.8)', () => {
    const a = renderDefaultKit();
    const b = renderDefaultKit();
    for (let i = 0; i < a.length; i++) {
      if (!a[i]) continue;
      expect(a[i]!.channels[0]).toEqual(b[i]!.channels[0]);
    }
  });

  it('default pads: hats share a choke group, decay starts bypassed', () => {
    const pads = defaultDrumPads();
    expect(pads).toHaveLength(DRUM_PADS);
    const ch = pads.find((p) => p.name === 'CH')!;
    const oh = pads.find((p) => p.name === 'OH')!;
    expect(ch.choke).toBe(oh.choke);
    expect(ch.choke).toBeGreaterThan(0);
    expect(pads[0].decay).toBe(2);
  });

  it('default pattern is 16×16 with a kick on the downbeat', () => {
    const pattern = defaultDrumPattern();
    expect(pattern).toHaveLength(DRUM_PADS);
    for (const row of pattern) expect(row).toHaveLength(DRUM_STEPS);
    expect(pattern[0][0].on).toBe(true);
    expect(pattern[1][4].on).toBe(true); // snare backbeat
  });
});
