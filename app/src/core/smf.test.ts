import { describe, expect, it } from 'vitest';
import { defaultNote, type ComposerNote } from './composer';
import { parseSmf, writeSmf } from './smf';

function roundTrip(notes: ComposerNote[], lengthBeats = 8, tempo = 120) {
  const bytes = writeSmf(notes, lengthBeats, tempo);
  return parseSmf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

describe('SMF round-trip', () => {
  it('preserves pitch, free (unquantized) timing, velocity and release', () => {
    const notes = [
      { ...defaultNote(0.123, 60, 0.5), vel: 0.5, release: 0.25 },
      { ...defaultNote(2.7, 72, 1.31), vel: 1, release: 0 },
    ];
    const file = roundTrip(notes);
    expect(file.tracks).toHaveLength(1);
    expect(file.notes).toHaveLength(2);
    expect(file.tempo).toBe(120);
    const [a, b] = file.notes;
    expect(a.pitch).toBe(60);
    expect(a.start).toBeCloseTo(0.123, 2); // PPQ 480 ≈ 0.002-beat resolution
    expect(a.length).toBeCloseTo(0.5, 2);
    expect(a.vel).toBeCloseTo(0.5, 1);
    expect(a.release).toBeCloseTo(0.25, 1);
    expect(b.pitch).toBe(72);
    expect(b.start).toBeCloseTo(2.7, 2);
  });

  it('maps pan/modX/modY through CC10/CC1/CC74', () => {
    const notes = [
      { ...defaultNote(0, 60, 1), pan: -1, modX: 0.5, modY: 1 },
      { ...defaultNote(1, 62, 1), pan: 1, modX: 0, modY: 0 },
    ];
    const [a, b] = roundTrip(notes).notes;
    expect(a.pan).toBeCloseTo(-1, 1);
    expect(a.modX).toBeCloseTo(0.5, 1);
    expect(a.modY).toBeCloseTo(1, 1);
    expect(b.pan).toBeCloseTo(1, 1);
    expect(b.modX).toBeCloseTo(0, 1);
    expect(b.modY).toBeCloseTo(0, 1);
  });

  it('handles chords and same-pitch retriggers', () => {
    const notes = [
      defaultNote(0, 60, 2),
      defaultNote(0, 64, 2),
      defaultNote(0, 67, 2),
      defaultNote(2, 60, 0.5), // same pitch again right at the first off
    ];
    const file = roundTrip(notes);
    expect(file.notes).toHaveLength(4);
    expect(file.notes.filter((n) => n.start === 0)).toHaveLength(3);
  });

  it('reports track info for the channel popup', () => {
    const file = roundTrip([defaultNote(0, 60, 1)]);
    expect(file.tracks[0].noteCount).toBe(1);
    expect(file.tracks[0].channels).toEqual([0]);
    expect(file.lengthBeats).toBeGreaterThanOrEqual(1);
  });

  it('rejects non-MIDI data', () => {
    expect(() => parseSmf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).toThrow(/MThd|MIDI/);
  });
});
