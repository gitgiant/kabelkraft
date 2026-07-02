# Song Mode Plan

Arrangement layer: FL-Studio-style playlist over the modular patch — arrange
note clips on a timeline, route each clip to any instrument in the graph, and
bounce the result to .wav. Turns loop-jamming patches into finished songs
without touching the patch layer.

## STATUS (2026-07-02) — phases 1+2 done, uncommitted

- **Phase 1 DONE**: PianoRoll decoupled — `ui/PianoRollCore.svelte` (host-agnostic
  editor: getClip/onNotesChange/onLengthChange/onPreview/playheadBeat/
  onResizeGrip props, exports refresh()/openAi()) + `ui/PianoRoll.svelte`
  rewritten as thin composer host (tile pinning, module data writes, preview
  fan-out, AI request consumption). DOM/classes unchanged → e2e untouched.
  check 0 errors · 288 unit · FULL e2e suite green.
- **Phase 2 DONE**: `core/song.ts` (types + sanitizeSong/newSongClip/forkClip/
  songEndBeat + id gen), `song` field in ProjectFile + serialize/deserialize,
  AppState.song + 'songChanged' event + mutators (addSongClip/deleteSongClip/
  updateSongClip/setSongClipNotes/setSongClipLength/placeSongClip/
  moveSongPlacement/removeSongPlacement/makeSongClipUnique/setSongMode/
  ensureSongLanes/updateSongLane/copyComposerToSong); rides undo snapshots +
  .kkproj + autosave for free. 9 unit tests (core/song.test.ts).
  check 0 errors · 297 unit · smoke/options/composer e2e green.
- **Phase 3 DONE**: `SongMessage` in messages.ts (mode/clips/placements/loop),
  `Engine.sendSong`, `AppState.songEdited()` mirrors every mutation +
  `setSongLoop` + prime on engine start; worklet `SongPlayer` (`runSong`
  fires placed notes straight at clip targets, PAT/SONG gates sequencer+
  composer stepping — arps/live keys stay live, loop wrap loses no downbeat,
  live-edit healing, stop/panic/mode-flip releases). `Song.loop` region added
  (persisted). e2e/song.spec.ts: 5 tests (play/gating/live-input/loop/
  round-trip). check 0 errors · 297 unit · song 5/5 · regression 38/38.
- **Next: Phase 4** — playlist UI (drawer/fullscreen shell, ruler+playhead,
  lanes, blocks, library rail, PianoRollCore overlay, touch spec).

## Decisions (locked)

| Branch | Call |
|---|---|
| Paradigm | DAW timeline, FL-playlist flavor — not scenes, not an arranger module |
| Lanes | Pure visual lanes (name/color only); no per-lane routing or type |
| Clip routing | Every clip carries its own target (`moduleId` of a note-in port; a group pole resolves to its member module). Moving a clip between lanes never changes sound |
| Clip identity | Song-level clip **library**; playlist blocks are refs. Editing a clip updates every placement; "Make unique" forks a copy |
| Composer module | Untouched — stays the free-loop jam instrument. Right-click → "Copy to song" clones its clip into the library |
| Transport | FL-style **PAT/SONG toggle** in toolbar. PAT = today (composers free-loop, playlist silent); SONG = playlist plays, free-loop sequencing (composer/arp clock steps) muted. Live keys/MIDI always audible in both. Audio graph itself never gated — drones/feedback keep sounding |
| Playlist UI | One component, three states: hidden / resizable bottom drawer / fullscreen (maximize button, Esc exits). Toolbar toggle + hotkey. Drawer height remembered (settings store). Clip library = left rail inside the playlist. Optional: 4px ghost playhead strip under toolbar when hidden in SONG mode |
| Clip editing | Double-click block → PianoRoll opens as overlay/split above the playlist, editing the library clip. Same editor for composer + song clips |
| Export | "Export song" = rewind → SONG play → existing master .wav recorder → auto-stop at song end + tail-seconds setting. No offline render in v1 |
| Touch | Full parity via existing `core/mobile.ts` touch mode (see Touch spec) |

### Deferred to v2 (architecture reserves the slot)

- **Automation clips** — FL-style: a clip `kind: 'automation'` carrying a
  breakpoint curve + param target, placed/stacked on lanes like note clips.
  v1 clip schema must include `kind: 'notes'` so this lands without migration.
- **Audio tracks** — real waveform blocks with trim/stretch. v1 workaround:
  long sample in a Sample Voice triggered by a one-note clip.
- **MIDI capture** — record played notes into a clip (count-in, quantize,
  overdub). v1 clip sources: draw in PianoRoll, or copy-from-composer.
- **Offline (faster-than-realtime) render** — needs a render harness for the
  hand-written worklet; realtime bounce is fine until then.
