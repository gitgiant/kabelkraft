/**
 * Visual node implementations — WGSL passes per node type (Phase 2 catalog).
 * Each impl renders into pooled textures via the shared fullscreen-pass
 * helpers in passes.ts; the evaluator in runtime.ts walks the graph and
 * resolves param modulation before calling render().
 *
 * Conventions: intermediate textures are rgba8unorm, premultiplied alpha.
 * Sources ignore `inputs`; effects receive one texture per visual in-port
 * (null = unwired → transparent black).
 */

import { camFromParams, cameraEye } from './camera3d';
import { binFrac, SPECTRUM_BINS } from './features';
import { viewProj } from './mat4';
import {
  blackTexture,
  createPersistentTexture,
  customPipeline,
  fullscreenPipeline,
  runPass,
  sharedSampler,
  unitCube,
  CAMERA_WGSL,
  COMMON_WGSL,
  DEPTH_FORMAT,
  RT_FORMAT,
  type Particle,
  type RenderEnv,
} from './passes';
import { VIS_WINDOW, type VisNodeInstance } from './types';

export interface NodeImpl {
  render(
    env: RenderEnv,
    node: VisNodeInstance,
    inputs: (GPUTexture | null)[],
    params: Record<string, number>,
  ): GPUTexture | null;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function texOr(env: RenderEnv, t: GPUTexture | null): GPUTextureView {
  return (t ?? blackTexture(env.device)).createView();
}

/** Write a Float32Array into a node's cached uniform buffer and return it. */
function uni(env: RenderEnv, nodeId: string, data: Float32Array): GPUBindingResource {
  const buf = env.states.get(env.ns + nodeId).uniform(env.device, data.byteLength);
  env.device.queue.writeBuffer(buf, 0, data);
  return { buffer: buf };
}

// -- spectrum ---------------------------------------------------------------

const SPECTRUM_FS = /* wgsl */ `
struct Uni { params: vec4f, bins: array<vec4f, ${SPECTRUM_BINS / 4}> };
@group(0) @binding(0) var<uniform> u: Uni;

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let n = u.params.x;
  let xb = in.uv.x * n;
  let b = u32(clamp(floor(xb), 0, n - 1));
  let frac = u.bins[b / 4u][b % 4u];
  let gap = fract(xb);
  if (gap < 0.08 || gap > 0.92 || frac <= 0.01) { return vec4f(0); }
  let y = 1 - in.uv.y;
  if (y > frac * 0.96) { return vec4f(0); }
  let col = mix(vec3f(0.85, 0.55, 0.06), vec3f(0.98, 0.92, 0.45), frac);
  return vec4f(col, 1);
}
`;

const spectrum: NodeImpl = {
  render(env, node, _inputs, params) {
    const data = new Float32Array(4 + SPECTRUM_BINS);
    data[0] = SPECTRUM_BINS;
    const f = env.features;
    if (f) {
      const eff = Math.min(1, params.gain * (f.ctrl >= 0 ? 0.3 + 0.7 * f.ctrl : 1));
      for (let b = 0; b < SPECTRUM_BINS; b++) data[4 + b] = binFrac(f.spectrum[b]) * eff;
    }
    const pipeline = fullscreenPipeline(env.device, 'spectrum', SPECTRUM_FS);
    return runPass(env, pipeline, [uni(env, node.id, data)]);
  },
};

// -- scope -------------------------------------------------------------------

const SCOPE_FS = /* wgsl */ `
@group(0) @binding(0) var<uniform> u: vec4f; // gain, glow, n, unused
@group(0) @binding(1) var<storage, read> wave: array<f32>;

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let n = u.z;
  let xi = in.uv.x * (n - 1);
  let i = u32(floor(xi));
  let v = mix(wave[i], wave[min(i + 1u, u32(n) - 1u)], fract(xi));
  let y = 0.5 - clamp(v * u.x, -1, 1) * 0.45;
  let d = abs(in.uv.y - y);
  let core = smoothstep(0.008, 0.0, d);
  let glow = u.y * smoothstep(0.08, 0.0, d) * 0.6;
  let a = clamp(core + glow, 0, 1);
  return vec4f(vec3f(0.24, 0.85, 1.0) * a, a);
}
`;

const scope: NodeImpl = {
  render(env, node, _inputs, params) {
    const state = env.states.get(env.ns + node.id);
    if (!state.storage) {
      state.storage = env.device.createBuffer({
        size: VIS_WINDOW * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    const f = env.features;
    if (f) env.device.queue.writeBuffer(state.storage, 0, f.wave as Float32Array<ArrayBuffer>);
    const ctrl = f && f.ctrl >= 0 ? 0.3 + 0.7 * f.ctrl : 1;
    const data = new Float32Array([params.gain * ctrl, params.glow, VIS_WINDOW, 0]);
    const pipeline = fullscreenPipeline(env.device, 'scope', SCOPE_FS);
    return runPass(env, pipeline, [uni(env, node.id, data), { buffer: state.storage }]);
  },
};

// -- particles ----------------------------------------------------------------

const MAX_PARTICLES = 600;
const PARTICLE_STRIDE = 8; // x, y, size, hue, alpha, pad×3

const PARTICLES_WGSL = COMMON_WGSL + /* wgsl */ `
struct Inst { posSize: vec4f, misc: vec4f }; // pos.xy, sizePx, hue | alpha
@group(0) @binding(0) var<uniform> screen: vec4f; // w, h
@group(0) @binding(1) var<storage, read> inst: array<Inst>;

struct PVsOut {
  @builtin(position) pos: vec4f,
  @location(0) corner: vec2f,
  @location(1) @interpolate(flat) idx: u32,
};

@vertex
fn pvs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> PVsOut {
  var corners = array<vec2f, 6>(
    vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1),
    vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1));
  let c = corners[v];
  let p = inst[i];
  let px = p.posSize.xy + c * p.posSize.z;
  var out: PVsOut;
  out.pos = vec4f(px.x / screen.x * 2 - 1, 1 - px.y / screen.y * 2, 0, 1);
  out.corner = c;
  out.idx = i;
  return out;
}

@fragment
fn pfs(in: PVsOut) -> @location(0) vec4f {
  let p = inst[in.idx];
  let d = length(in.corner);
  let a = smoothstep(1.0, 0.55, d) * p.misc.x;
  return vec4f(hsl2rgb(p.posSize.w, 0.8, 0.6) * a, a);
}
`;

const particles: NodeImpl = {
  render(env, node, _inputs, params) {
    const state = env.states.get(env.ns + node.id);
    const f = env.features;
    const W = env.width;
    const H = env.height;

    // CPU sim, ported from the legacy scene: notes spawn bursts, onset adds
    // extra, audio energy drives drift speed.
    if (f) {
      for (const pitch of f.notes) {
        for (let i = 0; i < 12; i++) {
          state.particles.push({
            x: W * ((pitch % 36) / 36),
            y: H * 0.7,
            vx: (Math.random() - 0.5) * 6,
            vy: -2 - Math.random() * 5,
            life: 1,
            hue: ((pitch % 12) / 12),
            z: 0,
            vz: 0,
          });
        }
      }
      const burst = Math.round(f.onset * params.rate * 24);
      for (let i = 0; i < burst; i++) {
        state.particles.push({
          x: W * Math.random(),
          y: H * (0.55 + Math.random() * 0.3),
          vx: (Math.random() - 0.5) * 8,
          vy: -3 - Math.random() * 6,
          life: 1,
          hue: f.centroid,
          z: 0,
          vz: 0,
        });
      }
    }
    if (state.particles.length > MAX_PARTICLES) {
      state.particles.splice(0, state.particles.length - MAX_PARTICLES);
    }
    let energy = 0;
    if (f) for (const db of f.spectrum) energy = Math.max(energy, binFrac(db));
    const ctrl = f && f.ctrl >= 0 ? 0.3 + 0.7 * f.ctrl : 1;
    const speed = (0.5 + energy * 2 * params.gain * ctrl) * env.dt * 60;
    const live: Particle[] = [];
    for (const p of state.particles) {
      p.x += p.vx * speed;
      p.y += p.vy * speed;
      p.vy += 0.06 * env.dt * 60;
      p.life -= 0.012 * env.dt * 60;
      if (p.life > 0 && p.x >= 0 && p.x <= W && p.y <= H) live.push(p);
    }
    state.particles = live;

    if (!state.instanceData) state.instanceData = new Float32Array(MAX_PARTICLES * PARTICLE_STRIDE);
    const inst = state.instanceData;
    const scale = Math.min(W, H) / 280; // legacy sizes were tuned on a 280px tile
    for (let i = 0; i < live.length; i++) {
      const p = live[i];
      const o = i * PARTICLE_STRIDE;
      inst[o] = p.x;
      inst[o + 1] = p.y;
      inst[o + 2] = (2 + p.life * 5) * scale * params.size;
      inst[o + 3] = p.hue;
      inst[o + 4] = p.life;
    }
    if (!state.storage) {
      state.storage = env.device.createBuffer({
        size: inst.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    env.device.queue.writeBuffer(state.storage, 0, inst);

    const pipeline = customPipeline(env.device, 'particles', () => {
      const module = env.device.createShaderModule({ code: PARTICLES_WGSL });
      return env.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'pvs' },
        fragment: {
          module,
          entryPoint: 'pfs',
          targets: [
            {
              format: RT_FORMAT,
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-list' },
      });
    });

    const out = env.pool.acquire(W, H);
    const screenU = env.states.get(env.ns + node.id).uniform(env.device, 16);
    env.device.queue.writeBuffer(screenU, 0, new Float32Array([W, H, 0, 0]));
    const pass = env.encoder.beginRenderPass({
      colorAttachments: [
        { view: out.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      env.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: screenU } },
          { binding: 1, resource: { buffer: state.storage } },
        ],
      }),
    );
    if (live.length > 0) pass.draw(6, live.length);
    pass.end();
    return out;
  },
};

// -- shapes --------------------------------------------------------------------

const SHAPES_FS = /* wgsl */ `
@group(0) @binding(0) var<uniform> u: array<vec4f, 2>;
// u[0] = shape, count, size, angle ; u[1] = hue, aspect, 0, 0

fn sdf(p: vec2f, shape: f32, r: f32) -> f32 {
  if (shape < 0.5) { return length(p) - r; }                      // circle
  if (shape < 1.5) { return abs(length(p) - r * 0.8) - r * 0.18; } // ring
  if (shape < 2.5) {                                              // square
    let d = abs(p) - vec2f(r * 0.8);
    return length(max(d, vec2f(0))) + min(max(d.x, d.y), 0);
  }
  var q = abs(p);                                                 // hex
  return max(q.x * 0.866 + q.y * 0.5, q.y) - r * 0.85;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let count = u[0].y;
  let ang = u[0].w;
  var uv = (in.uv - 0.5) * vec2f(u[1].y, 1.0) * count;
  let cell = fract(uv) - 0.5;
  let rot = mat2x2f(cos(ang), -sin(ang), sin(ang), cos(ang));
  let d = sdf(rot * cell, u[0].x, u[0].z * 0.5);
  let a = smoothstep(0.015, -0.015, d);
  let col = hsl2rgb(u[1].x + (floor(uv.x) + floor(uv.y)) * 0.03, 0.75, 0.55);
  return vec4f(col * a, a);
}
`;

const shapes: NodeImpl = {
  render(env, node, _inputs, params) {
    const f = env.features;
    const level = f ? f.level * 2.2 : 0;
    const size = params.size * (1 + params.pulse * Math.min(1.5, level));
    const data = new Float32Array([
      params.shape,
      Math.round(params.count),
      size,
      env.time * params.spin * 2,
      params.hue,
      env.width / env.height,
      0,
      0,
    ]);
    const pipeline = fullscreenPipeline(env.device, 'shapes', SHAPES_FS);
    return runPass(env, pipeline, [uni(env, node.id, data)]);
  },
};

// -- gradient -------------------------------------------------------------------

const GRADIENT_FS = /* wgsl */ `
@group(0) @binding(0) var<uniform> u: array<vec4f, 2>;
// u[0] = mode, hue, hue2, sat ; u[1] = lum, drift-phase, 0, 0

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let mode = u[0].x;
  var t = 0.0;
  if (mode > 0.5 && mode < 1.5) { t = in.uv.y; }
  else if (mode < 2.5 && mode >= 1.5) { t = in.uv.x; }
  else if (mode >= 2.5) { t = clamp(length(in.uv - 0.5) * 1.6, 0, 1); }
  let h = mix(u[0].y, u[0].z, t) + u[1].y;
  return vec4f(hsl2rgb(h, u[0].w, u[1].x), 1);
}
`;

const gradient: NodeImpl = {
  render(env, node, _inputs, params) {
    const data = new Float32Array([
      params.mode,
      params.hue,
      params.hue2,
      params.sat,
      params.lum,
      env.time * params.drift * 0.05,
      0,
      0,
    ]);
    const pipeline = fullscreenPipeline(env.device, 'gradient', GRADIENT_FS);
    return runPass(env, pipeline, [uni(env, node.id, data)]);
  },
};

// -- media (image / video / webcam) ----------------------------------------------

const MEDIA_FS = /* wgsl */ `
@group(0) @binding(0) var<uniform> u: vec4f; // scaleX, scaleY, mirror, 0
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  var uv = (in.uv - 0.5) * u.xy + 0.5;
  if (u.z > 0.5) { uv.x = 1 - uv.x; }
  // Sample unconditionally (textureSample needs uniform control flow), then
  // mask the letterbox region to transparent.
  let inside = uv.x >= 0 && uv.x <= 1 && uv.y >= 0 && uv.y <= 1;
  let c = textureSample(tex, samp, clamp(uv, vec2f(0), vec2f(1)));
  return select(vec4f(0), c, inside);
}
`;

/** cover/contain/stretch → uv scale factors. */
function fitScale(
  fit: number,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): [number, number] {
  if (fit >= 1.5) return [1, 1]; // stretch
  const srcA = srcW / srcH;
  const dstA = dstW / dstH;
  const wide = srcA > dstA;
  if (fit < 0.5) {
    // cover — crop the long axis (uv scale < 1 samples a centered subregion)
    return wide ? [dstA / srcA, 1] : [1, srcA / dstA];
  }
  // contain — letterbox (uv scale > 1 maps outside the image → transparent)
  return wide ? [1, srcA / dstA] : [dstA / srcA, 1];
}

function drawMedia(
  env: RenderEnv,
  node: VisNodeInstance,
  tex: GPUTexture,
  srcW: number,
  srcH: number,
  fit: number,
  mirror: number,
): GPUTexture {
  const [sx, sy] = fitScale(fit, srcW, srcH, env.width, env.height);
  const data = new Float32Array([sx, sy, mirror, 0]);
  const pipeline = fullscreenPipeline(env.device, 'media', MEDIA_FS);
  return runPass(env, pipeline, [uni(env, node.id, data), sharedSampler(env.device), tex.createView()]);
}

/** (Re)upload the current video frame into the node's persistent texture. */
function uploadVideoFrame(env: RenderEnv, nodeId: string, video: HTMLVideoElement): GPUTexture | null {
  if (video.readyState < 2 || video.videoWidth === 0) return null;
  const state = env.states.get(env.ns + nodeId);
  if (!state.texture || state.texW !== video.videoWidth || state.texH !== video.videoHeight) {
    state.texture?.destroy();
    state.texture = createPersistentTexture(env.device, video.videoWidth, video.videoHeight);
    state.texW = video.videoWidth;
    state.texH = video.videoHeight;
  }
  env.device.queue.copyExternalImageToTexture(
    { source: video },
    { texture: state.texture, premultipliedAlpha: true },
    { width: video.videoWidth, height: video.videoHeight },
  );
  return state.texture;
}

const image: NodeImpl = {
  render(env, node, _inputs, params) {
    const state = env.states.get(env.ns + node.id);
    const src = (node.data?.src as string) ?? null;
    if (src !== state.srcKey && !state.loading) {
      state.srcKey = src;
      state.texture?.destroy();
      state.texture = null;
      if (src) {
        state.loading = true;
        void (async () => {
          try {
            const blob = await (await fetch(src)).blob();
            const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' });
            // Node may have been re-pointed while decoding.
            if (state.srcKey !== src) return;
            state.texture = createPersistentTexture(env.device, bmp.width, bmp.height);
            state.texW = bmp.width;
            state.texH = bmp.height;
            env.device.queue.copyExternalImageToTexture(
              { source: bmp },
              { texture: state.texture, premultipliedAlpha: true },
              { width: bmp.width, height: bmp.height },
            );
          } finally {
            state.loading = false;
          }
        })();
      }
    }
    if (!state.texture) return null;
    return drawMedia(env, node, state.texture, state.texW, state.texH, params.fit, 0);
  },
};

const video: NodeImpl = {
  render(env, node, _inputs, params) {
    const state = env.states.get(env.ns + node.id);
    const src = (node.data?.src as string) ?? null;
    if (src !== state.srcKey) {
      state.srcKey = src;
      state.video?.pause();
      state.video = null;
      if (src) {
        const el = document.createElement('video');
        el.src = src;
        el.loop = true;
        el.muted = true;
        el.playsInline = true;
        void el.play().catch(() => {});
        state.video = el;
      }
    }
    if (!state.video) return null;
    const tex = uploadVideoFrame(env, node.id, state.video);
    if (!tex) return null;
    return drawMedia(env, node, tex, state.texW, state.texH, params.fit, 0);
  },
};

const webcam: NodeImpl = {
  render(env, node, _inputs, params) {
    const state = env.states.get(env.ns + node.id);
    if (!state.video && !state.loading) {
      state.loading = true;
      void navigator.mediaDevices
        .getUserMedia({ video: true })
        .then((stream) => {
          const el = document.createElement('video');
          el.srcObject = stream;
          el.muted = true;
          el.playsInline = true;
          void el.play().catch(() => {});
          state.stream = stream;
          state.video = el;
        })
        .catch(() => {
          /* permission denied → stays black */
        })
        .finally(() => {
          state.loading = false;
        });
    }
    if (!state.video) return null;
    const tex = uploadVideoFrame(env, node.id, state.video);
    if (!tex) return null;
    return drawMedia(env, node, tex, state.texW, state.texH, params.fit, params.mirror);
  },
};

// -- visual in (container pole) -------------------------------------------------

const visualin: NodeImpl = {
  render(env, node, _inputs, params) {
    if (!env.upstream) return null;
    // Upstream frames may be a different resolution — fit like media sources.
    return drawMedia(env, node, env.upstream, env.upstream.width, env.upstream.height, params.fit, 0);
  },
};

// -- text layer ----------------------------------------------------------------
// Glyphs rasterize on an OffscreenCanvas (no WGSL font madness) and upload as
// a texture each frame — text is one layer among many, so it blends like any
// other visual source. Transparent background, premultiplied.

function hslCss(h: number, s: number, l: number, a = 1): string {
  return `hsl(${h * 360} ${s * 100}% ${l * 100}% / ${a})`;
}

const textlayer: NodeImpl = {
  render(env, node, _inputs, params) {
    const state = env.states.get(env.ns + node.id);
    const f = env.features;
    const live = f?.text ?? '';
    const stack = f?.textStack ?? [];
    const fallback = (node.data?.text as string) ?? '';
    const line = live || fallback;
    if (!line && stack.length === 0) return null;

    if (!state.canvas2d || state.texW !== env.width || state.texH !== env.height) {
      state.canvas2d = new OffscreenCanvas(env.width, env.height);
      state.texture?.destroy();
      state.texture = createPersistentTexture(env.device, env.width, env.height);
      state.texW = env.width;
      state.texH = env.height;
    }
    // Typewriter restarts when the content changes.
    const contentKey = `${line}|${stack.length}`;
    if (state.srcKey !== contentKey) {
      state.srcKey = contentKey;
      state.mark = env.time;
    }

    const ctx = state.canvas2d.getContext('2d')!;
    const W = env.width;
    const H = env.height;
    ctx.clearRect(0, 0, W, H);
    const px = Math.max(10, params.size * H);
    ctx.font = `700 ${px}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const lum = 0.75;
    const mode = Math.round(params.mode);
    const yMid = params.y * H;

    if (mode === 1) {
      // scroll — marquee right→left, wraps.
      ctx.fillStyle = hslCss(params.hue, params.sat, lum);
      const tw = ctx.measureText(line).width;
      const span = W + tw;
      const xOff = span - ((env.time * params.speed * 0.12 * span) % span);
      ctx.fillText(line, xOff - tw, yMid);
    } else if (mode === 2) {
      // typewriter — reveal by characters since last change.
      const chars = Math.floor((env.time - state.mark) * params.speed * 18);
      const shown = line.slice(0, Math.max(0, chars));
      ctx.fillStyle = hslCss(params.hue, params.sat, lum);
      ctx.textAlign = 'left';
      const tw = ctx.measureText(line).width;
      ctx.fillText(shown, Math.max(8, (W - tw) / 2), yMid);
      ctx.textAlign = 'start';
    } else if (mode === 3) {
      // stack — karaoke history rising above the live line.
      ctx.textAlign = 'center';
      const lineH = px * 1.25;
      const isInterim = live !== '' && live !== stack[stack.length - 1];
      for (let i = 0; i < stack.length; i++) {
        const age = stack.length - 1 - i; // 0 = newest
        const y = yMid - (age + (isInterim ? 1 : 0)) * lineH;
        if (y < -lineH) continue;
        const fade = Math.max(0.12, 1 - age * 0.22);
        ctx.fillStyle = hslCss(params.hue, params.sat, lum, fade);
        ctx.fillText(stack[i], W / 2, y);
      }
      if (isInterim) {
        ctx.fillStyle = hslCss(params.hue, Math.min(1, params.sat + 0.2), 0.85);
        ctx.fillText(live, W / 2, yMid);
      }
      ctx.textAlign = 'start';
    } else {
      // line — current text centered.
      ctx.textAlign = 'center';
      ctx.fillStyle = hslCss(params.hue, params.sat, lum);
      ctx.fillText(line, W / 2, yMid);
      ctx.textAlign = 'start';
    }

    env.device.queue.copyExternalImageToTexture(
      { source: state.canvas2d },
      { texture: state.texture!, premultipliedAlpha: true },
      { width: W, height: H },
    );
    return state.texture;
  },
};

// -- one-input effects -------------------------------------------------------

/** Builds a single-texture-in effect impl from a fragment shader. */
function simpleEffect(
  key: string,
  fs: string,
  packParams: (env: RenderEnv, params: Record<string, number>) => Float32Array,
): NodeImpl {
  return {
    render(env, node, inputs, params) {
      const pipeline = fullscreenPipeline(env.device, key, fs);
      return runPass(env, pipeline, [
        uni(env, node.id, packParams(env, params)),
        sharedSampler(env.device),
        texOr(env, inputs[0]),
      ]);
    },
  };
}

const EFFECT_HEADER = /* wgsl */ `
@group(0) @binding(0) var<uniform> u: vec4f;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;
`;

const pixelate = simpleEffect(
  'pixelate',
  EFFECT_HEADER + /* wgsl */ `
@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let cells = mix(220.0, 9.0, clamp(u.x, 0, 1));
  let uv = (floor(in.uv * vec2f(cells * u.y, cells)) + 0.5) / vec2f(cells * u.y, cells);
  return textureSample(tex, samp, uv);
}
`,
  (env, p) => new Float32Array([p.amount, env.width / env.height, 0, 0]),
);

const mirror = simpleEffect(
  'mirror',
  EFFECT_HEADER + /* wgsl */ `
@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  var uv = in.uv;
  // mode 0 = x, 1 = y, 2 = quad (both): reflect the right/bottom half.
  if (u.x < 0.5 || u.x >= 1.5) { uv.x = select(uv.x, 1 - uv.x, uv.x > 0.5); }
  if (u.x >= 0.5) { uv.y = select(uv.y, 1 - uv.y, uv.y > 0.5); }
  return textureSample(tex, samp, uv);
}
`,
  (_env, p) => new Float32Array([p.mode, 0, 0, 0]),
);

const chromashift = simpleEffect(
  'chromashift',
  EFFECT_HEADER + /* wgsl */ `
@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let ang = u.y * 6.2832;
  let o = vec2f(cos(ang), sin(ang)) * u.x * 0.02;
  let r = textureSample(tex, samp, in.uv + o);
  let g = textureSample(tex, samp, in.uv);
  let b = textureSample(tex, samp, in.uv - o);
  return vec4f(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
}
`,
  (_env, p) => new Float32Array([p.amount, p.angle, 0, 0]),
);

const warp = simpleEffect(
  'warp',
  EFFECT_HEADER + /* wgsl */ `
@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let t = u.w;
  let uv = in.uv + u.x * 0.05 * vec2f(
    sin(in.uv.y * u.y + t), cos(in.uv.x * u.y + t * 1.3));
  return textureSample(tex, samp, clamp(uv, vec2f(0), vec2f(1)));
}
`,
  (env, p) => new Float32Array([p.amount, p.freq, 0, env.time * p.speed * 2]),
);

const kaleido = simpleEffect(
  'kaleido',
  EFFECT_HEADER + /* wgsl */ `
@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let c = in.uv - 0.5;
  let seg = 6.2832 / max(u.x, 2.0);
  var a = atan2(c.y, c.x) + u.y;
  a = abs(fract(a / seg) - 0.5) * seg;
  let r = length(c);
  let uv = clamp(vec2f(cos(a), sin(a)) * r + 0.5, vec2f(0), vec2f(1));
  return textureSample(tex, samp, uv);
}
`,
  (env, p) => new Float32Array([Math.round(p.segments), env.time * p.spin * 2, 0, 0]),
);

const colorgrade = simpleEffect(
  'colorgrade',
  EFFECT_HEADER + /* wgsl */ `
@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  var c = textureSample(tex, samp, in.uv);
  // Hue rotation in YIQ space.
  let y = dot(c.rgb, vec3f(0.299, 0.587, 0.114));
  let i = dot(c.rgb, vec3f(0.596, -0.274, -0.322));
  let q = dot(c.rgb, vec3f(0.211, -0.523, 0.312));
  let h = u.x * 6.2832;
  let i2 = i * cos(h) - q * sin(h);
  let q2 = i * sin(h) + q * cos(h);
  var rgb = vec3f(
    y + 0.956 * i2 + 0.621 * q2,
    y - 0.272 * i2 - 0.647 * q2,
    y - 1.106 * i2 + 1.703 * q2);
  rgb = mix(vec3f(y), rgb, u.y);            // saturation
  rgb = (rgb - 0.5) * u.z + 0.5;            // contrast
  rgb = rgb * u.w;                          // brightness
  return vec4f(clamp(rgb, vec3f(0), vec3f(1)), c.a);
}
`,
  (_env, p) => new Float32Array([p.hueShift, p.sat, p.contrast, p.bright]),
);

// invert needs a 2nd uniform slot — wrap colorgrade with a tiny second pass
const INVERT_FS = EFFECT_HEADER + /* wgsl */ `
@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, in.uv);
  return vec4f((1 - c.rgb) * c.a, c.a);
}
`;

const colorgradeImpl: NodeImpl = {
  render(env, node, inputs, params) {
    let out = colorgrade.render(env, node, inputs, params);
    if (params.invert >= 0.5 && out) {
      const pipeline = fullscreenPipeline(env.device, 'invert', INVERT_FS);
      out = runPass(env, pipeline, [
        uni(env, node.id, new Float32Array(4)),
        sharedSampler(env.device),
        out.createView(),
      ]);
    }
    return out;
  },
};

// -- blur (separable two-pass; also bloom's building block) --------------------

const BLUR_FS = EFFECT_HEADER + /* wgsl */ `
@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  // 13-tap gaussian along u.xy (texel-scaled direction).
  var weights = array<f32, 7>(0.1964, 0.1747, 0.1216, 0.0662, 0.0281, 0.0093, 0.0024);
  var c = textureSample(tex, samp, in.uv) * weights[0];
  for (var k = 1; k < 7; k++) {
    let o = u.xy * f32(k);
    c += textureSample(tex, samp, in.uv + o) * weights[k];
    c += textureSample(tex, samp, in.uv - o) * weights[k];
  }
  return c;
}
`;

function blurPasses(
  env: RenderEnv,
  nodeId: string,
  input: GPUTexture,
  radiusPx: number,
): GPUTexture {
  const pipeline = fullscreenPipeline(env.device, 'blur', BLUR_FS);
  const step = radiusPx / 6;
  // H and V need separate uniform buffers in flight — keyed sub-states.
  const dataH = new Float32Array([step / env.width, 0, 0, 0]);
  const h = runPass(env, pipeline, [uni(env, nodeId + ':h', dataH), sharedSampler(env.device), input.createView()]);
  const dataV = new Float32Array([0, step / env.height, 0, 0]);
  return runPass(env, pipeline, [uni(env, nodeId + ':v', dataV), sharedSampler(env.device), h.createView()]);
}

const blur: NodeImpl = {
  render(env, node, inputs, params) {
    const input = inputs[0];
    if (!input) return null;
    if (params.amount <= 0.001) return input;
    return blurPasses(env, node.id, input, params.amount * 24);
  },
};

// -- bloom ----------------------------------------------------------------------

const THRESHOLD_FS = EFFECT_HEADER + /* wgsl */ `
@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, in.uv);
  let luma = dot(c.rgb, vec3f(0.299, 0.587, 0.114));
  let k = smoothstep(u.x, u.x + 0.2, luma);
  return vec4f(c.rgb * k, c.a * k);
}
`;

const ADD_FS = /* wgsl */ `
@group(0) @binding(0) var<uniform> u: vec4f;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var texA: texture_2d<f32>;
@group(0) @binding(3) var texB: texture_2d<f32>;

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let a = textureSample(texA, samp, in.uv);
  let b = textureSample(texB, samp, in.uv);
  return clamp(a + b * u.x, vec4f(0), vec4f(1));
}
`;

const bloom: NodeImpl = {
  render(env, node, inputs, params) {
    const input = inputs[0];
    if (!input) return null;
    const thr = fullscreenPipeline(env.device, 'threshold', THRESHOLD_FS);
    const bright = runPass(env, thr, [
      uni(env, node.id + ':t', new Float32Array([params.threshold, 0, 0, 0])),
      sharedSampler(env.device),
      input.createView(),
    ]);
    const blurred = blurPasses(env, node.id, bright, 18);
    const add = fullscreenPipeline(env.device, 'add', ADD_FS);
    return runPass(env, add, [
      uni(env, node.id + ':a', new Float32Array([params.amount, 0, 0, 0])),
      sharedSampler(env.device),
      input.createView(),
      blurred.createView(),
    ]);
  },
};

// -- feedback ----------------------------------------------------------------

const FEEDBACK_FS = /* wgsl */ `
@group(0) @binding(0) var<uniform> u: vec4f; // zoomScale, angle, fade, 0
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;
@group(0) @binding(3) var prev: texture_2d<f32>;

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let cur = textureSample(tex, samp, in.uv);
  let c = in.uv - 0.5;
  let rot = mat2x2f(cos(u.y), -sin(u.y), sin(u.y), cos(u.y));
  let uvP = rot * c * u.x + 0.5;
  // Sample unconditionally (uniform control flow), mask outside the frame.
  let inside = uvP.x >= 0 && uvP.x <= 1 && uvP.y >= 0 && uvP.y <= 1;
  let prevC = textureSample(prev, samp, clamp(uvP, vec2f(0), vec2f(1)));
  let fb = select(vec4f(0), prevC * u.z, inside);
  // screen-combine keeps trails luminous without blowing out
  return cur + fb * (1 - cur.a);
}
`;

const feedback: NodeImpl = {
  render(env, node, inputs, params) {
    const state = env.states.get(env.ns + node.id);
    if (!state.texture || state.texW !== env.width || state.texH !== env.height) {
      state.texture?.destroy();
      state.texture = createPersistentTexture(env.device, env.width, env.height);
      state.texW = env.width;
      state.texH = env.height;
    }
    // Frame-rate independent: zoom/spin per second, fade normalized to 60fps.
    const zoomScale = 1 - params.zoom * env.dt * 1.5;
    const angle = params.spin * env.dt * 2;
    const fade = Math.pow(params.fade, env.dt * 60);
    const pipeline = fullscreenPipeline(env.device, 'feedback', FEEDBACK_FS);
    const out = runPass(env, pipeline, [
      uni(env, node.id, new Float32Array([zoomScale, angle, fade, 0])),
      sharedSampler(env.device),
      texOr(env, inputs[0]),
      state.texture.createView(),
    ]);
    env.encoder.copyTextureToTexture(
      { texture: out },
      { texture: state.texture },
      { width: env.width, height: env.height },
    );
    return out;
  },
};

// -- blend ---------------------------------------------------------------------

const BLEND_FS = /* wgsl */ `
@group(0) @binding(0) var<uniform> u: vec4f; // mode, mix, 0, 0
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var texA: texture_2d<f32>;
@group(0) @binding(3) var texB: texture_2d<f32>;

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let a = textureSample(texA, samp, in.uv);
  var b = textureSample(texB, samp, in.uv) * u.y;
  let m = u.x;
  if (m < 0.5) { return b + a * (1 - b.a); }                        // over (premult)
  if (m < 1.5) { return clamp(a + b, vec4f(0), vec4f(1)); }         // add
  if (m < 2.5) { return vec4f(1 - (1 - a.rgb) * (1 - b.rgb), max(a.a, b.a)); } // screen
  if (m < 3.5) { return vec4f(a.rgb * mix(vec3f(1), b.rgb, b.a), a.a); }       // multiply
  return vec4f(abs(a.rgb - b.rgb), max(a.a, b.a));                  // difference
}
`;

const blend: NodeImpl = {
  render(env, node, inputs, params) {
    const pipeline = fullscreenPipeline(env.device, 'blend', BLEND_FS);
    return runPass(env, pipeline, [
      uni(env, node.id, new Float32Array([params.mode, params.mix, 0, 0])),
      sharedSampler(env.device),
      texOr(env, inputs[0]),
      texOr(env, inputs[1]),
    ]);
  },
};

// -- scenes ----------------------------------------------------------------------

const SCENES_FS = /* wgsl */ `
@group(0) @binding(0) var<uniform> u: vec4f; // k, 0, 0, 0
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var texA: texture_2d<f32>;
@group(0) @binding(3) var texB: texture_2d<f32>;

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let a = textureSample(texA, samp, in.uv);
  let b = textureSample(texB, samp, in.uv);
  return mix(a, b, u.x); // premultiplied crossfade
}
`;

const scenes: NodeImpl = {
  render(env, node, inputs, params) {
    const active = inputs.filter((t): t is GPUTexture => t !== null);
    if (active.length === 0) return null;
    const hold = Math.max(0.1, params.hold);
    const fade = Math.max(0.05, params.fade);
    const cycle = hold + fade;
    const pos = env.time % (active.length * cycle);
    const idx = Math.floor(pos / cycle);
    const phase = pos - idx * cycle;
    const x = clamp01((phase - hold) / fade);
    const k = active.length > 1 ? x * x * (3 - 2 * x) : 0; // smoothstep
    const a = active[idx];
    const b = active[(idx + 1) % active.length];
    const pipeline = fullscreenPipeline(env.device, 'scenes', SCENES_FS);
    return runPass(env, pipeline, [
      uni(env, node.id, new Float32Array([k, 0, 0, 0])),
      sharedSampler(env.device),
      a.createView(),
      b.createView(),
    ]);
  },
};

// -- 3D raymarch (VISUALIZER_3D_PLAN.md, PR1) --------------------------------
// Each is a fullscreen fragment pass that marches a distance field and returns
// a flattened premultiplied layer — so blur/bloom/feedback compose them like
// any other source. A `quality` param scales the march step so heavy
// tiles/thumbnails stay cheap (paired with the per-container res/fps caps).

// -- raytunnel: endless tube, camera flies forward along the path ------------

const RAYTUNNEL_FS = /* wgsl */ `
struct Uni { a: vec4f, b: vec4f, c: vec4f };
@group(0) @binding(0) var<uniform> u: Uni;

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let fov = u.a.x; let aspect = u.a.y; let time = u.a.z; let speed = u.a.w;
  let twist = u.b.x; let radius = u.b.y; let glow = u.b.z; let hue = u.b.w;
  let roll = u.c.x; let quality = u.c.y; let centroid = u.c.w;

  let ndc = vec2f((in.uv.x * 2.0 - 1.0) * aspect, (1.0 - in.uv.y) * 2.0 - 1.0);
  let cr = cos(roll); let sr = sin(roll);
  let rxy = vec2f(ndc.x * cr - ndc.y * sr, ndc.x * sr + ndc.y * cr);
  let fl = 1.0 / tan(fov * 0.5);
  let rd = normalize(vec3f(rxy, fl));
  let ro = vec3f(0.0);
  let travel = time * speed * 4.0;

  var t = 0.0; var hit = 0.0; var glowAcc = 0.0; var pz = 0.0; var stripe = 0.0;
  let stepK = mix(0.7, 0.35, clamp(quality, 0.0, 1.0));
  for (var k = 0; k < 80; k++) {
    let p = ro + rd * t;
    let z = p.z + travel;
    let ang = z * twist;
    let ca = cos(ang); let sa = sin(ang);
    let q = vec2f(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
    let center = vec2f(sin(z * 0.15), cos(z * 0.12)) * 0.6;
    let d = radius - length(q - center);
    glowAcc += 1.0 / (1.0 + d * d * 60.0);
    if (d < 0.02) { hit = 1.0; pz = z; stripe = 0.5 + 0.5 * sin(z * 1.5); break; }
    t += max(d * stepK, 0.03);
    if (t > 40.0) { break; }
  }
  let baseH = hue + pz * 0.02 + centroid * 0.2;
  let col = hsl2rgb(baseH, 0.75, 0.18 + 0.4 * stripe);
  let fade = hit * (1.0 - clamp(t / 40.0, 0.0, 1.0));
  let g = glow * glowAcc * 0.04;
  let a = clamp(fade + g, 0.0, 1.0);
  return vec4f(col * a, a);
}
`;

const raytunnel: NodeImpl = {
  render(env, node, _inputs, params) {
    const f = env.features;
    const level = f ? Math.min(1, f.level * 2.2) : 0;
    const centroid = f ? f.centroid : 0;
    const aspect = env.width / env.height;
    const radius = params.radius * (1 + 0.4 * level);
    const data = new Float32Array([
      params.fov, aspect, env.time, params.speed,
      params.twist, radius, params.glow, params.hue,
      params.roll, params.quality, level, centroid,
    ]);
    const pipeline = fullscreenPipeline(env.device, 'raytunnel', RAYTUNNEL_FS);
    return runPass(env, pipeline, [uni(env, node.id, data)]);
  },
};

// -- sdffractal: mandelbox distance estimator, orbit camera -----------------

const SDFFRACTAL_FS = CAMERA_WGSL + /* wgsl */ `
struct Uni { a: vec4f, b: vec4f, c: vec4f, d: vec4f };
@group(0) @binding(0) var<uniform> u: Uni;

