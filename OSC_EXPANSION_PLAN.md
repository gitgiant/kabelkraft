# Plan: Additive, Pluck, Granular oscillators + Resonator primitive

> **STATUS: SHIPPED 2026-06-14** (uncommitted on main). All 4 modules built — worklet DSP,
> registry/type registration, customFace displays, AISPEC flows, headless audio tests. tsc clean,
> 265 unit + smoke e2e green, prod build OK. No starters (decided). Sample-load for granular reuses
> the smpl path (`appState.loadSampleFile`, keyed by moduleId).

Adds the three missing synthesis pillars after `osc`/`wtosc`/`fmosc`: **additive**,
**physical-modeling pluck**, and **granular**. Built to stay composable — DSP primitives the
AI can rewire, not hard-baked one-trick boxes. Four new components total.

## Decisions (locked via grilling)

- **4 new modules:** `pluck`, `resonator`, `addosc`, `granular`.
- **Pluck = its own module** (baked exciter + waveguide + animated string display), AND a
  generic **`resonator`** primitive ships alongside it — **shared waveguide DSP core**.
  Pluck = instrument; resonator = "resonate any signal" lego (bowed osc drones, comb on drums).
- **Additive = procedural sine bank** (params, no asset) — the AI authors/modulates spectrum
  with numbers. Real sine partials → zero aliasing + true inharmonic partials (the thing
  `wtosc` can't do).
- **Granular = sample + live-in toggle** (`source` param), **paraphonic** (one grain
  scheduler, grains transposed per held note — `smpl`-style direct notes-in, NOT `voice`
  lanes). Density as **overlap-ratio**, not grains/sec.
- **Displays:** pluck animated string (live), resonator same renderer (small), addosc spectrum
  bars (UI-computed), granular grain-cloud scatter (live). All in v1.
- **No dedicated starters** — all 4 are single drag-in modules; they sell themselves.
- **AISPEC:** catalog flow line for each; `resonator` gets the one worked recipe (multi-module
  excite chain).

---

## Module specs

### `resonator` (category: component) — generic waveguide
Tuned feedback delay + in-loop damping + dispersion. Resonates whatever audio is wired in.

- **Ports:** `pitch` (control in, MIDI/127, poly — *transposes* the delay tuning), audio-in
  (excitation), audio-out. **Pitch unwired → rings at base tuning** (`osc` "plays C4 unwired"
  convention); wired → tracks notes. Same module is both poly instrument-resonator and tunable
  comb FX.
- **Params:** `decay` (**feedback loop-gain** 0–1, ~0.99 — FX comb convention; high notes ring
  shorter), `damp` (in-loop one-pole LP cutoff = brightness), `stretch` (in-loop allpass
  dispersion → inharmonic/metallic), `octave`/`semi`/`fine` (base tuning, pitch-in adds on top),
  `mix` (dry/wet, default full wet).
- **Loop:** `y[n] = x[n] + decay·allpass_stretch(lowpass_damp(y[n−period]))`. `period` =
  fractional, **linear interp** (glide-safe — resonator pitch can slew during sound). Loop gain
  clamped `<1`.
- **Poly:** one delay line **per voice lane** (osc emits N lanes → resonator keeps N feedback
  buffers + per-lane state). Stereo mix in (no lanes) → single L/R delay line at base tuning.
  16 × ~2400 samples = trivial memory.
- **Display:** small string renderer (shared with pluck), reads the delay-line snapshot.

### `pluck` (category: component) — physical-modeling string
Self-contained: built-in exciter → waveguide. Wraps the resonator DSP core with an exciter and
the animated string face.

- **Ports:** `pitch` (control in, poly), audio-out. (No audio-in — exciter is internal.)
- **Params:** `tone` (excitation character, single knob: 0 = soft filtered-noise burst/nylon →
  1 = sharp impulse/pick), `pos` (pluck position 0=bridge…1=middle → comb on the burst,
  bright/nasal vs round/hollow), `decay` (**T60 in seconds**, pitch-compensated → even decay
  across the keyboard), `damp`, `stretch`, `octave`/`semi`/`fine`, `level`.
- **Exciter:** **one-shot** burst at note-on (shaped by `tone`, comb-filtered by `pos`) injected
  into the voice's delay line; rings + **decays** (a pluck, not a drone — sustained/bowed tones
  use `resonator` + external exciter).
- **Poly:** per-voice delay lines, **allpass interp with coefficient frozen per note-on**
  (delay constant during a note → no glitch; bright + in tune across the range). `decay` knob
  (seconds) → per-loop gain computed from the note frequency.
- **Display (customFace):** **animated vibrating string** = the live delay-line displacement.
  Note-on plucks it; watch it ring + damp. Live state via the status push (see below).

### `addosc` (category: component) — additive / procedural sine bank
- **Ports:** `pitch` (control in, poly), `tiltMod` (control in → LFO/env spectral motion),
  audio-out.
- **Params:** `partials` (1–64), `tilt` (dB/oct spectral slope = brightness), `odd` (odd/even
  balance → saw↔square↔clarinet), `inharm` (partial-freq stretch → bell/metal),
  `octave`/`semi`/`fine`, `level`.
- **DSP:** direct sine bank, per voice. **Auto-drop partials above Nyquist** (anti-alias +
  CPU). Heavy case = 16 voices × ~32 partials, accepted.
