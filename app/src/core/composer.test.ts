import { describe, expect, it } from 'vitest';
import {
  clipFromData,
  defaultNote,
  humanizeNotes,
  quantizeNotes,
  randomizeNotes,
  sanitizeNote,
} from './composer';

describe('clipFromData', () => {
  it('returns an empty 16-beat clip for missing data', () => {
    expect(clipFromData(undefined)).toEqual({ notes: [], length: 16 });
  });

  it('sanitizes modern note data', () => {
    const clip = clipFromData({
      notes: [{ start: -2, length: 0, pitch: 400, vel: 9 }],
      length: 8,
    });
    expect(clip.length).toBe(8);
    expect(clip.notes[0].start).toBe(0);
    expect(clip.notes[0].pitch).toBe(127);
    expect(clip.notes[0].vel).toBe(1);
    expect(clip.notes[0].length).toBeGreaterThan(0);
    expect(clip.notes[0].prob).toBe(1); // defaults fill in
  });

  it('migrates legacy pattern/song data to a linear clip', () => {
    const patterns = Array.from({ length: 2 }, () =>
      Array.from({ length: 4 }, () => Array.from({ length: 16 }, () => ({ on: false, pitch: 60 }))),
    );
    patterns[0][0][0] = { on: true, pitch: 57 };
    patterns[0][1][8] = { on: true, pitch: 64 };
    patterns[1][0][4] = { on: true, pitch: 60 };
    const clip = clipFromData({ patterns, song: [0, 1] });
    expect(clip.length).toBe(8); // two bars
    expect(clip.notes).toHaveLength(3);
    expect(clip.notes[0]).toMatchObject({ start: 0, pitch: 57, length: 0.25 });
    expect(clip.notes[1]).toMatchObject({ start: 2, pitch: 64 });
    expect(clip.notes[2]).toMatchObject({ start: 5, pitch: 60 }); // bar 2, step 4
  });
});

describe('quantizeNotes', () => {
  const note = (start: number, length = 0.3) => ({ ...defaultNote(start, 60), length });

  it('snaps starts fully at strength 1', () => {
    const out = quantizeNotes([note(0.25 + 0.07), note(1.0 - 0.05)], {
      grid: 0.25,
      strength: 1,
      starts: true,
      lengths: false,
    });
    expect(out[0].start).toBeCloseTo(0.25);
    expect(out[1].start).toBeCloseTo(1.0);
  });

  it('moves halfway at strength 0.5 and can quantize lengths', () => {
    const out = quantizeNotes([note(0.35, 0.3)], {
      grid: 0.25,
      strength: 0.5,
      starts: true,
      lengths: true,
    });
    expect(out[0].start).toBeCloseTo(0.3); // 0.35 → halfway to 0.25
    expect(out[0].length).toBeCloseTo(0.275); // 0.3 → halfway to 0.25
  });

  it('never snaps a length to zero', () => {
    const out = quantizeNotes([note(0, 0.05)], { grid: 0.5, strength: 1, starts: false, lengths: true });
    expect(out[0].length).toBeGreaterThan(0);
  });
});

describe('humanize / randomize', () => {
  it('humanize jitters timing and velocity within bounds', () => {
    const notes = [defaultNote(1, 60), defaultNote(2, 64)];
    const out = humanizeNotes(notes, { timing: 0.05, velocity: 0.1 }, () => 1); // rand=1 → +max
    expect(out[0].start).toBeCloseTo(1.05);
    expect(out[0].vel).toBeCloseTo(0.9);
    expect(out[1].start).toBeCloseTo(2.05);
  });

  it('humanize never moves a note before 0', () => {
    const out = humanizeNotes([defaultNote(0.01, 60)], { timing: 0.1, velocity: 0 }, () => 0); // rand=0 → -max
    expect(out[0].start).toBe(0);
  });

  it('randomize keeps pitches in 0..127 and timing intact', () => {
    const notes = [defaultNote(0, 127), defaultNote(1, 0)];
    const out = randomizeNotes(notes, () => 1);
    expect(out[0].pitch).toBeLessThanOrEqual(127);
    expect(out[1].pitch).toBeGreaterThanOrEqual(0);
    expect(out[0].start).toBe(0);
    expect(out[1].start).toBe(1);
  });
});

describe('sanitizeNote', () => {
  it('fills defaults and clamps ranges', () => {
    const n = sanitizeNote({ pitch: 60.4, pan: -3 });
    expect(n.pitch).toBe(60);
    expect(n.pan).toBe(-1);
    expect(n.vel).toBeCloseTo(0.8);
    expect(n.prob).toBe(1);
  });
});
