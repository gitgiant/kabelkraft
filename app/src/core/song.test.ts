import { describe, expect, it } from 'vitest';
import { Graph } from './graph';
import { MODULE_DEFS } from './registry';
import { DEFAULT_TRANSPORT } from './types';
import { deserializeProject, serializeProject } from './serialize';
import {
  defaultSong,
  forkClip,
  newSongClip,
  sanitizeSong,
  songEndBeat,
  SONG_MIN_LANES,
  type Song,
} from './song';

function songFixture(): Song {
  const a = newSongClip({ name: 'Lead A', notes: [{ start: 0, pitch: 60 } as never], length: 8, target: 'm3' });
  const b = newSongClip({ name: 'Bass', length: 16, target: null, color: 0x336699 });
  return {
    clips: [a, b],
    placements: [
      { id: 'p1', clipId: a.id, lane: 0, startBeat: 0 },
      { id: 'p2', clipId: a.id, lane: 0, startBeat: 8 },
      { id: 'p3', clipId: b.id, lane: 1, startBeat: 4 },
    ],
    lanes: [{ name: 'lead' }, {}, {}, {}],
    mode: 'song',
    loop: { start: 0, end: 16 },
  };
}

describe('song model', () => {
  it('newSongClip sanitizes notes and clamps length', () => {
    const clip = newSongClip({ notes: [{ start: -5, pitch: 300 } as never], length: 9999 });
    expect(clip.kind).toBe('notes');
    expect(clip.notes[0].start).toBe(0);
    expect(clip.notes[0].pitch).toBe(127);
    expect(clip.length).toBe(256);
    expect(clip.target).toBeNull();
  });

  it('forkClip deep-copies notes and numbers the name past taken ones', () => {
    const clip = newSongClip({ name: 'Riff', notes: [{ start: 1, pitch: 60 } as never] });
    const copy = forkClip(clip, new Set(['Riff', 'Riff 2']));
    expect(copy.id).not.toBe(clip.id);
    expect(copy.name).toBe('Riff 3');
    expect(copy.notes).toEqual(clip.notes);
    expect(copy.notes[0]).not.toBe(clip.notes[0]);
  });

  it('songEndBeat = end of the last placement', () => {
    const song = songFixture();
    expect(songEndBeat(song)).toBe(20); // Bass at 4 + length 16
    expect(songEndBeat(defaultSong())).toBe(0);
  });

  it('sanitizeSong drops placements of unknown clips and unknown clip kinds', () => {
    const song = sanitizeSong({
      clips: [
        { id: 'c1', name: 'ok', notes: [], length: 8 },
        { id: 'c2', kind: 'automation', points: [], length: 8 }, // v2 — skipped here
      ],
      placements: [
        { id: 'p1', clipId: 'c1', lane: 0, startBeat: 0 },
        { id: 'p2', clipId: 'c2', lane: 1, startBeat: 0 },
        { id: 'p3', clipId: 'ghost', lane: 2, startBeat: 0 },
      ],
      mode: 'song',
    });
    expect(song.clips.map((c) => c.id)).toEqual(['c1']);
    expect(song.placements.map((p) => p.id)).toEqual(['p1']);
    expect(song.mode).toBe('song');
  });

  it('sanitizeSong survives garbage and defaults sensibly', () => {
    expect(sanitizeSong(undefined)).toEqual(defaultSong());
    expect(sanitizeSong(42)).toEqual(defaultSong());
    const song = sanitizeSong({ clips: 'nope', placements: {}, lanes: null, mode: 'zebra' });
    expect(song.clips).toEqual([]);
    expect(song.mode).toBe('pat');
    expect(song.lanes.length).toBe(SONG_MIN_LANES);
  });

  it('sanitizeSong grows lanes to cover the highest placed lane', () => {
    const song = sanitizeSong({
      clips: [{ id: 'c1', name: 'x', notes: [], length: 4 }],
      placements: [{ id: 'p1', clipId: 'c1', lane: 9, startBeat: 0 }],
    });
    expect(song.lanes.length).toBe(10);
  });
});

describe('song persistence (.kkproj)', () => {
  it('round-trips the song through serialize/deserialize', () => {
    const song = songFixture();
    const json = serializeProject(
      'Song Test', new Graph(MODULE_DEFS), { ...DEFAULT_TRANSPORT },
      undefined, undefined, undefined, undefined, song,
    );
    const loaded = deserializeProject(json, MODULE_DEFS);
    expect(loaded.song).toEqual(song);
  });

  it('defaults to an empty PAT-mode song when absent (older projects)', () => {
    const json = serializeProject('Old', new Graph(MODULE_DEFS), { ...DEFAULT_TRANSPORT });
    const loaded = deserializeProject(json, MODULE_DEFS);
    expect(loaded.song.clips).toEqual([]);
    expect(loaded.song.placements).toEqual([]);
    expect(loaded.song.mode).toBe('pat');
  });

  it('keeps dead targets on load (relink beats data loss)', () => {
    const song = defaultSong();
    song.clips.push(newSongClip({ name: 'Orphan', target: 'm999' }));
    const json = serializeProject(
      'Dead', new Graph(MODULE_DEFS), { ...DEFAULT_TRANSPORT },
      undefined, undefined, undefined, undefined, song,
    );
    expect(deserializeProject(json, MODULE_DEFS).song.clips[0].target).toBe('m999');
  });
});
