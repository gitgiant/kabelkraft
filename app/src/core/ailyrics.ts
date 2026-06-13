/**
 * AI lyrics generation (Lyrics module): a spec pack an LLM needs to write a
 * valid .kklyrics sheet, plus the validator that turns its JSON reply into a
 * LyricsClip. Mirrors the AI MIDI flow (aimidi.ts) — copy the spec for an
 * external chatbot, or generate in-app via aiprovider.
 *
 * Lines are timed in BEATS, song-absolute: each line plays once when the
 * transport's song position crosses its `start`. The clip carries the live
 * BPM + time signature into the spec so the model can reason in bars
 * ("verse = 16 bars") while the output stays tempo-safe.
 */

import { extractJson } from './aiimport';

/** One optional word-level timing within a line (inert for now — stored, not emitted). */
export interface LyricsWord {
  /** Offset in beats from the line's `start`. */
  off: number;
  text: string;
}

export interface LyricsLine {
  /** Start in beats from song start (absolute, >= 0). */
  start: number;
  text: string;
  /** Optional per-word offsets (karaoke; stored but not yet emitted). */
  words?: LyricsWord[];
}

export interface LyricsClip {
  lines: LyricsLine[];
}

/** Song-absolute timing cap — a generous ceiling on a line's start beat. */
export const LYRICS_MAX_START = 10000; // beats (~3.5 hours at 120 BPM in 4/4)
/** Hard cap on lines per sheet. */
export const LYRICS_MAX_LINES = 2000;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Live song context injected into the spec so the model can time lines in bars. */
export interface LyricsSongContext {
  tempo: number;
  timeSignature: { num: number; denom: number };
}

const FIELDS = `- \`start\`: beats from the SONG start (absolute, not a loop offset), >= 0.
  4 beats = one bar in 4/4. Lines play once, in order, as the transport
  reaches each \`start\` — there is no looping, so space lines across the whole
  song.
- \`text\`: the lyric line (one phrase or sentence). Non-empty.
- \`words\` (optional): per-word timing for karaoke, an array of
  \`{ "off": beats, "text": "word" }\` where \`off\` is beats AFTER the line's
  \`start\`. Omit it unless you want word-level timing.`;

const GUIDANCE = `- Times are in beats, tempo-independent — the app supplies the tempo, so the
  same sheet stays in sync if the song's BPM changes.
- Use the song context (BPM + time signature) to convert musical structure to
  beats: in N/4 time one bar = N beats, so a 16-bar verse spans 16×N beats.
- Lay out a real song shape: intro space, verse, chorus, etc. Leave gaps where
  the vocal rests — not every bar needs a line.
- Keep lines short enough to read/sing in the time before the next line.`;

function songContextLine(ctx?: LyricsSongContext): string {
  if (!ctx) return '';
  const num = ctx.timeSignature.num;
  const denom = ctx.timeSignature.denom;
  return (
    `## Song context\n\n` +
    `- Tempo: ${Math.round(ctx.tempo)} BPM.\n` +
    `- Time signature: ${num}/${denom} — one bar = ${num} beat${num === 1 ? '' : 's'}.\n`
  );
}

export const LYRICS_SPEC = `# KabelKraft AI lyrics spec

You write timed song lyrics for a playback module. Reply with ONE JSON code
block, no prose inside it:

\`\`\`json
{
  "kind": "kklyrics",
  "name": "Short song name",
  "lines": [
    { "start": 0, "text": "First line as the intro lands" },
    { "start": 8, "text": "Second line, eight beats later" },
    { "start": 16, "text": "Sing it now", "words": [
      { "off": 0, "text": "Sing" }, { "off": 1, "text": "it" }, { "off": 2, "text": "now" }
    ] }
  ]
}
\`\`\`

## Fields

${FIELDS}

## Writing guidance

${GUIDANCE}
`;

/** Spec + live song context + optional user prompt in one paste-able block. */
export function generateLyricsSpecPack(userPrompt?: string, ctx?: LyricsSongContext): string {
  const prompt = userPrompt?.trim();
  const ctxBlock = songContextLine(ctx);
  return [LYRICS_SPEC, ctxBlock, prompt ? `USER PROMPT: ${prompt}` : '']
    .filter(Boolean)
    .join('\n');
}

export interface ParseLyricsResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  clip?: LyricsClip;
  name?: string;
}

/** Sanitize optional word offsets; drop malformed entries quietly. */
function sanitizeWords(raw: unknown): LyricsWord[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const words: LyricsWord[] = [];
  for (const w of raw) {
    if (typeof w !== 'object' || w === null) continue;
    const o = w as Record<string, unknown>;
    const off = Number(o.off);
    const text = typeof o.text === 'string' ? o.text : '';
    if (!Number.isFinite(off) || !text.trim()) continue;
    words.push({ off: Math.max(0, off), text });
  }
  return words.length ? words : undefined;
}

/**
 * Validate an LLM's .kklyrics reply (raw JSON or markdown with a ```json
 * block) into a LyricsClip. Readable errors; out-of-range starts are clamped
 * with warnings, structurally broken lines are dropped.
 */
export function parseKkLyrics(text: string): ParseLyricsResult {
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
  if (doc.kind !== undefined && doc.kind !== 'kklyrics') {
    warnings.push(`"kind" is "${doc.kind}" — expected "kklyrics".`);
  }

  if (!Array.isArray(doc.lines)) {
    return { ok: false, errors: ['"lines" must be an array of line objects.'], warnings };
  }
  if (doc.lines.length === 0) {
    return { ok: false, errors: ['"lines" is empty — write at least one line.'], warnings };
  }
  if (doc.lines.length > LYRICS_MAX_LINES) {
    warnings.push(`${doc.lines.length} lines exceeds the ${LYRICS_MAX_LINES} cap — extra lines dropped.`);
  }

  const errors: string[] = [];
  const lines: LyricsLine[] = [];
  let clampedStarts = 0;
  for (let i = 0; i < doc.lines.length && lines.length < LYRICS_MAX_LINES && errors.length < 8; i++) {
    const l = doc.lines[i] as Record<string, unknown>;
    if (typeof l !== 'object' || l === null) {
      errors.push(`lines[${i}] is not an object.`);
      continue;
    }
    if (!Number.isFinite(Number(l.start))) {
      errors.push(`lines[${i}].start is missing or not a number.`);
      continue;
    }
    if (typeof l.text !== 'string' || !l.text.trim()) {
      errors.push(`lines[${i}].text is missing or empty.`);
      continue;
    }
    const rawStart = Number(l.start);
    const start = clamp(rawStart, 0, LYRICS_MAX_START);
    if (start !== rawStart) clampedStarts++;
    const words = sanitizeWords(l.words);
    lines.push({ start, text: l.text.trim(), ...(words ? { words } : {}) });
  }
  if (clampedStarts > 0) {
    warnings.push(`${clampedStarts} line start${clampedStarts === 1 ? '' : 's'} out of range — clamped.`);
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  if (lines.length === 0) {
    return { ok: false, errors: ['No usable lines.'], warnings };
  }

  lines.sort((a, b) => a.start - b.start);
  return {
    ok: true,
    errors,
    warnings,
    clip: { lines },
    name: typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : undefined,
  };
}
