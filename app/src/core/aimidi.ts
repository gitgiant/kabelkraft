/**
 * AI MIDI generation (Composer piano roll): a spec pack an LLM needs to write
 * a valid .kkmidi clip, plus the validator that turns its JSON reply into a
 * ComposerClip. Mirrors the AI patch flow (aispec.ts / aiimport.ts) — copy the
 * spec for an external chatbot, or generate in-app via aiprovider.
 */

import {
  COMPOSER_MAX_LENGTH,
  COMPOSER_MIN_LENGTH,
  COMPOSER_MIN_NOTE_LEN,
  sanitizeNote,
  sortNotes,
  type ComposerClip,
} from './composer';
import { extractJson } from './aiimport';

/** Note/clip field reference — shared between the .kkmidi spec and the project spec. */
export const MIDI_FIELDS = `- \`length\`: loop length in BEATS (4 beats = one 4/4 bar). Integer or .25
  steps, between ${COMPOSER_MIN_LENGTH} and ${COMPOSER_MAX_LENGTH}. The clip loops over this length —
  ${COMPOSER_MAX_LENGTH} beats is a hard cap, so long pieces must fit inside it.
- \`notes\`: flat array, free (unquantized) timing allowed.
  - \`start\`: beats from clip start, >= 0 and < \`length\` (notes at/past the
    loop end never play).
  - \`length\`: note duration in beats, > 0 (minimum ${COMPOSER_MIN_NOTE_LEN}).
  - \`pitch\`: MIDI note number 0–127 (60 = C4, 69 = A4 = 440 Hz).
  - \`vel\`: velocity 0–1 (default 0.8).
  - Optional per-note expression, all defaulting to neutral:
    \`pan\` −1..1 (stereo, default 0) · \`release\` 0–1 (note-off velocity,
    default 0.5) · \`modX\` 0–1 (mod wheel, default 0) · \`modY\` 0–1
    (filter/brightness, default 0) · \`prob\` 0–1 (chance the note plays each
    loop pass, default 1).`;

/** Musical writing guidance — shared between the .kkmidi spec and the project spec. */
export const MIDI_GUIDANCE = `- Times are in beats, tempo-independent — the app supplies the tempo.
- Chords = several notes sharing the same \`start\`.
- Keep velocities varied (accents ~0.9, ghosts ~0.3) so lines breathe.
- \`prob\` < 1 on ornaments/fills makes loops evolve; keep structural notes at 1.
- If the prompt names a key or scale, stay inside it and land phrase endings
  on chord tones.
- Default drum map if asked for beats (overridden by any wired-target pitches
  given in the context): kick 36, snare 38, closed hat 42, open hat 46,
  clap 39, low/mid/high toms 41/45/48, ride 51, crash 49.`;

export const MIDI_SPEC = `# KabelKraft AI MIDI clip spec

You write a musical clip for a piano-roll sequencer. Reply with ONE JSON code
block, no prose inside it:

\`\`\`json
{
  "kind": "kkmidi",
  "name": "Short clip name",
  "length": 16,
  "notes": [
    { "start": 0, "length": 0.5, "pitch": 60, "vel": 0.8 },
    { "start": 0.5, "length": 0.25, "pitch": 63, "vel": 0.6, "pan": -0.3, "prob": 0.75 }
  ]
}
\`\`\`

## Fields

${MIDI_FIELDS}

## Musical guidance

${MIDI_GUIDANCE}
`;

/** Spec + optional user prompt in one paste-able block (external chatbot flow). */
export function generateMidiSpecPack(userPrompt?: string): string {
  const prompt = userPrompt?.trim();
  return prompt ? `USER PROMPT: ${prompt}\n\n${MIDI_SPEC}` : MIDI_SPEC;
}

/**
 * Render the clip's current notes as a "variate on these" instruction block —
 * same JSON shape the model writes, so it can build on what's already there.
 * Default per-note fields are omitted to keep the prompt small.
 */
