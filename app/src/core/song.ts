/**
 * Song layer data model — SONG_PLAN.md phase 2.
 *
 * FL-playlist paradigm: a project owns one Song — a clip library plus
 * placements on purely visual lanes. Every clip carries its own target
 * (the moduleId whose note-in it drives), so moving a placement between
 * lanes never changes the sound. Placements are refs into the library;
 * "make unique" forks a copy. Lives in ModuleInstance-free space: the
 * canvas graph never references song data, only targets point back.
 */

import {
  sanitizeNote,
  sortNotes,
  COMPOSER_MIN_LENGTH,
  COMPOSER_MAX_LENGTH,
  type ComposerNote,
} from './composer';

export interface SongClip {
  id: string;
  name: string;
  /** 'automation' reserved for v2 automation clips — do not repurpose. */
  kind: 'notes';
  notes: ComposerNote[];
  /** Loop/clip length in beats. */
  length: number;
  /**
   * Module whose note-in this clip drives; null = unrouted (placed blocks
   * render dead/silent until retargeted). Deleting the module on canvas
   * leaves the target dangling on purpose — relink beats data loss.
   */
  target: string | null;
  /** Chip tint as 24-bit RGB, undefined = theme default. */
  color?: number;
}

export interface SongPlacement {
  id: string;
  clipId: string;
  /** Visual lane index (lanes carry no routing). */
  lane: number;
  /** Beats from song start. */
  startBeat: number;
}

export interface SongLane {
  name?: string;
  color?: number;
}

export interface Song {
  clips: SongClip[];
  placements: SongPlacement[];
  lanes: SongLane[];
  /** PAT = free-loop jam layer plays; SONG = playlist plays. */
  mode: 'pat' | 'song';
  /** Ruler loop region in beats (SONG mode); null = play through. */
  loop: { start: number; end: number } | null;
}

export const SONG_MIN_LANES = 4;

export function defaultSong(): Song {
  return { clips: [], placements: [], lanes: laneFill([], SONG_MIN_LANES), mode: 'pat', loop: null };
}

// -- ids ---------------------------------------------------------------------

let nextClipId = 1;
let nextPlacementId = 1;

export function newClipId(): string {
  return `c${nextClipId++}`;
}

export function newPlacementId(): string {
  return `p${nextPlacementId++}`;
}

/** For deserialization: keep generated ids ahead of loaded ones. */
function bumpId(existing: string, prefix: string, next: number): number {
  const n = Number(existing.replace(new RegExp(`^${prefix}`), ''));
  return Number.isFinite(n) && n >= next ? n + 1 : next;
}

// -- construction / sanitizing -------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function newSongClip(init?: Partial<Omit<SongClip, 'id' | 'kind'>>): SongClip {
  return {
    id: newClipId(),
    name: init?.name ?? 'Clip',
    kind: 'notes',
    notes: init?.notes ? sortNotes(init.notes.map(sanitizeNote)) : [],
    length: clamp(Number(init?.length) || 16, COMPOSER_MIN_LENGTH, COMPOSER_MAX_LENGTH),
    target: init?.target ?? null,
    ...(init?.color !== undefined ? { color: init.color } : {}),
  };
}

/** Fork a clip for "make unique": same content, fresh id, numbered name. */
export function forkClip(clip: SongClip, takenNames: Set<string>): SongClip {
  const base = clip.name.replace(/ \d+$/, '');
  let n = 2;
  while (takenNames.has(`${base} ${n}`)) n++;
  return {
    ...clip,
    id: newClipId(),
    name: `${base} ${n}`,
    notes: clip.notes.map((note) => ({ ...note })),
  };
}

function laneFill(lanes: SongLane[], min: number): SongLane[] {
  const out = lanes.slice();
  while (out.length < min) out.push({});
  return out;
}

/** End of the last placement in beats — the song's implicit length. */
export function songEndBeat(song: Song): number {
  const byId = new Map(song.clips.map((c) => [c.id, c]));
  let end = 0;
  for (const p of song.placements) {
    const clip = byId.get(p.clipId);
    if (clip) end = Math.max(end, p.startBeat + clip.length);
  }
  return end;
}

/**
 * Sanitize a raw song from a loaded project (any vintage, hand-edited, AI).
 * Unknown-clip placements drop; targets are kept even if the module is gone
 * (dead-block rendering handles it — the graph isn't known here anyway).
 */
export function sanitizeSong(raw: unknown): Song {
  if (!raw || typeof raw !== 'object') return defaultSong();
  const r = raw as Record<string, unknown>;

  const clips: SongClip[] = [];
  const clipIds = new Set<string>();
  for (const c of Array.isArray(r.clips) ? (r.clips as Record<string, unknown>[]) : []) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || clipIds.has(c.id)) continue;
    // v2 clip kinds (automation) load as-is only when this build knows them.
    if (c.kind !== undefined && c.kind !== 'notes') continue;
    clips.push({
      id: c.id,
      name: typeof c.name === 'string' && c.name ? c.name : 'Clip',
      kind: 'notes',
      notes: sortNotes(
        (Array.isArray(c.notes) ? (c.notes as Partial<ComposerNote>[]) : []).map(sanitizeNote),
      ),
      length: clamp(Number(c.length) || 16, COMPOSER_MIN_LENGTH, COMPOSER_MAX_LENGTH),
      target: typeof c.target === 'string' ? c.target : null,
      ...(typeof c.color === 'number' ? { color: c.color } : {}),
    });
    clipIds.add(c.id);
    nextClipId = bumpId(c.id, 'c', nextClipId);
  }

  const placements: SongPlacement[] = [];
  const placementIds = new Set<string>();
  for (const p of Array.isArray(r.placements) ? (r.placements as Record<string, unknown>[]) : []) {
    if (!p || typeof p !== 'object' || typeof p.clipId !== 'string') continue;
    if (!clipIds.has(p.clipId)) continue;
    const id = typeof p.id === 'string' && !placementIds.has(p.id) ? p.id : newPlacementId();
    placements.push({
      id,
      clipId: p.clipId,
      lane: Math.max(0, Math.round(Number(p.lane) || 0)),
      startBeat: Math.max(0, Number(p.startBeat) || 0),
    });
    placementIds.add(id);
    nextPlacementId = bumpId(id, 'p', nextPlacementId);
  }

  const lanes: SongLane[] = [];
  for (const l of Array.isArray(r.lanes) ? (r.lanes as Record<string, unknown>[]) : []) {
    lanes.push({
      ...(typeof l?.name === 'string' ? { name: l.name } : {}),
      ...(typeof l?.color === 'number' ? { color: l.color } : {}),
    });
  }
  const laneMin = Math.max(SONG_MIN_LANES, ...placements.map((p) => p.lane + 1));

  const rl = r.loop as { start?: unknown; end?: unknown } | null | undefined;
  const loopStart = Math.max(0, Number(rl?.start) || 0);
  const loopEnd = Number(rl?.end) || 0;
  const loop = rl && loopEnd > loopStart ? { start: loopStart, end: loopEnd } : null;

  return {
    clips,
    placements,
    lanes: laneFill(lanes, laneMin),
    mode: r.mode === 'song' ? 'song' : 'pat',
    loop,
  };
}