- **Display (customFace):** **spectrum bars**, UI-computed from params (deterministic, like the
  vcf curve — no worklet push).

### `granular` (category: component) — granular sampler / cloud
- **Ports:** `notes` (note in, direct — `smpl` pattern, tracks held notes), audio-in (live
  source), `posMod` (control in → scan), audio-out.
- **Params:** `source` (sample / live), `freeze` (stop buffer writes; granulate captured slice
  — live mode), `pos` (scan 0–1), `size` (grain len ms), `density` (**overlap-ratio** — grains
  scale with size → no dropouts when sweeping), `spray` (position jitter), `jitter` (pitch
  jitter), `spread` (stereo pan random), `shape` (window: gauss/tukey/tri), `root` (sample→key
  map), `level`.
- **DSP:** one grain scheduler, paraphonic — grains spawned transposed per held pitch. Circular
  record buffer for live-in; reads loaded sample buffer in sample mode.
- **Sample plumbing:** sample mode reuses the moduleId-keyed path (`core/samples.ts`), same as
  `smpl`/`wtosc`.
- **Display (customFace):** **grain-cloud scatter** (live, status push) — grains plotted by
  position × pitch, fading on grain death.
- **Cut for v1.1:** reverse-grain prob, grain-FM, multi-buffer morph.

---

## Build steps

### 1. Engine (engine-worklet.js)
- New classes: `ResonatorModule`, `PluckModule`, `AddoscModule`, `GranularModule`.
- Pluck/resonator share a `Waveguide(interpMode)` helper (per-lane delay line + fractional
  interp + damp LP + stretch allpass). **Pluck:** `interpMode='allpass-frozen'`, exciter
  (one-shot burst: `tone` brightness + `pos` comb), `decay` knob in seconds → per-loop gain via
  note freq. **Resonator:** `interpMode='linear'` (glide-safe), audio-in, dry/wet `mix`, `decay`
  = raw loop-gain, base tuning from octave/semi/fine + pitch-in offset, stereo fallback when no
  lanes.
- Granular: circular buffer (live), grain scheduler, paraphonic note tracking (port `smpl`'s
  note-in/held-note logic).
- **Status push:** in the per-block status assembly (~line 3390), add
  `pluckData[id] = mod.stringSnapshot()`, `resData[id] = ...` (shared), and
  `grainData[id] = mod.grainSnapshot()`. Add to the `postMessage({type:'status', …})` payload.

### 2. Registry (core/registry.ts)
- Add the 4 `ModuleDef`s (`category: 'component'`). `pluck`/`granular` set `customFace: true`;
  `addosc` set `customFace: true`. `granular` gets `defaultData: () => ({ sampleName: '' })`.

### 3. Engine registration (the gotcha)
- Add all 4 to **both** `ENGINE_MODULE_TYPES` (engine.ts) **and** `EngineModuleType`
  (messages.ts). Missing either → `syncGraph` silently drops the module.
- Extend the status-message type with `pluckData`/`resData`/`grainData`.

### 4. UI (canvas/ModuleView.ts)
- `pluck`/`resonator`: animated string renderer — consume `pluckData`/`resData` from the
  status handler (same plumbing as `wtData`/`visData`), redraw the Graphics each frame.
- `addosc`: spectrum-bar renderer, computed from params (no live data) — mirror `drawVcfCurve`.
- `granular`: grain-cloud renderer — consume `grainData`.
- Wire the new live buffers through wherever `wtData`/`visData` is unpacked from the status
  message and stored per-module for the canvas.

### 5. AISPEC (core/aispec.ts)
- Catalog auto-lists the 4 (no change). Add **Signal flow** lines:
  - `addosc`: `voice → addosc → vcf → vca` (LFO → `addosc.tiltMod` for motion).
  - `pluck`: `voice → pluck → vca` (self-exciting; no osc needed).
  - `resonator`: `osc(noise) → vca(env) → resonator` (bowed/comb; `pitch` from `voice`).
  - `granular`: `notes → granular` (sample mode) or `osc/audioIn → granular` (live mode).
- One worked example: **resonator** excite chain (multi-module, AI won't guess
  `noise → vca → resonator`).

### 6. Tests
- Unit: `Waveguide` tuning (delay period vs pitch, fractional interp), resonator stability
  (loop gain clamp), addosc Nyquist-drop, granular overlap-ratio density + paraphonic spawn.
- e2e: palette count shift (+4 component defs) — sweep hardcoded counts. customFace smoke for
  each. aispec example-parse test (spec parses its own resonator example).

## Risk notes
- **Fractional delay interp** is the fiddly bit. Pluck = allpass, coefficient **frozen per
  note-on** (no mid-note glitch; bright + in tune). Resonator = **linear** (glide-safe, slight
  brightness loss, correct for an FX). Get it wrong → high notes go flat/dull.
- **Decay mapping diverges:** pluck `decay` = T60 seconds (convert to per-loop gain via note
  freq → even across keyboard); resonator `decay` = raw feedback loop-gain (comb character). Same
  `Waveguide` mechanism, two knob mappings.
- **Granular paraphony** — held-note tracking + per-note grain transposition from one scheduler;
  cap total live grains to bound CPU.
- **addosc CPU** — 16×32 sines worst case; enforce the partial cap + Nyquist drop hard.
- **Live-display bandwidth** — pluck/granular push per-block snapshots; downsample the string
  buffer and cap grain-scatter point count so the status message stays small.
