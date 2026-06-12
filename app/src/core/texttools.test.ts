import { describe, expect, it } from 'vitest';
import { formatTransportText, noteName } from './texttools';
import { DEFAULT_TRANSPORT } from './types';

describe('noteName', () => {
  it('names pitches with C4 = 60', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(61)).toBe('C#4');
    expect(noteName(69)).toBe('A4');
    expect(noteName(59)).toBe('B3');
    expect(noteName(0)).toBe('C-1');
  });

  it('rounds microtonal pitches to the nearest semitone', () => {
    expect(noteName(60.4)).toBe('C4');
    expect(noteName(60.6)).toBe('C#4');
  });
});

describe('formatTransportText', () => {
  const t = { ...DEFAULT_TRANSPORT, tempo: 120, songPosition: 9.5 };

  it('formats bar.beat in 4/4 (format 0)', () => {
    expect(formatTransportText(0, t)).toBe('3.2'); // beat 9.5 → bar 3, beat 2
    expect(formatTransportText(0, { ...t, songPosition: 0 })).toBe('1.1');
  });

  it('respects the time signature numerator', () => {
    expect(formatTransportText(0, { ...t, timeSignature: { num: 3, denom: 4 }, songPosition: 7 })).toBe('3.2');
  });

  it('formats elapsed time (format 1)', () => {
    // 9.5 beats at 120 BPM = 4.75 s
    expect(formatTransportText(1, t)).toBe('0:04');
    expect(formatTransportText(1, { ...t, songPosition: 130 })).toBe('1:05');
  });

  it('formats bpm (format 2)', () => {
    expect(formatTransportText(2, t)).toBe('120 BPM');
  });
});
