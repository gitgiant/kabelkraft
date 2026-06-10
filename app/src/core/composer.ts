/**
 * Composer piano-roll note model (PRD §8.3, reworked).
 *
 * A composer holds one clip: a flat list of free-time notes (starts and
 * lengths in beats, NOT quantized) plus a loop length. Each note carries the
 * per-note MIDI-ish parameters editable in the piano roll. The clip lives in
 * ModuleInstance.data, so saves/undo/AI import all ride the existing paths.
 */

export interface ComposerNote {
  /** Start in beats from clip start. Free (unquantized) values allowed. */
  start: number;
  /** Length in beats (> 0). */
  length: number;
  /** MIDI pitch 0–127 (integer). */
  pitch: number;
  /** Note-on velocity 0–1. */
  vel: number;
  /** Stereo pan −1..1 (MIDI CC10). */
  pan: number;
  /** Note-off (release) velocity 0–1. */
  release: number;
  /** Mod X 0–1 (MIDI CC1, mod wheel). */
  modX: number;
  /** Mod Y 0–1 (MIDI CC74, filter/brightness). */
  modY: number;
  /** Probability 0–1 that the note plays on each loop pass. */
  prob: number;
}

export interface ComposerClip {
  notes: ComposerNote[];
  /** Loop length in beats. */
  length: number;
}

export const COMPOSER_MIN_LENGTH = 1; // beats
export const COMPOSER_MAX_LENGTH = 256; // beats
export const COMPOSER_MIN_NOTE_LEN = 1 / 64; // beats

export function defaultNote(start: number, pitch: number, length = 1): ComposerNote {
  return { start, length, pitch, vel: 0.8, pan: 0, release: 0.5, modX: 0, modY: 0, prob: 1 };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Sanitize one raw note (loaded project / AI import / MIDI file). */
export function sanitizeNote(raw: Partial<ComposerNote>): ComposerNote {
  const d = defaultNote(0, 60);
  return {
    start: Math.max(0, Number(raw.start) || 0),
    length: clamp(Number(raw.length) || 1, COMPOSER_MIN_NOTE_LEN, COMPOSER_MAX_LENGTH),
    pitch: clamp(Math.round(Number(raw.pitch) || 60), 0, 127),
    vel: clamp(raw.vel === undefined ? d.vel : Number(raw.vel) || 0, 0, 1),
    pan: clamp(raw.pan === undefined ? d.pan : Number(raw.pan) || 0, -1, 1),
    release: clamp(raw.release === undefined ? d.release : Number(raw.release) || 0, 0, 1),
    modX: clamp(raw.modX === undefined ? d.modX : Number(raw.modX) || 0, 0, 1),
    modY: clamp(raw.modY === undefined ? d.modY : Number(raw.modY) || 0, 0, 1),
    prob: clamp(raw.prob === undefined ? d.prob : Number(raw.prob) || 0, 0, 1),
  };
}

/** Read a clip out of a composer module's data blob (any vintage). */
export function clipFromData(data: Record<string, unknown> | undefined): ComposerClip {
  if (data && Array.isArray(data.notes)) {
    return {
      notes: (data.notes as Partial<ComposerNote>[]).map(sanitizeNote),
      length: clamp(Number(data.length) || 16, COMPOSER_MIN_LENGTH, COMPOSER_MAX_LENGTH),
    };
  }
  if (data && Array.isArray(data.patterns)) return migrateLegacy(data);
  return { notes: [], length: 16 };
}

/**
 * Legacy composer data (8 patterns × 4 tracks × 16 steps + song slots) →
 * one linear clip: song slots become consecutive bars, steps become
 * quarter-of-a-beat notes. Tracks merge (single note output now).
 */
function migrateLegacy(data: Record<string, unknown>): ComposerClip {
  type Step = { on?: boolean; pitch?: number };
  const patterns = data.patterns as Step[][][];
  const song = (Array.isArray(data.song) ? (data.song as number[]) : []).filter(
    (p) => typeof p === 'number',
  );
  const slots = song.length ? song : [0];
  const notes: ComposerNote[] = [];
  let bar = 0;
  for (const pIdx of slots) {
    const pattern = patterns[pIdx];
    if (pIdx < 0 || !pattern) continue; // empty slot: silent bar? legacy skipped it entirely
    for (const track of pattern) {
      track.forEach((step, i) => {
        if (!step?.on) return;
        notes.push(defaultNote(bar * 4 + i / 4, clamp(Math.round(step.pitch ?? 60), 0, 127), 0.25));
      });
    }
    bar++;
  }
  const length = clamp(Math.max(4, bar * 4), COMPOSER_MIN_LENGTH, COMPOSER_MAX_LENGTH);
  return { notes: sortNotes(notes), length };
}

export function sortNotes(notes: ComposerNote[]): ComposerNote[] {
  return [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

// ---------------------------------------------------------------------------
// Note tools: quantize / humanize / randomize
// ---------------------------------------------------------------------------

export interface QuantizeOptions {
  /** Grid in beats (e.g. 0.25 = 1/16 at 4/4). */
  grid: number;
  /** 0–1: how far each note moves toward the grid (1 = full snap). */
  strength: number;
  starts: boolean;
  lengths: boolean;
}

export function quantizeNotes(notes: ComposerNote[], opts: QuantizeOptions): ComposerNote[] {
  const { grid, strength } = opts;
  if (grid <= 0 || strength <= 0) return notes.map((n) => ({ ...n }));
  return notes.map((n) => {
    const out = { ...n };
    if (opts.starts) {
      const target = Math.round(n.start / grid) * grid;
      out.start = Math.max(0, n.start + (target - n.start) * strength);
    }
    if (opts.lengths) {
      const target = Math.max(grid, Math.round(n.length / grid) * grid);
      out.length = Math.max(COMPOSER_MIN_NOTE_LEN, n.length + (target - n.length) * strength);
    }
    return out;
  });
}

export interface HumanizeOptions {
  /** Max timing offset in beats (uniform ±). */
  timing: number;
  /** Max velocity offset (uniform ±, 0–1 scale). */
  velocity: number;
}

export const DEFAULT_HUMANIZE: HumanizeOptions = { timing: 0.03, velocity: 0.08 };

export function humanizeNotes(
  notes: ComposerNote[],
  opts: HumanizeOptions = DEFAULT_HUMANIZE,
  rand: () => number = Math.random,
): ComposerNote[] {
  return notes.map((n) => ({
    ...n,
    start: Math.max(0, n.start + (rand() * 2 - 1) * opts.timing),
    vel: clamp(n.vel + (rand() * 2 - 1) * opts.velocity, 0.05, 1),
  }));
}

/** Scramble pitches (±1 octave, stays 0–127) and velocities — chaos button. */
export function randomizeNotes(
  notes: ComposerNote[],
  rand: () => number = Math.random,
): ComposerNote[] {
  return notes.map((n) => ({
    ...n,
    pitch: clamp(n.pitch + Math.round((rand() * 2 - 1) * 12), 0, 127),
    vel: clamp(0.4 + rand() * 0.6, 0, 1),
  }));
}