fn de(p0: vec3f, scale: f32, iters: i32) -> f32 {
  let minR2 = 0.25; let fixedR2 = 1.0;
  var p = p0; var dr = 1.0;
  for (var i = 0; i < iters; i++) {
    p = clamp(p, vec3f(-1.0), vec3f(1.0)) * 2.0 - p;
    let r2 = dot(p, p);
    if (r2 < minR2) { let s = fixedR2 / minR2; p *= s; dr *= s; }
    else if (r2 < fixedR2) { let s = fixedR2 / r2; p *= s; dr *= s; }
    p = p * scale + p0;
    dr = dr * abs(scale) + 1.0;
  }
  return length(p) / abs(dr);
}

fn calcN(p: vec3f, scale: f32, iters: i32) -> vec3f {
  let e = vec2f(0.0015, 0.0);
  return normalize(vec3f(
    de(p + e.xyy, scale, iters) - de(p - e.xyy, scale, iters),
    de(p + e.yxy, scale, iters) - de(p - e.yxy, scale, iters),
    de(p + e.yyx, scale, iters) - de(p - e.yyx, scale, iters)));
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let eye = u.a.xyz; let fov = u.a.w;
  let ctr = u.b.xyz; let aspect = u.b.w;
  let scale = u.c.y; let iters = i32(u.c.z); let glow = u.c.w;
  let hue = u.d.x; let quality = u.d.y; let centroid = u.d.z;

  let ray = cameraRay(in.uv, aspect, eye, ctr, fov);
  var t = 0.0; var steps = 0.0; var hit = 0.0; var hp = vec3f(0.0); var dmin = 1e9;
  let stepK = mix(0.6, 0.95, clamp(quality, 0.0, 1.0));
  for (var k = 0; k < 90; k++) {
    let p = ray.ro + ray.rd * t;
    let d = de(p, scale, iters);
    dmin = min(dmin, d);
    steps += 1.0;
    if (d < 0.0008 * t + 0.0004) { hit = 1.0; hp = p; break; }
    t += d * stepK;
    if (t > 24.0) { break; }
  }
  let occ = 1.0 - steps / 90.0;
  var lit = 0.0; var rim = 0.0;
  if (hit > 0.5) {
    let n = calcN(hp, scale, iters);
    let ld = normalize(vec3f(0.5, 0.8, 0.3));
    lit = clamp(dot(n, ld), 0.0, 1.0) * 0.8 + 0.2;
    rim = pow(1.0 - clamp(dot(n, -ray.rd), 0.0, 1.0), 3.0);
  }
  let h = hue + dmin * 1.5 + centroid * 0.2;
  let col = hsl2rgb(h, 0.7, 0.2 + 0.45 * lit * occ);
  let edge = glow * (rim + (steps / 90.0) * 0.4);
  let a = clamp(hit * occ + edge, 0.0, 1.0);
  return vec4f(col * a + hsl2rgb(h, 0.6, 0.6) * edge * 0.5, a);
}
`;

const sdffractal: NodeImpl = {
  render(env, node, _inputs, params) {
    const f = env.features;
    const centroid = f ? f.centroid : 0;
    const { eye, target } = cameraEye(camFromParams(params), env.time);
    const aspect = env.width / env.height;
    const data = new Float32Array([
      eye[0], eye[1], eye[2], params.fov,
      target[0], target[1], target[2], aspect,
      env.time, params.scale, params.iters, params.glow,
      params.hue, params.quality, centroid, 0,
    ]);
    const pipeline = fullscreenPipeline(env.device, 'sdffractal', SDFFRACTAL_FS);
    return runPass(env, pipeline, [uni(env, node.id, data)]);
  },
};

// -- terrain: scrolling 3D heightfield from spectrum history -----------------

const TERRAIN_HIST = 64;
const TERRAIN_FIELD = 4.0;

const TERRAIN_FS = CAMERA_WGSL + /* wgsl */ `
struct Uni { a: vec4f, b: vec4f, c: vec4f, d: vec4f };
@group(0) @binding(0) var<uniform> u: Uni;
@group(0) @binding(1) var<storage, read> field: array<f32>;

