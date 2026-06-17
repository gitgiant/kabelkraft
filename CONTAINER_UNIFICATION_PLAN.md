# Container Unification Plan

> **STATUS: SHIPPED 2026-06-17.** Phases 1–5 + 6-lite on main (chrome, PoleRail,
> drawTileBody, ResizeController, titleButtons, clearTileChildren). Full phase 6
> (ContainerTile facade) dropped — residual dup too thin to justify it.

Kill the duplicated tile-chrome between `ModuleView` (1352 lines) and `GroupView`
(1072 lines). Both `extends Container` (PIXI) and independently re-implement body
draw, title bar, resize, pole rail, double-tap toggle, and headless-embed body.
This refactor extracts the shared chrome into a `canvas/tile/` layer that both
views compose — mirroring the existing `resize.ts` (stateless geometry funcs) and
`faces/` (`FaceRenderer` collaborator) precedents.

## Decisions (locked — grill 2026-06-16)

1. **Scope: broad.** Unify chrome shared by *all* tiles (every leaf module +
   groups), not just container-modules. The verbatim dup (`titleButton`, body,
   resize) spans the leaf/container boundary because it lives on the `ModuleView`
   class that serves both — a container-only cut can't reach it.
2. **Shape: composition, no base class.** Stateless draw/button helpers + stateful
   controllers (`ResizeController`, `PoleRail`) that each view *owns*, like
   `FaceRenderer`. Both views stay `extends Container`. Chosen over a `TileView`
   base class: composition is phaseable (extract one helper at a time, each step
   green), matches the two precedents in this layer, and avoids reparenting two
   divergent construction flows behind a pile of abstract hooks.
3. **Data model untouched.** Visualizer/composer stay engine-backed modules;
   groups stay engine-invisible. UI-layer only. No group-of-one wrapping.
4. **Facade gated.** A `ContainerTile` facade (one orchestration shared by groups
   and container-modules) is *not* pre-committed. After phase 5, measure residual
   orchestration dup and decide if the facade earns its keep. The prize is killing
   the ad-hoc dup; the facade is one possible means, not the goal.
5. **Tint resolution stays as-is.** `setLiveColor`/`accent` (module) and
   `tintForGroup`/`poleHidden` (group/state) are already centralized — not a dup
   target.

## Shared seams (verified against current code)

| Concern                | ModuleView                              | GroupView                                | Dup kind |
|------------------------|-----------------------------------------|------------------------------------------|----------|
| `titleButton` helper   | ~446                                    | 252–274                                  | **verbatim** |
| port dot draw          | `drawPortDot` 581                       | `drawDot` 1044                           | **byte-identical** (param `port` vs `type`) |
| body draw              | `drawBody` 367                          | inline 129–134                           | near-dup |
| headless embed body    | `buildHeadlessBody` 341                 | inline 136–157                           | near-dup |
| double-tap toggle      | 493–508 (manual 350ms timer)            | 162–168 (same)                           | near-dup |
| resize handles + drag  | `mountResizeHandles`/`beginResize` 617/645 | 321/356                               | mechanism shared, write target diverges |
| pole/port rail         | `buildPorts` 538                        | `place` 202                              | layout shared, port model diverges |
| PresetBar / Tooltip    | shared component                        | shared component                         | already shared |
| resize geometry        | `resize.ts` (`RESIZE_DIRS` etc.)        | `resize.ts`                              | already shared |

## ResizeController split (policy object)

Controller **owns the mechanism**: 8 persistent handles, raf-coalesced drag loop,
pointer listeners, `beginUndoable`, double-click→reset routing, `overPole`.
View supplies a **policy object** (all divergence is *what to write*, not *how to
drag*):

```ts
interface ResizePolicy {
  getStart(): { w: number; h: number; x: number; y: number };
  worldScale(): number;
  onDrag(dir: ResizeDir, dx: number, dy: number, start): { w: number; h: number }; // writes size (+ face-element scaling); returns clamped
  onAnchor(dir: ResizeDir, w: number, h: number, start): void;                      // sets x/y for n/w edges
  rerender(): void;                                                                  // rebuild() | buildCollapsedTile()
  onResetDefault?(): void;  // module: delete instance.w/h
  overPole?(px: number, py: number): boolean;  // group
}
```

ModuleView writes `instance.w/h` raw and reads clamped back via its `w`/`h`
getters; GroupView writes `group.w/h` or `face.width/height` and scales face
elements — both stay inside their `onDrag`.

## PoleRail (view pre-filters)

PoleRail owns layout (`y = TITLE_H + 18 + i*26`, x=0 in / w out), the dot
`Graphics` + `drawDot(type, highlight)` (folded — identical in both), hitArea
r=20, the `portCenters` map, and `highlight(key, on)` for wire-drag hover. View
passes a normalized **visible** list (hidden-pole / `poleHidden` filtering stays
view-side so the tint-pole rule never leaks into the rail):

```ts
interface Pole { key: string; type: PortType; direction: 'in' | 'out';
  onDown(e): void; onUp(e): void; tooltip(e): string[]; }
```

The group tint pole is just another input `Pole` in the list (renders left-edge
with other inputs — no special path).

## Title-bar button table (data-driven)

Kills the scattered `instance.type === 'composer'/'visualizer'/'lyrics'` switches
in `buildTitle` + `containerToggle`. A canvas-layer table keyed by module type →
`(view) ⇒ ButtonSpec[]` (`{ glyph, tip, onTap }`; glyph may depend on state, e.g.
composer ⛶/⤡). The assembler lays buttons right-to-left and **derives the inset
from button count** (kills hardcoded `rightInset` 44/22/4). The toggle action
lives in the same table entry. Group supplies its own static spec the same way.
Lives in `tile/titleButtons.ts` (entries call `appState` actions → UI layer).

## Phases (risk-ascending, commit-per-phase, branch `feat/container-unification`)

1. **`tile/chrome.ts`** — `addTitleButton` + `attachToggleTap` + `attachHeadlessBody`.
   Verbatim extraction, zero visual change. Both views adopt.
2. **`tile/PoleRail.ts`** — fold identical dot draw + layout. Low visual risk.
3. **`drawTileBody`** (in `chrome.ts`) — body draw. Visual → screenshot parity.
4. **`tile/ResizeController.ts`** — policy-object split. Behavioral → manual drag pass.
5. **`tile/titleButtons.ts`** — data-driven button table; folds the `type===` switch.
6. **(gated) `ContainerTile` facade** — only if residual orchestration dup justifies.

Each early phase is verbatim/reversible/green and de-noises `ModuleView` before
the one structural fold (step 5). The table (5) depends on the assembler +
helpers from 1–4, so it lands last among the committed phases.

## Verification (each phase)

- `tsc` + `svelte-check` 0 errors
- vitest green
- e2e: `faces.spec` / `face-views.spec` / `tint.spec` + group/module interaction specs
- **Screenshot parity** before/after on draw phases (1 body, 5 titlebar); **manual
  resize/drag pass** on phase 4. (Existing e2e deliberately avoids hard-coded
  pixels → won't catch visual drift; screenshots are the only gate that will.)

PR at end of the committed phases (1–5); facade decision (6) folded into the PR
discussion or a follow-up.
