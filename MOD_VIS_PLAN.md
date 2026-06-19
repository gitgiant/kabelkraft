# MOD_VIS_PLAN — Modulation visualization (animate knobs + displays under mod control)

Status: **P1 in progress** · branch `feat/tts-module` (carry over or split later)

## Goal

When a param is under live modulation (a control wire into its mod input), its
**knob** animates (range arc spanning the modulation reach + pointer riding the
live value) and its **display** redraws at the live modulated value. Example:
LFO → VCF `mod` → the cutoff knob sweeps and the filter curve slides left/right.

## Decisions (resolved in grilling, 2026-06-18)

- **Value source:** worklet reports the *effective* (post-modulation) value — it
  already does the DSP. Main thread just renders.
- **Knob visual:** range arc (lo→hi) + moving pointer at `cur`.
- **Arc bounds:** worklet sends `[cur, lo, hi]` per modulated param, in native
  units. `lo`/`hi` = helper evaluated at source extremes (0 and 1), sorted.
- **Scope v1:** all mod-inputs that map to a visible knob + their displays.
- **Cadence:** redraw at status rate (~30Hz), gated on a status-version bump
  (not every 60Hz ticker frame). No interpolation.
- **Display style:** instantaneous only (curve sweeps to `cur`; no ghost band).
- **Worklet shape:** refactor each module's mod math into a **pure helper** used
  by BOTH `render()` and reporting → zero drift (CLAUDE.md multi-file trap).
- **Persistence:** none — purely live/visual.
- **Snap-back:** param leaving `modVals` triggers one redraw → restores stored
  value + drops arc.
- **Polyphony:** per-voice mod collapses to voice-0 for knob/display (v1).
- **Tests:** unit on the pure helpers; e2e polls `modVals` state (no pixels).

## Target table (param ⇐ mod input ⇐ helper)

| module   | param  | mod input  | helper                         |
|----------|--------|------------|--------------------------------|
| vcf      | cutoff | mod        | `vcfCutoff(cutoff, amt, m)`    |
| vca      | level  | cv         | `vcaGain(level, cv)`           |
| osc      | pwm    | pwmMod     | `oscPwm(pwm, pm)`              |
| fmosc    | index  | idxMod     | `fmIndex(index, im)`           |
| wtosc    | wtPos  | posMod     | `add01(wtPos, pm)`             |
| wtosc    | morph  | morphMod   | `add01(morph, mm)`             |
| addosc   | tilt   | tiltMod    | `addTilt(tilt, tm)`            |
| granular | pos    | posMod     | `add01(pos, pm)`               |

Helper formulas (from worklet render(), verbatim):
- `vcfCutoff = clamp(cutoff * 2^(m*amt), 20, 18000)`
- `vcaGain   = level * clamp(cv, 0, 1)`
- `oscPwm    = clamp(pwm + pm, 0.05, 0.95)`
- `fmIndex   = max(0, index + im)`
- `add01     = clamp(x + d, 0, 1)`
- `addTilt   = tilt + tm*24`  (knob ctrlNorm clamps to param range)

`lo = min(h(0), h(1))`, `hi = max(h(0), h(1))`, `cur = h(cval(modIn, 0))`.
Reported only when the mod input is actually wired.

## Phases

**P1 — Worklet (helpers + reporting).** `engine-worklet.js`: add pure helper fns;
rewire the 8 render() sites to call them; add `reportMods()` per module returning
`[{paramId, cur, lo, hi}]`; main process loop collects into a `modVals` object,
attached to the status message (only non-empty entries).

**P2 — Protocol + state.** `messages.ts`: add `modVals` to `StatusMessage`.
`engine.ts`/`state.ts`: store `appState.modVals`, bump a status-version counter
each status; expose on `__kkMeta`.

**P3 — Knob hook.** `ModuleView.buildKnob`: redraw reads effective =
`modVals[id][pid]?.cur ?? c.get()`; if modulated, draw range arc (lo/hi via
`ctrlNorm`, same 270° sweep) + pointer. Generic per-frame trigger in
`updateLive` re-runs modulated params' redraws, gated on status-version change;
snap-back on transition out of `modVals`.

**P4 — Displays.** `vcf.ts`: add `live()` redrawing the curve at effective
cutoff. `wtosc.ts`/`granular.ts`/`spectrum.ts`: point existing live/refresh at
effective values from `modVals`.

**P5 — Tests.** E2E `e2e/mod-anim.spec.ts`: classicRig (lfo→vcf.mod), poll
`modVals[vcf].cutoff` present + `lo<lo<=cur<=hi` + `cur` varies across samples +
`modVersion` advances. **DONE.**

> Unit tests of the pure helpers deferred: they live in the AudioWorklet global
> script (`engine-worklet.js`, no build step / no export seam), so they can't be
> imported without duplicating the formula. The e2e covers them end-to-end
> through the real worklet instead.

## Status: ALL PHASES SHIPPED (uncommitted on `feat/tts-module`)

- Knobs animate (arc lo→hi + pointer at cur) for vcf/vca/osc/fmosc/wtosc/addosc/
  granular via the central `buildKnob` hook.
- Displays: vcf curve sweeps live; addosc spectrum re-tilts; wtosc/granular
  already tracked mod via worklet disp data.
- `npm run check` 0 errors; mod-anim + synth/effects/modmatrix/faces specs green.