const BINS = ${SPECTRUM_BINS}u;
const HIST = ${TERRAIN_HIST}u;

fn sampleH(x: f32, z: f32, writeIdx: u32, fieldSize: f32, height: f32) -> f32 {
  let bx = (x / fieldSize * 0.5 + 0.5) * f32(BINS - 1u);
  let az = (z / fieldSize * 0.5 + 0.5) * f32(HIST - 1u);
  if (bx < 0.0 || bx > f32(BINS - 1u) || az < 0.0 || az > f32(HIST - 1u)) { return 0.0; }
  let bx0 = floor(bx); let az0 = floor(az);
  let fx = bx - bx0; let fz = az - az0;
  let row0 = (writeIdx + HIST - 1u - u32(az0)) % HIST;
  let row1 = (writeIdx + HIST - 2u - u32(az0)) % HIST;
  let b0 = u32(bx0); let b1 = min(b0 + 1u, BINS - 1u);
  let h00 = field[row0 * BINS + b0]; let h01 = field[row0 * BINS + b1];
  let h10 = field[row1 * BINS + b0]; let h11 = field[row1 * BINS + b1];
  let h0 = mix(h00, h01, fx); let h1 = mix(h10, h11, fx);
  return mix(h0, h1, fz) * height;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let eye = u.a.xyz; let fov = u.a.w;
  let ctr = u.b.xyz; let aspect = u.b.w;
  let height = u.c.y; let glow = u.c.z; let hue = u.c.w;
  let quality = u.d.x; let writeIdx = u32(u.d.y); let fieldSize = u.d.z;

  let ray = cameraRay(in.uv, aspect, eye, ctr, fov);
  var t = 0.1; var hit = 0.0; var hp = vec3f(0.0);
  let stepK = mix(0.6, 0.3, clamp(quality, 0.0, 1.0));
  for (var k = 0; k < 110; k++) {
    let p = ray.ro + ray.rd * t;
    let h = sampleH(p.x, p.z, writeIdx, fieldSize, height);
    let diff = p.y - h;
    if (diff < 0.02) { hit = 1.0; hp = p; break; }
    t += max(diff * stepK, 0.02);
    if (t > 60.0) { break; }
  }
  if (hit < 0.5) { return vec4f(0.0); }
  let e = 0.06;
  let hl = sampleH(hp.x - e, hp.z, writeIdx, fieldSize, height);
  let hr = sampleH(hp.x + e, hp.z, writeIdx, fieldSize, height);
  let hb = sampleH(hp.x, hp.z - e, writeIdx, fieldSize, height);
  let hf = sampleH(hp.x, hp.z + e, writeIdx, fieldSize, height);
  let n = normalize(vec3f(hl - hr, 2.0 * e, hb - hf));
  let ld = normalize(vec3f(0.4, 0.7, 0.5));
  let lit = clamp(dot(n, ld), 0.0, 1.0) * 0.75 + 0.25;
  let hh = hue + hp.y * 0.5;
  let fog = 1.0 - clamp(t / 60.0, 0.0, 1.0);
  let rim = pow(1.0 - clamp(dot(n, -ray.rd), 0.0, 1.0), 3.0) * glow;
  let col = hsl2rgb(hh, 0.7, 0.15 + 0.45 * lit) * fog;
  return vec4f(col * fog + hsl2rgb(hh, 0.6, 0.7) * rim * fog, fog);
}
`;

const terrain: NodeImpl = {
  render(env, node, _inputs, params) {
    const state = env.states.get(env.ns + node.id);
    const BINS = SPECTRUM_BINS;
    if (!state.storage) {
      state.storage = env.device.createBuffer({
        size: BINS * TERRAIN_HIST * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      state.ring = 0;
    }
    if (!state.scratch) state.scratch = new Float32Array(BINS);
    const f = env.features;
    const row = state.scratch;
    if (f) for (let b = 0; b < BINS; b++) row[b] = binFrac(f.spectrum[b]);
    else row.fill(0);
    env.device.queue.writeBuffer(
      state.storage,
      state.ring * BINS * 4,
      row as Float32Array<ArrayBuffer>,
    );
    state.ring = (state.ring + 1) % TERRAIN_HIST;

    const { eye, target } = cameraEye(camFromParams(params), env.time);
    const aspect = env.width / env.height;
    const data = new Float32Array([
      eye[0], eye[1], eye[2], params.fov,
      target[0], target[1], target[2], aspect,
      env.time, params.height, params.glow, params.hue,
      params.quality, state.ring, TERRAIN_FIELD, 0,
    ]);
    const pipeline = fullscreenPipeline(env.device, 'terrain', TERRAIN_FS);
    return runPass(env, pipeline, [uni(env, node.id, data), { buffer: state.storage }]);
  },
};

// -- 3D raster (VISUALIZER_3D_PLAN.md, PR2) ----------------------------------
// Real geometry with a depth buffer (bars3d) and additive perspective
// billboards (particles3d). Both build their own render pass (the fullscreen
// runPass helper has no depth/vertex-buffer support) and return a flattened
// layer like every other node. Entry points avoid the names vs/fs so
// COMMON_WGSL (prepended for hsl2rgb) doesn't clash.

// -- bars3d: instanced cubes, spectrum heightfield, lambert + fresnel --------

const BARS3D_WGSL = COMMON_WGSL + /* wgsl */ `
struct Uni { mvp: mat4x4f, cam: vec4f, light: vec4f }; // cam.w = glow
@group(0) @binding(0) var<uniform> u: Uni;
struct Inst { a: vec4f, b: vec4f }; // a = offX, offZ, width, height ; b.x = hue
@group(0) @binding(1) var<storage, read> inst: array<Inst>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) nrm: vec3f,
  @location(1) world: vec3f,
  @location(2) @interpolate(flat) hue: f32,
};