export function existingNotesPrompt(clip: ComposerClip): string {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const notes = clip.notes.map((n) => {
    const o: Record<string, number> = { start: r(n.start), length: r(n.length), pitch: n.pitch, vel: r(n.vel) };
    if (n.pan !== 0) o.pan = r(n.pan);
    if (n.release !== 0.5) o.release = r(n.release);
    if (n.modX !== 0) o.modX = r(n.modX);
    if (n.modY !== 0) o.modY = r(n.modY);
    if (n.prob !== 1) o.prob = r(n.prob);
    return o;
  });
  const doc = JSON.stringify({ kind: 'kkmidi', length: clip.length, notes });
  return `Variate on existing notes — here is the current clip, build on it:\n\`\`\`json\n${doc}\n\`\`\``;
}

export interface ParseMidiResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  clip?: ComposerClip;
  name?: string;
}

/**
 * Validate an LLM's .kkmidi reply (raw JSON or markdown with a ```json block)
 * into a ComposerClip. Readable errors; out-of-range values are clamped with
 * warnings where recoverable, errors where the structure itself is wrong.
 */
export function parseKkMidi(text: string): ParseMidiResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(extractJson(text));
  } catch (e) {
    return {
      ok: false,
      errors: [`Not valid JSON: ${e instanceof Error ? e.message : e}`],
      warnings,
    };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['Top level must be a JSON object.'], warnings };
  }
  const doc = raw as Record<string, unknown>;
  if (doc.kind !== undefined && doc.kind !== 'kkmidi') {
    warnings.push(`"kind" is "${doc.kind}" — expected "kkmidi".`);
  }

  if (!Array.isArray(doc.notes)) {
    return { ok: false, errors: ['"notes" must be an array of note objects.'], warnings };
  }
  if (doc.notes.length === 0) errors.push('"notes" is empty — write at least one note.');
  if (doc.notes.length > 4000) {
    errors.push(`${doc.notes.length} notes is too many (max 4000).`);
  }

  const rawLength = Number(doc.length);
  if (!Number.isFinite(rawLength) || rawLength <= 0) {
    errors.push(`"length" must be a number of beats between ${COMPOSER_MIN_LENGTH} and ${COMPOSER_MAX_LENGTH}.`);
  } else if (rawLength > COMPOSER_MAX_LENGTH) {
    warnings.push(`"length" ${rawLength} exceeds the ${COMPOSER_MAX_LENGTH}-beat cap — clamped.`);
  }
  const length = Math.min(
    COMPOSER_MAX_LENGTH,
    Math.max(COMPOSER_MIN_LENGTH, Number.isFinite(rawLength) ? rawLength : 16),
  );

  const notes = [];
  let dropped = 0;
  for (let i = 0; i < doc.notes.length && errors.length < 8; i++) {
    const n = doc.notes[i] as Record<string, unknown>;
    if (typeof n !== 'object' || n === null) {
      errors.push(`notes[${i}] is not an object.`);
      continue;
    }
    const errorsBefore = errors.length;
    for (const field of ['start', 'length', 'pitch'] as const) {
      if (!Number.isFinite(Number(n[field]))) {
        errors.push(`notes[${i}].${field} is missing or not a number.`);
      }
    }
    if (errors.length > errorsBefore) continue;
    const note = sanitizeNote(n);
    if (note.start >= length) {
      dropped++; // can never play — silently inert in the editor otherwise
      continue;
    }
    notes.push(note);
  }
  if (dropped > 0) {
    warnings.push(`${dropped} note${dropped === 1 ? '' : 's'} start at/past the ${length}-beat loop end — dropped.`);
  }
  if (errors.length === 0 && notes.length === 0) {
    errors.push('No playable notes (all start at/past the loop end).');
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return {
    ok: true,
    errors,
    warnings,
    clip: { notes: sortNotes(notes), length },
    name: typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : undefined,
  };
}
