# Oscillator Rework Plan

Separate FM from the plain oscillator, add a dedicated FM oscillator, and
upgrade the wavetable oscillator with 2-table morphing + a live display.

Decided 2026-06-13 via grill session. Component-based philosophy
(monoliths deleted 2026-06-11): oscillators stay as small wireable
primitives, FM is a composable 2-op cell, not a 6-op DX monolith.

Worklet is plain JS in `app/public/engine-worklet.js`, poly per-voice lanes.

---

## Module summary

### `osc` "Oscillator" (reworked)
Pure subtractive oscillator. FM stripped out — all FM now lives in `fmosc`.

- **Remove:** `fm` audio-in port, `fmAmt` param.
- **Add:** `pwmMod` control-in port (LFO/ADSR sweeps pulse width); sub
  oscillator — `subLevel`, `subOct` (-1/-2), `subWave` (sine/square).
- **Keep:** `wave`, `octave`, `semi`, `fine`, `pwm`, `level`.
- **Ports:** `pitch` (ctrl in), `pwmMod` (ctrl in), `out` (audio).
- No custom face — adaptive ctrl grid renders the new dials.

### `fmosc` "FM Osc" (new) — 2-op serial cell
`fm-in -> mod(sine) -> carrier(wave) -> out`. Chain `cellA.out -> cellB.fm`
for serial operator towers (real DX-style algorithms by wiring).

- **Ports:** `pitch` (ctrl in) · `fm` (audio in → **modulator**) ·
  `idxMod` (ctrl in → index) · `out` (audio).
- **Dials:** `Coarse` (ratio 0.5..16, snapped) · `Detune` (ratio fine) ·
  `Index` (0..~10, + idxMod port = enveloped brightness) ·
  `Feedback` (0..1, mod self-feedback: sine→saw→noise) ·
  `Carrier Wave` (sin/tri/saw/sqr) · `Octave`/`Semi`/`Fine` (carrier tuning,
  osc parity) · `Level` · `FM Amt` (external fm-in depth).
- **Per-lane state:** carrier phase, modulator phase, lastMod (feedback).
- No custom face — standard ctrl grid.

> Naming: ratio-fine is **Detune** (carrier-fine keeps **Fine** to avoid clash).

### `wtosc` "Wavetable Osc" (upgraded)
Two loadable tables + morph + live display.

- **Keep:** `pitch`/`posMod`/`fm` ports; `octave`/`semi`/`fine`, `wtPos`,
  `fmAmt`, `level`.
- **Add:**
  - **Slot B** — 2nd loadable table. `Morph` dial + `morphMod` ctrl-in port.
    Shared `wtPos` scans frames in both tables; `Morph` crossfades the
    A-frame ↔ B-frame. 2D space: position × morph.
  - **Custom face** — 2.5D frame stack (current frame highlighted) +
    resolved output cycle. **Live**: worklet reports voice-0 resolved
    `{pos, morph}` in `StatusMessage.wt` → `state.wtData[id]`; marker crawls
    under modulation, falls back to params when unwired.
  - **Sub osc** — `subLevel`/`subOct`/`subWave` (parity with osc).
  - **Richer default table** — 8–16 frame harmonic sweep (musical without
    loading a sample), replaces the 4-frame sin/tri/saw/sqr default.
- **Flag (defer):** raw table reads alias hard at high notes; real fix =
  band-limited mips in the C++ DSP core (PRD Phase 3). JS version stays as-is,
  limitation documented.

---

## Cross-cutting impl notes

- Register `fmosc` in **both** `ENGINE_MODULE_TYPES` (engine.ts) **and**
  `EngineModuleType` (messages.ts) — new types are silently dropped by
  `syncGraph` otherwise (documented gotcha).
- **2 WT slots:** repurpose the vestigial `pad` field for slot A/B keying in
  `sampleKey`/`parseSampleKey` (core/samples.ts); `WtoscModule.wavetable`
  becomes `{A, B}`; `setWavetable(channels, slot)`. Load UI needs an A/B
  target (two name rows or click the A/B region of the display).
- `osc.fm` is gone: old patches with `osc->osc.fm` wires warn+drop on load
  (existing removed-port behavior). Only known reference today is a dead
  `['FM','fmAmt']` face-knob binding in the Init Poly Synth starter
  (`ui/starters.ts`) — fix it.