@vertex
fn bvs(@location(0) p: vec3f, @location(1) n: vec3f, @builtin(instance_index) ii: u32) -> VOut {
  let it = inst[ii];
  let off = vec3f(it.a.x, 0.0, it.a.y);
  let world = off + vec3f(p.x * it.a.z, p.y * it.a.w, p.z * it.a.z);
  var o: VOut;
  o.pos = u.mvp * vec4f(world, 1.0);
  o.nrm = n;
  o.world = world;
  o.hue = it.b.x;
  return o;
}

@fragment
fn bfs(in: VOut) -> @location(0) vec4f {
  let N = normalize(in.nrm);
  let L = normalize(u.light.xyz);
  let V = normalize(u.cam.xyz - in.world);
  let diff = clamp(dot(N, L), 0.0, 1.0) * 0.8 + 0.2;
  let fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  let base = hsl2rgb(in.hue, 0.7, 0.22 + 0.35 * diff);
  let col = base + hsl2rgb(in.hue, 0.6, 0.7) * fres * u.cam.w;
  return vec4f(col, 1.0);
}
`;

const BARS3D_MAX = 256; // 16×16 grid cap
const BARS3D_STRIDE = 8;

const bars3d: NodeImpl = {
  render(env, node, _inputs, params) {
    const state = env.states.get(env.ns + node.id);
    const G = Math.max(2, Math.min(16, Math.round(params.count)));
    const N = G * G;
    const spacing = params.spacing;
    const width = spacing * 0.6;
    const f = env.features;
    const BINS = SPECTRUM_BINS;

    if (!state.instanceData) state.instanceData = new Float32Array(BARS3D_MAX * BARS3D_STRIDE);
    const inst = state.instanceData;
    for (let i = 0; i < N; i++) {
      const col = i % G;
      const rowi = Math.floor(i / G);
      const bin = (rowi * G + col) % BINS;
      const hgt = f ? binFrac(f.spectrum[bin]) : 0.05;
      const o = i * BARS3D_STRIDE;
      inst[o] = (col - (G - 1) / 2) * spacing;
      inst[o + 1] = (rowi - (G - 1) / 2) * spacing;
      inst[o + 2] = width;
      inst[o + 3] = 0.05 + hgt * params.heightScale;
      inst[o + 4] = (params.hue + (bin / BINS) * 0.3) % 1;
    }
    if (!state.storage) {
      state.storage = env.device.createBuffer({
        size: BARS3D_MAX * BARS3D_STRIDE * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    env.device.queue.writeBuffer(state.storage, 0, inst);

    const { eye, target } = cameraEye(camFromParams(params), env.time);
    const aspect = env.width / env.height;
    const mvp = viewProj(eye, target, params.fov, aspect);
    const udata = new Float32Array(24);
    udata.set(mvp, 0);
    udata[16] = eye[0]; udata[17] = eye[1]; udata[18] = eye[2]; udata[19] = params.glow;
    udata[20] = 0.4; udata[21] = 0.8; udata[22] = 0.5;
    const ubuf = state.uniform(env.device, udata.byteLength);
    env.device.queue.writeBuffer(ubuf, 0, udata);

    const cube = unitCube(env.device);
    const pipeline = customPipeline(env.device, 'bars3d', () => {
      const module = env.device.createShaderModule({ code: BARS3D_WGSL });
      return env.device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'bvs',
          buffers: [{
            arrayStride: 24,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
            ],
          }],
        },
        fragment: { module, entryPoint: 'bfs', targets: [{ format: RT_FORMAT }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
      });
    });

    const out = env.pool.acquire(env.width, env.height);
    const depth = env.pool.acquireDepth(env.width, env.height);
    const pass = env.encoder.beginRenderPass({
      colorAttachments: [
        { view: out.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
      depthStencilAttachment: {
        view: depth.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      env.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ubuf } },
          { binding: 1, resource: { buffer: state.storage } },
        ],
      }),
    );
    pass.setVertexBuffer(0, cube.buffer);
    pass.draw(cube.count, N);
    pass.end();
    return out;
  },
};

// -- particles3d: additive perspective billboards (no depth) -----------------

const PARTICLES3D_WGSL = COMMON_WGSL + /* wgsl */ `
struct Uni { mvp: mat4x4f, misc: vec4f }; // misc.x = aspect
@group(0) @binding(0) var<uniform> u: Uni;
struct Inst { ps: vec4f, col: vec4f }; // ps = xyz, size ; col = hue, alpha
@group(0) @binding(1) var<storage, read> inst: array<Inst>;

