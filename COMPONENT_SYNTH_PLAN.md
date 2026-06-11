# Plan: Component-built instruments + AI patch generation from primitives

## Goal

Kill the monolithic generator modules (`synth`, `sampler`, `drum`). Every instrument is
built from primitive components with a wired-up face, exactly like the existing Init Poly
Synth starter. The AI patch generator composes whole instruments from primitives instead
of dropping a single `synth` token.

## Decisions (locked via grilling)

- **Full decomposition**, build the missing primitives. No monolith fallback.
- `smpl` = old sampler DSP, kept as an **atomic note-in component voice** (not shattered).
- `wtosc` = new wavetable-oscillator component (ports synth's wavetable render).
- Synth FM = `osc→osc` audio phase-mod (osc already has an FM audio in). Drop the 6 fixed
  FM algorithms. Synth filter = existing `vcf`.
- Drum = `composer` (piano-roll rows = drum map) → fan-out to **16** `smpl` → `mixer` →
  face. No new sequencer component; choke lives on `smpl` + worklet.
- **Hard break** migration: old files referencing `synth`/`sampler`/`drum` warn + drop the
  module. No load aliases.
- AI spec: principles + 3 rewritten component examples. No recipe library, no repair loop.
- Starters: **Init Poly Synth** (exists), **Mono Synth** (new), **Sampler** (new),
  **Drum Kit** (new). Each = component group + collapsed face.

---

## Phase 1 — New components (engine + registry)

### 1a. `smpl` component (registry.ts + engine-worklet.js)
Lift the old `sampler` worklet class → rename to `SmplModule`, recategorize def to
`category: 'component'`. Carry over root/mode(1shot/loop)/attack/decay/sustain/release/
level/voices. **Add params:**
- `pan` (−1..1, 0) — per-voice pan (drum kit needs it).
- `trigNote` (0..127, −1=any) — fire only on this incoming pitch.
- `fixedPitch` (0/1) — when on, ignore incoming pitch, always play at `root`.
- `chokeGroup` (0..8, 0=none) — voices sharing a non-zero group cut each other (3 ms fade,
  reuse drum's choke fade logic).

Worklet: note-in path filters on `trigNote` when set; `fixedPitch` forces playback rate at
root; choke handled across same-group `smpl` modules at the host level (the host already
iterates modules per block — add a choke pass keyed by `chokeGroup`).

Sample plumbing: each `smpl` is its own module → sample keyed by `moduleId` (existing
sampler path, `core/samples.ts`). No `#pad` keys.

### 1b. `wtosc` component (registry.ts + engine-worklet.js)
New `WtoscModule`. Ports: `pitch` (control in, poly), `posMod` (control in), `fm` (audio
in), `out` (audio). Params: `wave`/table loading via existing sample msg (port synth's
wavetable split + `wtPos` scan), `wtPos`, `octave`/`semi`/`fine`, `fmAmt`, `level`.
Reuse synth's wavetable render + default 4-frame table.

### 1c. Engine registration
Add `smpl` and `wtosc` to **both** `ENGINE_MODULE_TYPES` (engine.ts) and `EngineModuleType`
(messages.ts). (Gotcha: missing either → syncGraph silently drops the module.)

---

## Phase 2 — Delete monoliths

- registry.ts: remove `synth`, `sampler`, `drum` defs (and the now-unused consts:
  `SYNTH_MODES`, `FM_ALGO_COUNT`, `DRUM_DIVISIONS`, `defaultDrumPads`/`defaultDrumPattern`
  if only used by drum).
- engine-worklet.js: remove `SynthModule`, `SamplerModule`, `DrumModule` + `FM_ALGOS`
  table + drum step-seq/choke code (port choke into the smpl choke pass first).
- engine.ts / messages.ts: drop the three from the type unions.
- core/aiimport.ts: retarget `TYPE_ALIASES` (e.g. `superSaw`→`osc`); drop synth/sampler/drum
  alias targets.
- core/drumkit.ts: keep (default 8 synthesized samples reused by the Drum Kit starter).

---

## Phase 3 — UI retarget (drum/sampler plumbing)

- **SampleEditor.svelte / state**: open path keyed off `smpl` module (existing sampler
  name-click path already does this; just generalize off the deleted `sampler` type check).
- **SampleLibrary.svelte / PatchCanvas.dropTargetAt**: drop resolves to an `smpl` module.
  Remove `padIndexAt` / drum-pad drop branch.
- **ModuleView.ts / PatchCanvas.ts**: remove drum/sampler custom-face rendering; `smpl` uses
  the generic ctrl-grid face. Remove `moduleId#pad` sample-key handling in `core/samples.ts`.
- **Tutorial.svelte**: replace any `synth`/`drum` step references with component starters.

---

## Phase 4 — Starters (ui/starters.ts)

Each starter: add component modules, wire, set params, `createGroup`, `setGroupFace`,
insert collapsed-to-face (match Init Poly Synth pattern). Add all four to `STARTERS`.

- **Mono Synth**: `voice`(voices=1, glide) → 2× `osc`(detuned) → `vcf` → `vca`; `adsr`→
  `vca.cv`; env→`vcf.amt`; `lfo`→`vcf.mod`. Face: osc/filter/env/lfo knobs + out meter.
- **Sampler**: single `smpl` + face (root/mode/adsr/level knobs, load-sample hint). Tiny group.
- **Drum Kit**: `composer` → fan-out (one note bus) → 16× `smpl` (`fixedPitch=1`,
  `trigNote`=36+n, choke groups for hats) → `mixer` → face. Preload `drumkit.ts` kit into
  pads 1–8; 9–16 empty. Face = per-voice level/pan knobs + composer grid + out meter.

---

## Phase 5 — AI spec (core/aispec.ts)

- Catalog auto-lists components already (no change needed there).
- Add a **Signal flow** section to FORMAT_RULES: `note → voice → osc → vcf → vca`;
  `adsr → vca.cv`; `lfo → vcf.mod`; FM = `osc.out → osc.fm`; drum = `composer.notes →
  smpl×N` with `trigNote`/`fixedPitch`; audio must reach `audioOut`.
- Rewrite the **3 examples** as component graphs:
  1. Subtractive bass (voice→osc→vcf→vca, adsr, sequencer) + face.
  2. FM/percussive voice (osc→osc fm) + face.
  3. Drum kit (composer→smpl×N) + face.
- Keep optional `face` block. Drop monolith param references.

---

## Phase 6 — Tests

- Rewrite/replace e2e: `drum.spec.ts`, `sample-editor.spec.ts`, `library.spec.ts`,
  `components.spec.ts`, `ai-import.spec.ts`, `composer.spec.ts`, `smoke.spec.ts`,
  `faces.spec.ts` (palette count shifts: −3 defs +2 defs +new starters).
- Unit: drop synth/sampler/drum-specific tests; add `smpl` choke + `trigNote`/`fixedPitch`
  tests, `wtosc` table-scan test, aispec example-parse test (existing pattern — spec parses
  its own examples).

---

## Risk notes

- **Choke port** is the trickiest reuse: move drum's cross-voice choke into a host-level
  pass over `smpl` by `chokeGroup` before deleting `DrumModule`.
- **Palette/e2e counts**: every count-based selector (memory: `hasText 'Synth'`,
  `:not(.starter-entry)`, palette=43) shifts — sweep e2e for hardcoded counts.
- **Composer fan-out**: one composer `notes` out → many `smpl` ins is plain note fan-out
  (already supported). `trigNote` filtering is what makes rows address distinct pads.
- Bigger AI graphs raise mis-wiring rate; accepted (no repair loop this pass).