- **Playlist pop-out window** (visuals pop-out precedent). Don't design for it.

## Architecture

### Data model (`src/core/song.ts`, new)

```ts
interface SongClip {
  id: string;
  name: string;
  kind: 'notes';            // 'automation' reserved for v2
  notes: ComposerNote[];    // reuse core/composer.ts note shape + sanitizers
  length: number;           // beats
  target: string | null;    // moduleId with a note-in port; null = unrouted/dead
  color?: number;
}
interface SongPlacement { clipId: string; lane: number; startBeat: number }
interface SongLane { name?: string; color?: number }
interface Song {
  clips: SongClip[];
  placements: SongPlacement[];
  lanes: SongLane[];
  mode: 'pat' | 'song';
}
```

- Lives on `AppState` next to `graph`; all mutation through AppState (undo,
  events) like everything else. Persisted as a `song` section in `.kkproj`.
- Deleted target module → placements stay, block renders red/silent, retarget
  via the clip's target chip. Library never orphaned by canvas edits.
- Single tempo + time signature per song (existing transport fields). No
  tempo map in v1. Song end = end of last placement.

### Engine (worklet-side song player)

Sample-accurate playback lives in the worklet, like `ComposerModule` — immune
to main-thread jank:

- New `SongPlayer` in `engine-worklet.js`: holds mirrored placements+clips,
  evaluates the beat window per block, emits noteOn/noteOff **directly to each
  clip's target module id** (no note-wire fan-out needed — target is explicit).
- Protocol: new messages in `messages.ts` (`songSync` full-state,
  `songMode`, and reuse of transport messages). **Keep every song type in the
  messages.ts seam — do not create a fifth copy of the module manifest**
  (registry/engine/messages/worklet drift trap, CLAUDE.md).
- Live-edit healing: `syncActive`-style note-off for notes deleted/moved while
  sounding (precedent: `ComposerModule.syncActive`).
- PAT/SONG mode flag in the worklet gates composer/arp clock stepping (SONG)
  vs song player (PAT). Keyboard/MIDI note messages bypass the gate.
- Loop region: ruler drag sets `[startBeat, endBeat)`; worklet wraps the beat
  window. Ruler click = seek (existing `songPosition` jump path).

### UI (`src/ui/Playlist.svelte` + children, new)

- Bottom drawer: DOM/Svelte (not Pixi) — virtualized lane rows + absolutely
  positioned clip blocks; canvas untouched.
- Ruler: bars/beats, click-seek, drag loop region, playhead (rAF from
  transport beat, same source as composer playhead).
- Blocks: drag to move (snap to grid, configurable division), edge-drag to
  resize (loop-tile the clip like FL when longer than clip length — v1 may
  ship resize=clip-length only if tiling is hairy; note it in STATUS),
  target chip shows routed module (learn-style picker to retarget).
- Library rail: clip list, drag onto lanes, rename/recolor/delete,
  "Make unique" on placements.
- PianoRoll overlay hosting (after decouple PR).
- Export button in playlist header → bounce flow.

## Touch spec (rides existing `isTouchMode()`)

- On clip: drag = move; long-press = context menu (make unique / delete /
  retarget); double-tap = PianoRoll overlay; fattened edge handles for resize.
- Empty lane: drag = pan; pinch = time zoom; two/three-finger tap undo/redo
  (already global).
- Ruler: tap = seek, drag = loop region (same as mouse).
- Small viewport (phone): playlist opens fullscreen by default; tablets get
  drawer. Library rail becomes overlay drawer (matches existing panels).
- No new detection code — all gated on `isTouchMode()` / `onTouchModeChange`.

## Phases

1. **PianoRoll decouple** (own PR): extract editor from module-grown hosting
   so it can edit any `{ notes, length }` clip with a save-back callback.
   Composer behavior unchanged; e2e green.
2. **Data model + persistence**: `core/song.ts`, AppState integration, undo,
   `.kkproj` round-trip. Unit tests (sanitize like `clipFromData`).
3. **Engine song player**: messages.ts protocol, worklet `SongPlayer`,
   PAT/SONG gating, loop region, live-edit healing. Headless-audio e2e:
   place clip → SONG play → meter moves; PAT mutes playlist and vice versa.
4. **Playlist UI**: drawer/fullscreen shell, ruler+playhead, lanes, block
   drag/resize/snap, library rail, target chip, copy-from-composer,
   PianoRoll overlay. Touch behaviors per spec. E2E via `__kkMeta`
   poll-based helpers (no pixel/sleep asserts).
5. **Export bounce**: auto-stop at song end + tail setting, riding the
   existing recorder. E2E: exported wav duration ≈ song length + tail.

Ship gate per phase: `npm run check` clean, unit + e2e green, run from `app/`.
