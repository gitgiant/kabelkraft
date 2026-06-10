/**
 * Quantizer scales — shared by the registry (UI labels) and mirrored in the
 * worklet (engine-worklet.js QUANT_SCALES — keep in sync, same pattern as
 * eqmath.ts vs the worklet Biquad).
 */

export const SCALE_NAMES = [
  'chromatic',
  'major',
  'minor',
  'penta maj',
  'penta min',
  'blues',
  'dorian',
  'mixolydian',
] as const;

/** Allowed pitch classes (semitones from root) per scale, ascending. */
export const SCALE_TABLES: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], // chromatic
  [0, 2, 4, 5, 7, 9, 11], // major
  [0, 2, 3, 5, 7, 8, 10], // natural minor
  [0, 2, 4, 7, 9], // pentatonic major
  [0, 3, 5, 7, 10], // pentatonic minor
  [0, 3, 5, 6, 7, 10], // blues
  [0, 2, 3, 5, 7, 9, 10], // dorian
  [0, 2, 4, 5, 7, 9, 10], // mixolydian
];

export const ROOT_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/**
 * Snap a MIDI pitch to the nearest note of the scale (ties round down).
 * Pure and table-driven so the worklet copy stays trivially comparable.
 */
export function quantizePitch(midi: number, scaleIdx: number, root: number): number {
  const table = SCALE_TABLES[scaleIdx] ?? SCALE_TABLES[0];
  const rounded = Math.round(midi);
  let best = rounded;
  let bestDist = Infinity;
  for (let off = -11; off <= 11; off++) {
    const cand = rounded + off;
    if (cand < 0 || cand > 127) continue;
    const pc = ((cand - root) % 12 + 12) % 12;
    if (!table.includes(pc)) continue;
    const dist = Math.abs(midi - cand);
    if (dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) < 1e-9 && cand < best)) {
      best = cand;
      bestDist = dist;
    }
  }
  return best;
}
