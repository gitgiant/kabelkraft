# Module / Container Presets — Implementation Plan

Save / load / select configuration **presets** on modules and containers
(groups). A preset captures the tunable state — dial settings and the custom
wiring *inside* a container — so a single synth group can carry `bass`, `lead`,
`pad` variants and switch between them. Presets live inside the thing they
belong to, so saving a project (`.kkproj`) or exporting a custom module
(`.kkmod`) carries its presets along. AI can generate a new preset from the
current configuration.

This document is the agreed spec from the design grilling. Read it before
touching code.

## Concepts

- **Plain-module preset** — a snapshot of one module's `params` (+ `data`).
- **Container preset** — a snapshot of every member module's `params`/`data`
  **plus the internal wires** (wires whose both endpoints are inside the
  container). The member *set* is frozen: presets never add or remove modules,
  never touch positions / size / color / label / face / poles, and never touch
  wires that cross the container boundary. This keeps the container's external
  port surface and outside wiring stable across a preset switch.
- **Snapshot model (hardware-synth style)** — the container always has its live
  working state. A preset is a *saved snapshot*. **Load** copies preset → live;
  **Save** copies live → preset. Turning a dial edits live state only, which
  makes the active preset *dirty*. Switching away from a dirty preset prompts.
- **Default preset** — every module/container conceptually has one named
  `Default`, materialized **lazily** on first preset-menu interaction
  (snapshots then-current live state) so untouched things add zero file bytes.

## Data model

```ts
// core/module.ts
interface PresetWire { from: { moduleId: string; portId: string };
                       to:   { moduleId: string; portId: string } }

interface ModulePreset {
  id: string;
  name: string;
  category: string;                 // "Default" when unset
  // plain-module shape:
  params?: Record<string, number>;
  data?: Record<string, unknown>;
  // container shape:
  members?: Record<string /*memberId*/,
                   { params: Record<string, number>; data?: Record<string, unknown> }>;
  wires?: PresetWire[];             // internal wires only
}
```

Both `ModuleInstance` (core/module.ts) and `ModuleGroup` (core/graph.ts) gain:

```ts
presets?: ModulePreset[];
activePresetId?: string;   // last loaded preset; dirty = live ≠ that snapshot
```

**Dirty** is *computed*, never a stored flag: deep-compare live member
params/data + internal wires against the active preset. Memoize on the existing
graph-revision counter so it recomputes only after a mutation. A parent-preset
load that happens to set values identical to a child group's active preset
leaves the child *not* dirty — honest and cheap.

## Storage

- **`.kkproj`** — `serialize.ts` spreads whole instances/groups, so
  `presets`/`activePresetId` round-trip for free. (`deserializeProject` keeps
  them via `{ ...mod }` / `{ ...group }`.)
- **`.kkmod`** — `exportKkmod` already emits members/groups whole.
  `importKkmod` rebuilds instances field-by-field and **drops** `presets`
  today. It must copy them **and remap ids**: each preset's `members` keys and
  `wires` endpoints (module ids) go through `moduleIdMap`; nothing references
  group ids inside a preset. `remapPreset()` (core/preset.ts) does this.

## Behavior

- **Load** preset → live: overwrite member params/data, delete current internal
  wires, recreate the preset's internal wire list (validated via
  `graph.connect`, so control single-fan-in still holds). Set `activePresetId`.
- **Save**: overwrite the active preset from live state.
- **Save As…**: new id, prompt name + category (free text, existing categories
  offered as suggestions; default category string `"Default"`).
- **Rename / Duplicate / Delete / Revert** (Revert = reload active, drop dirty).
- **Randomize**: write randomized values into **live** state (dirty), honoring
  each param's `randomizable` flag. Does not create a preset.
- **Nested containers**: a parent preset is authoritative over all descendant
  modules (flattened via `modulesInGroup`). A child group's own preset library
  is orthogonal; after a parent load the child shows honest computed dirty.

Every preset op is one undo step: `beginUndoable()` → mutate → `syncEngine()`
(full `engine.syncGraph`, which absorbs bulk wire + param changes).

## UI

Title bar (option B), on **all** modules and groups:

- `◀ PresetName ▶` rendered in the title strip. Click the **name** → preset
  menu popup. On narrow tiles, trim the module + preset names (never hide).
  (Overall UI sizing is being reworked later.)
- Arrows step a **flat** list across all categories, wrapping; disabled at one
  preset.
- **Preset menu popup** (small Svelte dialog): presets grouped by category with
  a checkmark on the active one (click = load, with dirty-prompt); buttons
  Save / Save As… / Rename / Duplicate / Delete / Revert / **Randomize** /
  **✨ Generate with AI**.
- After AI generation the picker shows the transient label `✨ AI Generated`
  (dirty, *not* saved); Save converts it into a real named preset.

## AI preset generation

`core/aipreset.ts` (spec + validator) and `generatePreset(graph, containerId,
prompt, settings)` in `aiprovider.ts`, mirroring `generateFace` — the
container's **live** member ids ride along in the spec, so the output needs no
remap.

- **Spec input**: each member (id, type, label), its param specs (id, label,
  min/max, options, current value), its ports, the current internal wires, the
  active preset as a starting point, and the user prompt.
- **Output**: new params per member **+ a new internal wire list**. Validate
  every wire via `graph.canConnect`; drop invalid wires (repair loop feeds
  errors back, as the other AI flows do). The model does **not** author member
  `data` — clip/pattern generation already lives in the composer AI flow.
- **Result**: applied to **live** state (dirty), labeled `✨ AI Generated`, not
  saved until the user Saves. The AI button always opens the prompt popup; when
  no provider is configured the popup shows the settings link (existing
  pattern), rather than being disabled.

## Phasing

1. **Data model + serialization** — types + fields, `.kkproj` round-trip test,
   `.kkmod` `importKkmod` copy + `remapPreset`, unit tests. *(this phase)*
2. **State logic** — `captureLivePreset` / `applyPreset` / `liveMatchesPreset`
   (dirty) in core/preset.ts; load/save/saveAs/rename/duplicate/delete/revert/
   randomize on AppState, each undoable + engine-synced; lazy Default.
3. **UI** — title-bar `◀ name ▶` picker in ModuleView + GroupView; preset menu
   Svelte popup; trim-on-narrow.
4. **AI** — core/aipreset.ts spec + validator, `generatePreset`, wire-in to the
   menu button + prompt popup.
