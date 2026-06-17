# Plan: stable group poles, editable group I/O, controller-less starters

> **STATUS: SHIPPED — on main.** notethru component, group pole model + stored
> override, Face Editor Poles panel, restructured starters, tests.

## Decisions (locked via grilling)

- **Docking (#1) — ABORTED** this round.
- **Group poles (#3 + #4)**: stop deriving poles purely from crossing wires.
  - Baseline = (member ports with wires crossing the boundary) ∪ (unconnected
    member **in & out** ports). Detaching a wire never deletes a pole (it just
    moves crossing→unconnected, still baseline). **#3 fixed.**
  - Stored **override** on `ModuleGroup`: `poleHidden[]`, `poleAdded[]` (keys
    `moduleId:portId`). Final poles = baseline − hidden + added. Serialized +
    undoable (rides the group spread).
  - **#4 UX** = a **Poles panel in the Face Editor**: baseline poles with
    show/hide toggles + an "add" dropdown (offers hidden poles and
    internally-connected **outputs** as taps; adding an internally-driven input
    is disallowed — control single fan-in).
  - Poles stay 1:1 (one pole = one member port). Can't hide a pole that has an
    external wire (unwire first).
- **Starters (#2)**: strip all built-in note sources; each starter exposes
  exactly **one note-in + one audio-out** pole, silent until wired.
- **New module `notethru`** (component, notes in→out relay) for the Drum Kit's
  one-note-in fan-out. Palette 42→43.

---

## Phase 1 — `notethru` component

- registry.ts: `notethru` def (category `component`): ports `notes` in / `notes`
  out; no params; small size. Add to `MODULE_DEFS` (→ 43).
- engine-worklet.js: `NotethruModule` — `noteOn(voiceId,pitch,vel,extras) →
  routeNoteOn(this.id, voiceId, pitch, vel, undefined, extras)`,
  `noteOff(voiceId,release) → routeNoteOff(this.id, voiceId, release)`; add a
  construction branch; it is note-routing only (skipped in the audio render loop
  like other note modules). Relays inside `runSequencers`/note path — simplest:
  pass-through on receive (no per-block work).
- engine.ts `ENGINE_MODULE_TYPES` + messages.ts `EngineModuleType`: add `notethru`
  (both, or syncGraph drops it).

## Phase 2 — Group pole model (#3) + stored override

- core/graph.ts: `ModuleGroup` gains optional `poleHidden?: string[]` and
  `poleAdded?: string[]` (keys `moduleId:portId`). `createGroup` leaves them
  undefined. Helpers `hideGroupPole/showGroupPole/addGroupPole/removeGroupPole`
  (undoable) on state.
- PatchCanvas.ts `boundaryPorts(group)` rewrite:
  1. crossing-wire ports (current logic) → baseline set with direction/type.
  2. ∪ every **unconnected** member in/out port (no wire touches it) — direction
     from the port spec, type from the port spec.
  3. − `poleHidden`, + `poleAdded` (resolve member port spec for label/type).
  - Recurse into nested member groups for member-port enumeration (mirror
    `modulesInGroup`).
- serialize.ts: free (group spread already serializes new fields); confirm undo
  snapshots carry them.
- Result: detaching the note wire from a synth group keeps the note-in pole
  (now unconnected, still baseline).

## Phase 3 — Face Editor Poles panel (#4)

- ui/FaceEditor.svelte: add a **Poles** section. List baseline poles (label,
  direction, wired?) each with a show/hide checkbox (writes `poleHidden`).
  "Add pole" dropdown lists addable member ports (hidden baseline poles +
  internally-connected member **outputs**); selecting adds to `poleAdded`.
  Disable hide on wired poles; disable adding internally-driven inputs.
- state.ts: the pole mutators above + a `'faceEditorChanged'`-style emit so the
  canvas rebuilds the group tile. One undo step per edit.
- GroupView already renders `boundaryPorts`; rebuilding the group view picks up
  changes (PatchCanvas rebuilds on group change).

## Phase 4 — Restructure starters (#2)

ui/starters.ts — every starter ends with one note-in pole + one audio-out pole:

- **Mono Synth**: delete the `keyboard`. `voice.notes` becomes unconnected →
  note-in pole; `vca.out → audioOut` (external) stays the out pole.
- **Init Poly Synth**: delete `keyboard` + `sequencer` (+ their wires).
- **Sampler**: delete `keyboard`. `smpl.notes` = note-in pole.
- **Drum Kit**: delete `composer`. Add a `notethru` (note-in pole) → fan its
  `out` to all 16 `smpl.notes`. Add a `mixer`; route the 16 `smpl.out` into it
  (audio sums) → `mixer.out → audioOut` = the single audio-out pole. Group now
  = [notethru, 16 smpl, mixer]. Default kit preload unchanged.
- Keep `audioOut`/`levels` external (the "speaker"), as today.

## Phase 5 — Tests

- Unit: `boundaryPorts`-equivalent logic (extract a pure helper if needed) —
  unconnected input stays a pole after wire removal; hidden/added override;
  `notethru` relays notes (graph-level). aispec/registry catalog count.
- e2e: palette count 46→47 (smoke.spec, ui-polish.spec). New pole specs:
  detach note wire from a grouped synth → note-in pole persists (#3); Face
  Editor hide/add pole round-trips + survives save/load. Starter specs: a
  spawned synth has a note-in pole and is silent until a keyboard is wired.
- Re-run full unit + e2e.

## Risks / notes

- `boundaryPorts` now enumerates **all** member ports → watch nested-group
  recursion and performance on big groups (cache per rebuild).
- Unconnected-output baseline may surface poles users didn't have before on
  existing groups — acceptable (that's the feature); hide handles it.
- Drum Kit mixer has 5 channels; 16 `smpl.out` sum fine into shared channels
  (audio inputs sum multiple wires).
- `notethru` adds nothing to the audio render loop — ensure it's in the
  note-passthrough branch, not the audio dispatch (no `outL`).
