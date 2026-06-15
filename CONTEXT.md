# KabelKraft — Domain Context

Crisp definitions for the project's load-bearing terms. Keep entries short; sharpen
them when a grilling/architecture session clarifies one. Architecture vocabulary
(module, seam, adapter, depth, deep/shallow, leverage, locality, deletion test) is
defined in the improve-codebase-architecture skill's LANGUAGE.md, not here.

## Core nouns

- **Module** — a node in a patch. Has a type (`peq`, `vcf`, `osc`, `delay`…), params,
  data, and ports. Defined declaratively by a **ModuleDef** in `app/src/core/registry.ts`
  (`MODULE_DEFS`), which is meant to be the single source of truth for a type but today is
  partially duplicated in `engine.ts`, `messages.ts`, and `public/engine-worklet.js`.
- **Patch / Graph** — the set of modules + wires + groups the user builds. Held by
  `Graph` (`core/graph.ts`); mutated through `AppState` (`state.ts`).
- **Registry** — `core/registry.ts`. The catalog of `ModuleDef`s + shared param enums.

## "Face" — two distinct meanings (disambiguation)

The word **face** is overloaded in this codebase. Always qualify which one:

- **Module-tile face** — the in-tile UI of a single module: its knobs, sliders, meters,
  and any bespoke display (PEQ curve, sequencer step grid, oscilloscope). Built by the
  per-type `buildXxxFace` code in `canvas/ModuleView.ts`. This is what `ModuleDef.customFace`
  and `CUSTOM_LAYOUT_TYPES` refer to.
- **Group face** — a user-designed control panel for a *group* of modules (a `group.face`
  spec). Lives in `core/face.ts` / `core/aiface.ts`, see `FACE_VIEWS_PLAN.md`. Unrelated
  to the per-module-tile rendering below.

## Face-rendering seam (architecture session 2026-06-15)

The deepening target for `ModuleView.ts` (3671 lines). Vocabulary agreed:

- **FaceRenderer** — a per-view object that renders one module type's *module-tile face*.
  Interface: `build(view: ModuleView): void` and optional `refresh(view): void`. It is
  **stateful per instance** — `build` creates the Pixi Graphics and stashes its own
  live-redraw refs (e.g. the old `vcfCurveG` / `meterRect` fields), and `refresh` reads
  them to redraw live curves/meters. Replaces the two 28-branch `if (type===…)` switches
  in `buildFace()` and `refreshParams()` with a single map lookup.
- **FACE_RENDERERS** — `Record<moduleType, FaceRenderer>` in `canvas/faces/`. Every
  registry type maps to a renderer (decided: every type gets its own entry/file, including
  trivial ones).
- **ctrlGridFace** — the shared default renderer for pure-param modules (delay, reverb,
  lfo…): just lays out the knob grid. Trivial types reference it rather than hand-rolling.
- **Custom vs compositional faces** — *custom* faces own their whole tile (peq, vcf,
  envelope, knob, slider, xy, button, mixer, composer, levels, recorder, modmatrix,
  intelligence). *Compositional* faces are a `ctrlBand` + a named display + optional edge
  rails (meter / device row): sequencer, smpl, visualizer, wtosc, pluck, resonator, addosc,
  granular, keyboard, transport, audioIn/Out, midiIn/Out, text family.
- **Renderer-gets-the-view** — decided contract: a FaceRenderer receives the whole
  `ModuleView` (not a narrowed context). Consequence: ModuleView's shared helpers
  (`ctrlBandH`, `buildCtrlGrid`, `buildVMeter`, `buildGrMeter`, `buildKnob`, `buildSelector`,
  `buildFader`, `visibleParams`, `paramCtrl`) become public/internal API. Goal of the
  refactor is **navigability + testability per type**, not decoupling from `appState`.
