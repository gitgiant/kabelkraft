/**
 * Text-producer formatting helpers (VISUALIZER_ENGINE_PLAN.md Phase 3) —
 * pure functions shared by state routing, module faces and tests.
 */

import type { TransportState } from './types';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI pitch → "C#4" (C4 = 60; fractional pitches round to nearest). */
export function noteName(pitch: number): string {
  const p = Math.round(pitch);
  return `${NOTE_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;
}

/** Format index matches TRANSPORT_TEXT_FORMATS: 0 bar.beat, 1 time, 2 bpm. */
export function formatTransportText(format: number, t: TransportState): string {
  if (format >= 1.5) return `${Math.round(t.tempo)} BPM`;
  if (format >= 0.5) {
    const totalSeconds = Math.max(0, (t.songPosition / t.tempo) * 60);
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  const beatsPerBar = Math.max(1, t.timeSignature.num);
  const bar = Math.floor(t.songPosition / beatsPerBar) + 1;
  const beat = Math.floor(t.songPosition % beatsPerBar) + 1;
  return `${bar}.${beat}`;
}
