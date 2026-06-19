# Wire Animation Plan

**Status: SHIPPED (uncommitted) — 2026-06-17. Decided via grilling session.**

Make patch wires convey signal as visual information: easier to grab on touch,
brighter signal glow, and directional **flow dots** that travel source→dest so
the user reads where signal goes and how hot it is. A Display-tab toggle
(`display.wireAnim`, default on) disables all of it for a static look / low-power
mode. **Toggle already shipped** (settings.ts + OptionsDialog.svelte); the
rendering work below is pending.

All rendering lives in **`app/src/canvas/PatchCanvas.ts`**. The whole feature is
**stateless** — every value is derived per-frame from `performance.now()` plus
existing live data (`appState.meters`, `appState.noteFlash`,
`appState.controlValues`). Nothing to allocate, track, or tear down.

## Current state (baseline)

- `tick()` (L1518) clears `wireLayer` and redraws every wire each frame.
  - Per type: audio modulates alpha/width by `meter.rms`/`meter.peak`; note
    flashes for `NOTE_FLASH_MS`; control glows by value. No motion.
- `hitTestWire` (L1469): samples 24 fixed bezier points, checks distance to each
  **point**; threshold 8px mouse / 14px touch, `/world.scale.x`.
- `bezierPoints` (L1451): 24-step cubic bezier, handle `clamp(dist*0.45, 30, 200)`.
- `strokePath` (L1602): polyline stroke, base width 2.

## Decisions (locked)

1. **Click problem = both** (look too thin to aim *and* clicks miss), touch-first.
2. **Hit-test fix:** point-to-**segment** distance over consecutive bezier
   points (kills between-sample gaps on long wires); raise touch threshold
   14→20, keep mouse 8, keep `/world.scale.x`.
3. **Visual width:** base 2→**3px**, **scale-aware** (divide width by
   `world.scale.x` → constant on-screen size). Accepted tradeoff: wires look
   proportionally bolder than modules when zoomed far out.
4. **Brighter glow:** keep existing width/alpha signal modulation, raise the
   audio alpha response so wires read "hot" sooner. This is the "brighter pulse"
   ask. Glow stays as the underlay.
5. **Traveling dots on ALL three types**, always source→dest, **signal-throttled**
   (no dots when idle → calm patch):
   - **note:** 1 dot, `t = (now - noteFlash[from]) / TRAVEL_MS`, reuse the
     existing flash timestamp, fade as it nears dest. One dot per note event.
   - **audio:** 2 dots, `t = (now*speed + phaseHash(wire.id) + i*0.5) % 1`,
     speed + brightness ∝ `meter.rms`; silence → no dots.
   - **control:** 2 dots, speed ∝ `controlValues[from]`.
6. **Dot look:** wire's type color with a near-white high-alpha core, radius
   ~1.5× current stroke width. Reads as a glowing packet that keeps type color.
7. **Perf:** no special bounding yet — 2 dots/wire, but the throttle means only
   *active* wires draw dots, so cost scales with live signal not patch size.
   Revisit (viewport cull / dot cap) only if a real patch lags on mobile GPU.
8. **Toggle:** `display.wireAnim` (default true). When off: no dots, and wires
   render at a constant rest width/alpha (no signal glow) — fully static.

## Implementation steps

1. **(DONE) Setting.** `DisplaySettings.wireAnim: boolean` in `core/settings.ts`
   (default true, sanitized `!== false`); checkbox row in the Display tab of
   `ui/OptionsDialog.svelte` (`.opt-wire-anim`).
2. **Hit-test.** Rewrite `hitTestWire` inner loop to point-to-segment distance;
   touch threshold 20.
3. **Width.** In `tick()` divide the final stroke width by `world.scale.x`; bump
   base 2→3. Apply the same scale factor to the selected-wire halo at L1558.
4. **Glow.** Raise audio alpha curve (e.g. `0.35 + min(0.6, rms*3)`); keep note
   / control as-is or nudge to match.
5. **Dots.** Add a `drawFlowDots(wire, points, now)` helper called after each
   wire's `strokePath` in the `tick()` loop. Interpolate a position from the
   existing 24-pt `points` array at fractional `t` (lerp between the two nearest
   samples). Draw filled circle (type color) + smaller white-core circle.
   `phaseHash` = cheap hash of `wire.id` so audio streams aren't all in lockstep.
6. **Gate.** Read `appSettings().display.wireAnim` once at the top of `tick()`;
   when false, skip dots and force flat width/alpha.

## Deferred micro-decisions (sensible defaults at impl)

- note `TRAVEL_MS` ≈ 400.
- audio dot base `speed` constant (cable feel, not literal sample rate).
- white-core alpha / radius ratio — tune by eye.

## Testing

- E2E: `__kkMeta` already exposes wire counts; add a flag/counter for "dots
  drawn this frame" or assert `display.wireAnim=false` yields zero dot draws.
  Follow existing poll-based conventions (no hard pixels / sleeps).
- Manual: dense patch on touch (grab reliability), zoom extremes (scale-aware
  width), toggle off → fully static.
