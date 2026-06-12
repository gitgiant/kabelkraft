# Plan: visualizer engine — wireable visual graph, WebGPU, AI generation

## Decisions (locked via grilling)

- **Container model.** The `visualizer` module becomes a group-like container
  with a nested visual sub-canvas (reuses group/sub-canvas editing machinery).
  Signals enter via poles (audio, notes, control, text, visual); output is a
  composited frame. Main patch canvas stays clean.
- **Render tech: WebGPU + WGSL, thin custom abstraction.** No three.js (JS
  dead-end for the Phase-3 C++ core). WGSL shaders and render-graph semantics
  port natively later via Dawn / `webgpu.h`. Phase-3 plugin UI = webview
  (JUCE 8 `WebBrowserComponent` style), native migration stays open.
  Node interface: `render(inputs: Texture[], params, features) → Texture`.
- **Fallback tier.** No WebGPU → legacy Canvas2D rendering that approximates
  the container's graph (finds Spectrum/Scope/Particles nodes, ignores
  effects) + a "full visuals need WebGPU" notice. No WGSL→GLSL dual backend.
- **One `visual` wire type** = GPU texture stream (RGBA, premultiplied
  alpha). Covers images (PNG alpha preserved), video, webcam, and
  container-to-container chaining. No separate video wire. Resolution/aspect
  handled by per-source `fit` param (cover/contain/stretch); graph runs at
  one canvas resolution.
- **Audio transport: SharedArrayBuffer ring buffer.** Worklet writes raw
  audio (mono + L/R) continuously into the ring (gapless, free); render
  thread pulls 2048-sample windows at its own rate. Rates fully decoupled.
  Requires `crossOriginIsolated` (COOP/COEP — Vite header config; remember
  for hosting). Fallback when not isolated: postMessage windows. In-worklet
  FFT is removed (audio thread does O(n) copies only).
- **Analysis UI-side, per rendered frame.** FFT, bands (bass/mid/high),
  centroid computed render-side into a shared `VisFeatures` object:
  `wave, waveL, waveR, spectrum, level, peak, bands, onset, centroid,
  notes[], ctrl`. Onset detection worklet-side (gapless audio there).
  Raw windows stay in the pack so future nodes can derive anything
  (lissajous, chromagram, custom-resolution FFT).
- **Framerate: locked set 60/120/144/240** (vsync-divider per container)
  + resolution scale. Tile thumbnails always thrifty (¼ rate, low res).
- **Text: dedicated `text` wire type** (event stream
  `{ text, final? }`, strings only — numbers stay on `control`). Producers
  are main-canvas modules: **Speech-to-Text** (Web Speech API, interim
  results for karaoke feel; whisper.cpp native path later), **Transport
  Text** (bar|beat|time formats), **Text Input** (typed, emits on Enter),
  **Note Names** (note in → "C#4"). Consumer: **Text Layer** node
  (OffscreenCanvas rasterization → texture; static/scroll/typewriter/
  fade-stack modes; param fallback when port unwired).
- **Visual graph is a DAG — cycles forbidden in v1.** Feedback aesthetics
  via a dedicated **Feedback node** (internal previous-frame texture;
  zoom/rotate/translate/fade). Wire cycles retrofittable later (1-frame
  delay at cycle edge) by relaxing validation.
- **Modulation rule.** Hot visual-node params (size, amount, speed, mix…)
  get `control` in-ports; param value is the base when unwired. The
  **Features** node presents the audio pole as control-rate outs
  (level/bands/onset…), so "bass → blur radius" is one wire.
- **Display.** Every container renders its Output node; tile = live
  thumbnail; ⛶ = single big overlay (full rate/res) + **pop-out browser
  window** (`window.open`) for projector/second-monitor use. Containers on
  the main canvas form their own mini-DAG: topological render order, one
  shared `GPUDevice` + texture pool. Hidden/unwired/occluded containers are
  culled (Feedback freezes while culled — accepted). Multi-window
  multi-container deferred.
- **Migration: same type id, upgrade in place.** `visualizer` keeps ports
  (`in`/`notes`/`mod`) so existing wires survive; gains `data.graph`. On
  load, modules without `graph` get one synthesized from the old `scene`
  param (scope/spectrum/particles → equivalent node graph; `gain` → node
  param). Fresh palette drop = init graph **audio pole → Spectrum →
  Output**. `scene`/`gain` params retired after migration. No "classic"
  zombie type.
- **AI generation.** Spec pack gains a visual section: node catalog (types,
  ports, params + ranges, one-line semantics), wire rules, 2–3 few-shot
  example graphs (chosen deliberately — biggest quality lever). Container
  button: prompt + spec + **current graph JSON** (enables iterative edits)
  → JSON graph → validation gauntlet (known types, port-type match, DAG,
  param clamp, exactly one Output) → one auto-retry with validator errors
  → apply as single undo step, or visible error leaving container
  untouched. Spec also exportable/copyable for manual chat use.
