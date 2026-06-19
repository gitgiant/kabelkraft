# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

KabelKraft — browser modular-audio playground (drag modules on infinite canvas,
wire them, build sound + visuals). Domain vocabulary: [CONTEXT.md](CONTEXT.md) —
read it; "module", "face", "group" are load-bearing. Roadmap/stack: [PRD.md](PRD.md).

## Commands

Run from `app/`, not repo root (root pulls a 2nd Playwright → all specs fail):

```sh
cd app && npm install
npm run dev          # vite, port 8080, HTTPS if ../key.pem + ../cert.pem exist
npm run build
npm run check        # svelte-check + tsc — the typecheck
npx vitest run       # unit (src/**/*.test.ts)
npx playwright test  # e2e + headless audio; system Chrome, separate server :5199
# single: npx vitest run <file> | -t "name";  npx playwright test e2e/<f>.spec.ts
```

E2E poll app state via `__kkMeta` / `e2e/util.ts` helpers — no hard-coded pixels
or sleeps. Chrome runs with fake-audio-device flags (clock keeps running).

## Architecture — 3 layers, 2 threads

1. **UI** — Svelte chrome ([src/ui/](app/src/ui/), [App.svelte](app/src/App.svelte))
   + PixiJS/WebGL canvas ([src/canvas/](app/src/canvas/)).
2. **Engine controller** (main thread) — [engine/engine.ts](app/src/engine/engine.ts):
   owns AudioContext, mirrors audio graph into worklet, routes UI note events.
3. **AudioWorklet DSP** — [public/engine-worklet.js](app/public/engine-worklet.js)
   (~136K, hand-written, no build step): sample-accurate clock + all DSP.
   [messages.ts](app/src/engine/messages.ts) protocol = seam for a future C++/WASM core.

**Hub + data model:**
- [state.ts](app/src/state.ts) `AppState` (~2200 lines) — central event-emitter;
  holds graph, engine, transport, selection, per-frame live meter data. All
  mutation goes through it.
- [core/graph.ts](app/src/core/graph.ts) `Graph` — pure data (modules+wires+groups).
- [core/registry.ts](app/src/core/registry.ts) `MODULE_DEFS` — module-type catalog,
  intended single source of truth. **Trap:** a type is partially duplicated across
  `registry.ts`, `engine.ts`, `messages.ts`, `engine-worklet.js` — edit in lockstep.

**Canvas/faces:**
- [PatchCanvas.ts](app/src/canvas/PatchCanvas.ts) — pan/zoom/wiring/hit-test.
- [ModuleView.ts](app/src/canvas/ModuleView.ts) + [canvas/faces/](app/src/canvas/faces/):
  one **FaceRenderer** per module type (`build`/`refresh`), `FACE_RENDERERS` map;
  `ctrlGridFace` = default for pure-param modules.
- [GroupView.ts](app/src/canvas/GroupView.ts) — groups; engine never sees groups,
  so grouping never interrupts sound.
- **"face" is overloaded:** module-tile face (faces/) vs group face
  ([core/face.ts](app/src/core/face.ts)). Disambiguate every time.

**Visual engine** — separate node graph ([src/visual/](app/src/visual/): own
registry, passes, raymarch/raster, WebGL). Reads worklet audio features via a
SharedArrayBuffer ring ([visual/ring.ts](app/src/visual/ring.ts)) → needs
`crossOriginIsolated` → COOP/COEP headers in `vite.config.ts` + prod host.

**AI building** — `src/core/ai*.ts` atop same Graph + registry.

## Conventions

Persistence `.kkproj` (samples embedded), module export `.kkmod`. Plans tracked as
root `*_PLAN.md` (status inside). License proprietary/`UNLICENSED`, repo private.
