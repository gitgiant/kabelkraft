import { describe, expect, it } from 'vitest';
import { quantizePitch, ROOT_NAMES, SCALE_NAMES, SCALE_TABLES } from './scales';

describe('quantizePitch', () => {
  it('chromatic passes integers through', () => {
    for (const p of [0, 36, 60, 61, 99, 127]) {
      expect(quantizePitch(p, 0, 0)).toBe(p);
    }
  });

  it('snaps to C major', () => {
    expect(quantizePitch(60, 1, 0)).toBe(60); // C stays
    expect(quantizePitch(61, 1, 0)).toBe(60); // C# tie rounds down
    expect(quantizePitch(61.6, 1, 0)).toBe(62); // closer to D
    expect(quantizePitch(66, 1, 0)).toBe(65); // F# tie → F
  });

  it('respects the root', () => {
    // A minor pentatonic (root A=9): A C D E G
    const allowed = new Set([0, 2, 4, 5, 7, 9].map((pc) => pc)); // pcs of A-rooted penta min: 9, 0, 2, 4, 7
    for (let p = 40; p < 90; p++) {
      const q = quantizePitch(p, 4, 9);
      const pc = ((q - 9) % 12 + 12) % 12;
      expect(SCALE_TABLES[4]).toContain(pc);
      expect(Math.abs(q - p)).toBeLessThanOrEqual(2);
    }
    expect(allowed.size).toBeGreaterThan(0); // keep TS happy about usage
  });

  it('every scale output lands in the scale', () => {
    for (let s = 0; s < SCALE_TABLES.length; s++) {
      for (let root = 0; root < 12; root++) {
        for (let p = 20; p <= 100; p += 7) {
          const q = quantizePitch(p, s, root);
          const pc = ((q - root) % 12 + 12) % 12;
          expect(SCALE_TABLES[s]).toContain(pc);
        }
      }
    }
  });

  it('clamps to MIDI range at the edges', () => {
    expect(quantizePitch(0, 1, 0)).toBeGreaterThanOrEqual(0);
    expect(quantizePitch(127, 1, 0)).toBeLessThanOrEqual(127);
  });

  it('tables and labels stay in sync', () => {
    expect(SCALE_NAMES.length).toBe(SCALE_TABLES.length);
    expect(ROOT_NAMES.length).toBe(12);
  });
});