struct POut {
  @builtin(position) pos: vec4f,
  @location(0) corner: vec2f,
  @location(1) @interpolate(flat) idx: u32,
};

@vertex
fn p3vs(@builtin(vertex_index) v: u32, @builtin(instance_index) ii: u32) -> POut {
  var corners = array<vec2f, 6>(
    vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1),
    vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1));
  let c = corners[v];
  let it = inst[ii];
  var clip = u.mvp * vec4f(it.ps.xyz, 1.0);
  // Screen-space billboard with perspective shrink (offset added pre-divide).
  clip.x = clip.x + c.x * it.ps.w / u.misc.x;
  clip.y = clip.y + c.y * it.ps.w;
  var o: POut;
  o.pos = clip;
  o.corner = c;
  o.idx = ii;
  return o;
}

@fragment
fn p3fs(in: POut) -> @location(0) vec4f {
  let it = inst[in.idx];
  let d = length(in.corner);
  let a = smoothstep(1.0, 0.0, d) * it.col.y;
  return vec4f(hsl2rgb(it.col.x, 0.8, 0.6) * a, a);
}
`;

const PARTICLES3D_MAX = 1200;
const PARTICLES3D_STRIDE = 8;

function randDir(): [number, number, number] {
  const u = Math.random() * 2 - 1;
  const t = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - u * u);
  return [r * Math.cos(t), u, r * Math.sin(t)];
}

const particles3d: NodeImpl = {
  render(env, node, _inputs, params) {
    const state = env.states.get(env.ns + node.id);
    const f = env.features;

    if (f) {
      for (const pitch of f.notes) {
        for (let i = 0; i < 10; i++) {
          const d = randDir();
          state.particles.push({
            x: d[0] * 0.2, y: d[1] * 0.2, z: d[2] * 0.2,
            vx: d[0] * 2, vy: d[1] * 2, vz: d[2] * 2,
            life: 1, hue: (pitch % 12) / 12,
          });
        }
      }
      const burst = Math.round(f.onset * params.rate * 20);
      for (let i = 0; i < burst; i++) {
        const d = randDir();
        state.particles.push({
          x: 0, y: 0, z: 0,
          vx: d[0] * 3, vy: d[1] * 3, vz: d[2] * 3,
          life: 1, hue: f.centroid,
        });
      }
    }
    if (state.particles.length > PARTICLES3D_MAX) {
      state.particles.splice(0, state.particles.length - PARTICLES3D_MAX);
    }
    const dt = env.dt;
    const spread = params.spread;
    const live: Particle[] = [];
    for (const p of state.particles) {
      p.x += p.vx * dt * spread;
      p.y += p.vy * dt * spread;
      p.z += p.vz * dt * spread;
      p.vx *= 0.98; p.vy *= 0.98; p.vz *= 0.98;
      p.life -= 0.4 * dt;
      if (p.life > 0) live.push(p);
    }
    state.particles = live;

    if (!state.instanceData) state.instanceData = new Float32Array(PARTICLES3D_MAX * PARTICLES3D_STRIDE);
    const inst = state.instanceData;
    for (let i = 0; i < live.length; i++) {
      const p = live[i];
      const o = i * PARTICLES3D_STRIDE;
      inst[o] = p.x; inst[o + 1] = p.y; inst[o + 2] = p.z;
      inst[o + 3] = params.size * (0.3 + 0.7 * p.life);
      inst[o + 4] = p.hue;
      inst[o + 5] = p.life;
    }
    if (!state.storage) {
      state.storage = env.device.createBuffer({
        size: PARTICLES3D_MAX * PARTICLES3D_STRIDE * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    if (live.length > 0) env.device.queue.writeBuffer(state.storage, 0, inst);

    const { eye, target } = cameraEye(camFromParams(params), env.time);
    const aspect = env.width / env.height;
    const mvp = viewProj(eye, target, params.fov, aspect);
    const udata = new Float32Array(20);
    udata.set(mvp, 0);
    udata[16] = aspect;
    const ubuf = state.uniform(env.device, udata.byteLength);
    env.device.queue.writeBuffer(ubuf, 0, udata);

    const pipeline = customPipeline(env.device, 'particles3d', () => {
      const module = env.device.createShaderModule({ code: PARTICLES3D_WGSL });
      return env.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'p3vs' },
        fragment: {
          module,
          entryPoint: 'p3fs',
          targets: [{
            format: RT_FORMAT,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one' },
              alpha: { srcFactor: 'one', dstFactor: 'one' },
            },
          }],
        },
        primitive: { topology: 'triangle-list' },
      });
    });

    const out = env.pool.acquire(env.width, env.height);
    const pass = env.encoder.beginRenderPass({
      colorAttachments: [
        { view: out.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      env.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ubuf } },
          { binding: 1, resource: { buffer: state.storage } },
        ],
      }),
    );
    if (live.length > 0) pass.draw(6, live.length);
    pass.end();
    return out;
  },
};

// -- registry -------------------------------------------------------------------

export const NODE_IMPLS: Record<string, NodeImpl> = {
  spectrum,
  scope,
  particles,
  shapes,
  gradient,
  raytunnel,
  sdffractal,
  terrain,
  bars3d,
  particles3d,
  image,
  video,
  webcam,
  textlayer,
  visualin,
  blur,
  pixelate,
  feedback,
  kaleido,
  colorgrade: colorgradeImpl,
  chromashift,
  warp,
  bloom,
  mirror,
  blend,
  scenes,
};