- `aispec.ts`: add `fmosc` signal-flow recipe + example; note wtosc morph.
- `ModuleView`: `fmosc` = standard grid; `wtosc` gains `customFace`.

---

## Phases

### P1 — osc rework  ✅ SHIPPED 2026-06-13 (bundled with P2)
Smallest blast radius, fully isolated.
1. `registry.ts`: drop `fm` port + `fmAmt`; add `pwmMod` ctrl-in port +
   `subLevel`/`subOct`/`subWave` params.
2. `engine-worklet.js` `OscModule`: drop fm/polyIn.fm read; read
   `controlIn.pwmMod` per lane into pwm; render sub osc per lane, sum into out.
3. `ui/starters.ts`: remove `['FM','fmAmt']` binding from Init Poly Synth osc
   face; optionally add a Sub knob.
4. `aispec.ts`: update osc param list / subtractive recipe.
5. Smoke: unit + e2e (classicRig still green; osc still tones).

> P1+P2 bundled: P1 alone removes FM entirely + breaks the aispec FM example
> (no valid FM mechanism without fmosc), so they shipped together.
> Verified: tsc clean, 258 unit + worklet smoke green, components e2e 6/6
> (incl. new fmosc audio test).

### P2 — fmosc new module  ✅ SHIPPED 2026-06-13
1. `registry.ts`: `fmosc` def (ports + dials above).
2. `engine-worklet.js`: `FmoscModule` class (serial 2-op, per-lane carPh/
   modPh/lastMod, idxMod read, fm-in → modulator).
3. `engine.ts` + `messages.ts`: register type (both lists).
4. `aispec.ts`: FM recipe + validated example.
5. New e2e: place fmosc, wire pitch, assert tone; chain fmosc->fmosc.fm.

### P3 — wtosc morph (DSP + plumbing)  ✅ SHIPPED 2026-06-13
Slots A/B via `pad` 0/1; Morph param + morphMod port; shared wtPos scans both
→ crossfade; sub osc; 8-frame harmonic-sweep default. Two A/B load rows in
ModuleView. WtoscModule already tracks voice-0 `dispPos`/`dispMorph` for P4.
Verified: tsc clean, 258 unit, components e2e 7/7 (morph→silent-B fade test).
1. `core/samples.ts`: slot A/B keying via `pad` field.
2. `registry.ts`: `morph` param + `morphMod` ctrl-in port + sub params.
3. `engine-worklet.js` `WtoscModule`: `{A,B}` wavetable, `setWavetable(ch,slot)`,
   shared wtPos scan in both, Morph crossfade, sub osc, richer default table.
4. `engine.ts`/sample send path: route slot to setWavetable.
5. A/B load UI target.
6. Smoke: morph crossfades, both slots load.

### P4 — wtosc display (live custom face)  ✅ SHIPPED 2026-06-14
Worklet reports voice-0 `{pos,morph}` in `StatusMessage.wtData` → `state.wtData`.
New `core/wavetable.ts` (buildWavetable/defaultWavetable/framePoints, kept in
sync w/ worklet). ModuleView wtosc = ctrl band + display band (2.5D frame stack,
current frame lit + resolved output cycle); live from wtData, param fallback when
engine stopped; tables cached, rebuilt on sample load. Verified: tsc clean,
261 unit (+wavetable.test), components e2e 7/7 (live wtData asserted).
1. `engine-worklet.js`: report voice-0 `{pos, morph}` in `StatusMessage.wt`.
2. `state.ts`: `wtData[id]`.
3. `messages.ts`: StatusMessage.wt field.
4. `ModuleView`: `wtosc` customFace — 2.5D frame stack + resolved cycle,
   live marker from wtData (param fallback), client-side from PCM.
5. e2e: face renders, marker tracks wtPos.

---

## Deferred
- Band-limited / anti-aliased wavetable reads → C++ core (PRD Phase 3).
- osc hard-sync input; osc/wtosc free-run-vs-reset toggle + analog drift
  (offered, skipped this round).
- fmosc fixed-Hz modulator mode; >2 operators in one tile (use chaining).
