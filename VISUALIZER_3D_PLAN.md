# Visualizer 3D Plan

> **STATUS: SHIPPED — merged to main (commit 9ddbd24).** Both PRs: raymarch
> tunnel/fractal/terrain + raster bars3d/particles3d.

3D support for the visual engine. Two render paths land as additive `source`
nodes that output the same `rgba8unorm` premultiplied texture every existing
node produces — so blur / bloom / feedback / kaleido / blend / scenes all
compose 3D layers for free, and nothing downstream changes.

Hard rules carried from `VISUALIZER_ENGINE_PLAN.md`: **WGSL only, no three.js**
(the Phase-3 C++ core runs the same shaders through Dawn). CPU-side math stays
dependency-free and unit-testable (no GPU/DOM in `types`/`graphops`/`camera3d`/
`mat4`).

## Decisions (locked)

- **Both render paths.** Raymarched SDF backbone + a real raster path with a
  depth buffer. Each 3D node is a flattened layer (an `rgba8` texture); we do
  **not** depth-composite across nodes — only within a node.
- **Per-node camera.** Each 3D node owns `dist / yaw / pitch / fov / spin`
  params. Continuous params auto-get control in-ports (existing registry
  convention), so audio can push the camera (`bass → dist`, `onset → spin`…).
  No new wire type, no shared Camera node.
- **Mesh look:** Lambert diffuse + emissive fresnel rim. Reads solid, glows on
  the edges, pairs with the existing `bloom` node.
- **Starters:** add 3D scenes alongside the current 2D ones (nothing removed).
- **Phased:** PR1 = raymarch (no new GPU plumbing). PR2 = depth + raster.

## Shared camera model — `src/visual/camera3d.ts` (PR1)

One CPU camera definition feeds both paths so a raymarch layer and a raster
layer with the same params line up.

```ts
export interface Cam { dist: number; yaw: number; pitch: number; fov: number; spin: number; }
export const CAMERA_PARAMS: VisParamSpec[]   // dist, yaw, pitch, fov, spin — spread into 3D defs
export function cameraEye(p: Cam, time: number): { eye: [x,y,z]; target: [x,y,z] }  // orbit origin; yaw += time*spin
```

- Raymarch nodes pass `eye`, `target`, `fov`, `aspect`, `time` as uniforms and
  build the per-pixel ray in WGSL via a shared `CAMERA_WGSL` helper
  (`cameraRay(uv, aspect, eye, target, fov) -> Ray{ ro, rd }`), appended like
  `COMMON_WGSL`.
- Raster nodes (PR2) turn the same `eye/target/fov` into a `mat4` view-proj on
  the CPU (`src/visual/mat4.ts`) and pass it as a `mat4x4f` uniform.

`mat4.ts` (perspective / lookAt / multiply) is a ~40-line pure module added in
PR2 with a unit test; raymarch (PR1) needs no matrices.

Camera params get auto mod-ports like every continuous param. `dist`/`fov`/
`spin` are the musically useful ones (multiply mode: e.g. `bass → dist` zooms
in on the beat); `yaw`/`pitch` keep their ports too but default unwired.

---

## PR1 — Raymarch path (no new plumbing)

All three are fullscreen fragment passes through the existing
`fullscreenPipeline` + `runPass`. A fixed-iteration march loop; a `quality`
param sets the step budget so heavy tiles/thumbnails stay cheap (the existing
per-container `res` scale + `fps` cap in `display.ts` also apply).

### `raytunnel` — Tunnel Ride (source)
Endless tube SDF; camera flies forward along the path (own `speed`, not the
orbit camera), with `twist` and `radius`. Inner glow falls off with marched
distance → depth fog for free.
- Params: `speed` (bass-reactive default mod), `twist`, `radius`, `glow`,
  `hue` (add-wrap), `fov`, `roll`, `quality`.
- Audio: `speed`←bass, `radius` pulse←level, `hue`←centroid (wired in the
  starter; all optional).

### `sdffractal` — Fractal Dive (source)
Mandelbox distance estimator (cheaper + cleaner than mandelbulb), orbit camera.
- Params: `CAMERA_PARAMS` + `scale`, `iters`, `glow`, `hue` (add-wrap),
  `quality`.
- Audio: `bass → scale` (fractal breathes), `onset → spin` (camera kick),
  `centroid → hue`.

### `terrain` — Audio Terrain (source)
Raymarched scrolling heightfield. A node-state storage buffer holds a ring of
recent spectra (`HISTORY` rows × `SPECTRUM_BINS`); each frame pushes the live
spectrum, the shader marches the heightfield sampling that buffer → a landscape
of past sound receding to the horizon (waterfall terrain). Orbit-ish flyover
camera.
- Params: `speed`, `height`, `glow`, `hue` (add-wrap), `fov`, `pitch`,
  `quality`.