- **Shared AI context builder.** `buildAiContext()` summarizes relevant
  graph state (e.g. pole wiring: "audio: yes-stereo, notes: yes, text:
  no") and is used by **all** AI flows — patch, MIDI, project, visualizer.
  AI may suggest missing producers in a human-readable note shown after
  apply ("wire a Speech-to-Text module for lyrics").

### v1 node catalog

- **Sources:** Spectrum (bars/radial/waterfall), Scope (line/lissajous),
  Particles (GPU-instanced; onset/notes/continuous emit; `color` in),
  Shapes (tiled/single primitives, modulatable), Gradient/Solid (`color`
  in), Image, Video (file loop), Webcam, Text Layer.
- **Effects:** Blur, Pixelate, Feedback, Kaleidoscope, Color Grade,
  Chroma Shift, Warp, Bloom, Mirror.
- **Combine:** Blend (2-in; add/screen/multiply/alpha-over/difference +
  mix; stack for N).
- **Util:** Features (audio pole presenter), Output (frame pole).
- **Deferred:** 3D nodes (**Phase 2 focus** — mesh/tunnel/camera,
  primitive-based, no full scene graph), fluid/physics sims, user WGSL
  shader-code node, visual LFO (reuse audio LFO via control pole).

### Code layout

New `src/visual/`:

- `types.ts` — `VisNodeDef`, `VisFeatures`, texture interface.
- `registry.ts` — node defs, mirrors `ModuleDef` shape (palette/inspector/
  AI-spec reuse).
- `runtime.ts` — `GPUDevice` singleton, topo scheduler, texture pool,
  rate divider, culling.
- `ring.ts` — SAB ring + postMessage fallback (both end in a
  "latest window" accessor).
- `features.ts` — UI-side FFT/bands/centroid.
- `nodes/` — TS + WGSL per node.
- `migrate.ts` — scene→graph synthesis.

Container editor reuses `GroupView`/`PatchCanvas` sub-canvas machinery.
`VisualizerOverlay.svelte` rewritten on the runtime; `ModuleView` tile
draws the thumbnail texture.

---

## Phase 1 — Core (init-visualizer parity) ✅ done 2026-06-11

- `src/visual/` skeleton: types, registry, runtime (single container, no
  chaining yet), ring + features.
- Worklet: remove in-worklet FFT/spectrum; write mono+L/R into SAB ring
  (postMessage window fallback when not `crossOriginIsolated`); keep
  onset + level + note/ctrl feed. Vite COOP/COEP headers.
- `visualizer` module → container with `data.graph`; `migrate.ts` for old
  patches; init graph = audio pole → Spectrum → Output.
- Nodes: Features, Spectrum, Output.
- Tile thumbnail (¼ rate) + overlay on the new runtime; Canvas2D legacy
  path stays as the no-WebGPU tier.
- `__kkMeta`: `visNodes`, `visWires`, frame counter. Unit tests for
  migration/serialization (GPU-free).

## Phase 2 — Catalog ✅ done 2026-06-12 (incl. graph editor)

- Sources: Scope, Particles, Shapes, Gradient/Solid, Image, Video, Webcam.
- Effects: Blur, Pixelate, Feedback, Kaleidoscope, Color Grade, Chroma
  Shift, Warp, Bloom, Mirror. Combine: Blend.
- Control in-ports on hot params; `color` wire ins (Particles, Gradient,
  Color Grade).
- Pop-out display window.
- (3D nodes are the *next* major catalog push after v1 ships.)

## Phase 3 — Text

- `text` wire type + pole support + `PORT_TYPE_COLORS` entry.
- Text Layer node (OffscreenCanvas → texture; animation modes).
- Producers: Speech-to-Text (Web Speech, interim results), Transport Text,
  Text Input, Note Names.
- whisper.cpp local setup explored separately (native STT path).

## Phase 4 — Chaining

- `visual` wire legal on main canvas between containers (+ visual pole).
- Cross-container topological scheduling, shared device/texture pool,
  visibility culling.

## Phase 5 — AI

- Spec pack visual section + few-shot example graphs.
- Container AI-generate button: prompt + spec + current graph → validate
  (gauntlet + auto-retry) → undoable apply.
- `buildAiContext()` shared context builder; retrofit into patch/MIDI/
  project AI flows. Spec export/copy button.

## Phase 6 — Polish

- Per-container rate (60/120/144/240) + resolution-scale controls.
- Canvas2D fallback tier finalized (graph-approximation rendering).
- E2e per conventions (poll-based, `__kkMeta` counts, no pixel asserts;
  skip-with-reason where WebGPU unavailable in CI). Perf pass: texture
  pool reuse, culling verification.

---

## Later / explicitly out of v1

- 3D node set (primitive-based: camera, instanced meshes, tunnels) — the
  declared Phase-2-of-product focus after this plan ships.
- Wire cycles in the visual graph (relax validation, delay-at-edge).
- User-authored WGSL shader node (security + scope).
- Multi-window multi-container display routing.
- whisper.cpp local STT (user asked for setup help when we get there).
- Native (non-webview) C++ UI; Dawn-based native render core.
