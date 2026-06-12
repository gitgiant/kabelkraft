# Plan: face passthrough views — live container views on group faces

Goal: container faces get dynamic UI — e.g. a synth group's face hosting an XY
pad, its composer's clip view, and its visualizer's live scene.

## Decisions (locked via grilling)

- **Interactivity**: live content + tile-level interaction (knob drags,
  playhead, live frames). Full editors are NOT hosted on the face; they open
  via double-click on the view.
- **Targets**: any member module's tile (composer, visualizer, peq, …) AND
  child-group faces (sub-panels). One generic mechanism.
- **Data model**: single new `FaceElementKind` `'view'`; reuses `el.moduleId`
  for module targets, new `el.groupId` for child-group targets.
- **Scoping**: targets restricted to group members (nested included) — same
  rule as `bindableParams`. Containment is a tree ⇒ face-in-face recursion is
  acyclic by construction; no cycle guard.
- **Rendering**: embed real `ModuleView`/`GroupView` instances in a new
  *headless* mode (no title buttons, no ports, no resize handles, no body
  drag), title bar cropped off via mask, uniformly scaled + letterboxed into
  the element rect; registered for live updates.
- **Editor UX**: FaceEditor gets a draggable member list — drop a member onto
  the surface to create a pre-bound view; plus a generic 🗔 View palette item
  with a binding dropdown. In-editor the element is a labeled placeholder at
  the target's aspect (no live mirror in the DOM editor).
- **Double-click on a view**: opens the target's editor (composer → piano
  roll, visualizer → vis graph editor); group expand stays title-bar-only.
- **Sizing**: element freely resizable; content uniform-scaled to fit,
  letterboxed. Default size derived from the target's tile aspect.
- **Phasing**: P1 module targets (this plan); P2 child-group faces as
  sub-panels (headless GroupView).

---

## Phase 1 — core model (face.ts + kkmod)

- `FaceElementKind` += `'view'`; `FaceElement` gains `groupId?: string`
  (child-group target — serialized now, rendered in P2).
- `ELEMENT_DEFAULTS.view = { w: 160, h: 120 }`.
- New `viewTargets(graph, groupId)`: member modules (nested included) →
  `{ moduleId, label }` (same shape as `meterTargets`).
- `pruneFaceBindings`: `'view'` branch — clear `moduleId` when target leaves
  the group; clear `groupId` when it's no longer a descendant group.
- `importKkmod`: remap `el.groupId` through `groupIdMap` (today only
  moduleId/moduleId2/tintSourceId are remapped).

## Phase 2 — headless ModuleView embed (canvas render)

- `ModuleView` constructor gains `opts?: { headless?: boolean; onOpen?: () => void }`.
  Headless `rebuild()`: drawBody (skip resize grip) + `buildFace()` only — no
  title text/buttons, no ports, no resize handles. Body becomes a plain
  static hit target (swallows drags so the group tile doesn't move from
  inside the view) with a manual double-tap timer → `onOpen`. Skip `rollMin`
  (an open piano roll must not force-resize the embedded copy).
- `GroupView.buildFaceElement` `'view'` branch:
  - unbound / missing target → inset placeholder box + 🗔 label (matches
    editor placeholder), dimmed like unbound controls.
  - else create headless `ModuleView` for the member instance; visible
    content = tile minus title bar (`contentH = h − TITLE_H`); uniform
    `s = min(el.w / w, el.h / contentH)`, centered, shifted up `TITLE_H·s`,
    rect mask clips the title strip. Caption below, rotation via existing
    wrap.
  - `onOpen`: composer → `appState.openComposer(id)`; visualizer →
    `appState.openVisEditor(id)`; others → none.
  - Track instances in `this.embedded`; cleared on rebuild (children are
    destroyed with the tile).
- `GroupView.updateLive()`: also drive each embedded view —
  `setLiveColor(appState.tintFor(id))` + `updateLive()` (meters, playhead,
  vis thumbnail — `visThumbs` is keyed per module id, so the offscreen
  renderer is shared with the hidden canvas tile for free).
- New `GroupView.refreshParams()` forwarding to embedded views;
  `PatchCanvas` paramsChanged handler calls it next to the module loop.
- `GroupView.embedRect(moduleId)`: tile-local rect + scale of the first view
  element bound to that module.
- `PatchCanvas.clientRectFor(moduleId)`: when the canvas tile is hidden
  (collapsed group), fall back to `groupViews → embedRect` so the piano
  roll / vis editor / big-view overlays pin onto the face element instead.

## Phase 3 — FaceEditor

- `KINDS` += `🗔 View`; placeholder div (icon + bound member label) at the
  element rect; `unbound` styling when no `moduleId`.
- New **Members** list under the palette: every `viewTargets` entry,
  HTML-draggable; drop on the surface creates a pre-bound view at the drop
  point, sized 160 × aspect of the target def's face area (clamped).
  Clicking a member adds it at center (touch fallback).
- Inspector for views: Module dropdown over `viewTargets` (meter pattern).

## Phase 4 — tests

- Unit (`src/core/face.test.ts`): `viewTargets` membership; prune clears a
  view binding when the module leaves the group / keeps it otherwise;
  `importKkmod` remaps `el.groupId`.
- e2e (`e2e/face-views.spec.ts`, util.ts poll conventions, run from `app/`):
  group with a composer inside → face editor → add view (palette + member
  drop) → save → collapsed tile renders the embed; double-click the view
  opens the piano roll anchored over the tile; binding survives save/load.
- Full unit + e2e run.

## P2 (next, not in this build)

- Headless `GroupView` so `el.groupId` views render child faces as live
  sub-panels (interaction routing into nested face elements included).
- Revisit with the planned ContainerTile unification.

## Risks / notes

- Embedded ModuleView double-renders a module that also exists (hidden) on
  the canvas — param state is shared via the same `ModuleInstance` object;
  only draw objects duplicate. Watch perf with many views (vis thumbnails
  already ¼-rate + off-screen culled via `tileOnScreen`, which works nested
  because it uses global transforms).
- `appState.openComposer` forces the hidden canvas composer tile to its
  roll-min size — invisible, harmless, reverts on close.
- AI face generation (`aiface.ts`) doesn't know `'view'` yet — faces it
  emits simply won't contain views (validator may warn). Extend the spec
  pack later.
- Overlays on **rotated** view elements pin to the unrotated rect — overlay
  panels don't rotate; acceptable.