- Reuses `env.features.spectrum`; buffer ring lives in `NodeState.storage`
  (same pattern as `scope`).

### PR1 files
- `src/visual/camera3d.ts` (new) + `camera3d.test.ts`.
- `src/visual/nodes.ts`: `raytunnel`, `sdffractal`, `terrain` impls + register.
- `src/visual/registry.ts`: three `VisNodeDef`s (category `source`).
- `src/visual/passes.ts`: export `CAMERA_WGSL`; no structural change.
- `src/ui/starters.ts`: `addTunnelRide`, `addFractalDive` + `STARTERS` entries.
- `app/e2e/visualizer.spec.ts`: a 3D graph builds, frames advance,
  `visGpuErrors()===0`.
- AI spec: catalog auto-includes the new defs; add ONE 3D annotated example to
  `VIS_EXAMPLES` in `aivisual.ts`.

No migration, no `display.ts`/`runtime.ts` change.

---

## PR2 — Raster path (depth + geometry)

### Plumbing
- **Depth pool:** `TexturePool.acquireDepth(w,h)` → pooled `depth24plus`
  render-attachment textures, returned on `endFrame()` like color targets.
- **Raster pipeline:** built via the existing `customPipeline` cache, with a
  `depthStencil` state + vertex/instance buffer layouts.
- **Cube geometry:** one device-cached vertex+index buffer (position + normal),
  built once (small `unitCube()` helper). Instanced.
- **mat4 uniform:** `mat4.ts` view-proj from `camera3d`.
- Both nodes render into a pooled color target (+ depth for the mesh) and
  return it — identical contract to every other node.

### `bars3d` — 3D Spectrum City (source, raster, depth)
Instanced cubes, one per spectrum bin (or an `N×N` grid), height = bin
magnitude, hue from bin index/height. Lambert + fresnel-rim shading (chosen
look); chain `bloom` for neon edges. Orbit camera; depth buffer gives true
self-occlusion as the camera circles.
- Params: `CAMERA_PARAMS` + `count`, `spacing`, `heightScale`, `hue`
  (add-wrap), `glow`.
- Audio: heights are live spectrum; `bass → dist`, `onset → spin`.

### `particles3d` — Particle Galaxy (source, raster, **no depth**)
Extends the existing CPU particle sim to 3D (`x,y,z`, perspective-projected in
the vertex shader via the view-proj uniform), **additive** blend so no depth
sort/buffer is needed. Notes/onsets spawn bursts in a 3D volume; camera orbits.
- Params: `CAMERA_PARAMS` + `rate`, `size`, `spread`, `hue` (add-wrap).
- Reuses `NodeState.particles` + the instanced-billboard pipeline pattern from
  `particles`, adding z + projection.

### PR2 files
- `src/visual/mat4.ts` (new) + `mat4.test.ts`.
- `src/visual/passes.ts`: `acquireDepth`, cube geometry cache, depth in
  `TexturePool.destroy`.
- `src/visual/nodes.ts`: `bars3d`, `particles3d` impls + register.
- `src/visual/registry.ts`: two `VisNodeDef`s.
- `src/ui/starters.ts`: `addSpectrumCity`, `addParticleGalaxy` + entries.
- `app/e2e/visualizer.spec.ts`: raster 3D graph renders, `visGpuErrors()===0`.
- AI spec: one raster 3D example.

---

## Starters (added alongside, both PRs)

Each builds a `visualizer` module and sets `data.graph` to a hand-authored
`VisGraphData` (showcasing the node + a feedback/bloom finish + Features mod
wires), mirroring `initVisGraph`'s structure.

| Starter            | PR  | Headline                                                        |
|--------------------|-----|-----------------------------------------------------------------|
| Tunnel Ride        | 1   | `raytunnel` → feedback → bloom; bass drives speed               |
| Fractal Dive       | 1   | `sdffractal` → bloom; bass→scale, onset→spin, centroid→hue      |
| 3D Spectrum City   | 2   | `bars3d` → bloom; orbiting neon bar city                        |
| Particle Galaxy    | 2   | `particles3d` → feedback → bloom; note bursts in 3D             |

## Risks / notes
- **Perf:** raymarch fractal/terrain are the heavy ones. `quality` step-budget
  param + existing `res`/`fps` caps are the levers; default `quality` tuned for
  60 fps at `res 1` on a mid GPU, lower on thumbnails.
- **C++ port surface:** raster path adds depth + vertex buffers to port to
  Dawn later — accepted (the "both paths" decision). WGSL shaders stay portable.
- **No new wire type / no model change:** 3D is pure additive nodes; serialize,
  AI import, tint sampling, sub-canvas editor all work unchanged.
