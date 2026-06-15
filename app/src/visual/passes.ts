/**
 * Shared GPU plumbing for visual nodes: pipeline/sampler caches, a pooled
 * texture allocator, per-node persistent state, and the fullscreen-pass
 * helper every effect is built on. Node implementations live in nodes.ts;
 * the graph walk lives in runtime.ts.
 */

import type { VisFeatures } from './types';

/** Intermediate render-target format (canvas blit converts at the end). */
export const RT_FORMAT: GPUTextureFormat = 'rgba8unorm';

/** Depth-buffer format for the raster 3D nodes (bars3d). */
export const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

/** Fullscreen-triangle vertex stage + shared WGSL helpers. */
export const COMMON_WGSL = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1, -3), vec2f(-1, 1), vec2f(3, 1));
  var out: VsOut;
  out.pos = vec4f(p[i], 0, 1);
  out.uv = vec2f((p[i].x + 1) * 0.5, 1 - (p[i].y + 1) * 0.5);
  return out;
}

fn hsl2rgb(h: f32, s: f32, l: f32) -> vec3f {
  let hh = fract(h);
  let a = s * min(l, 1 - l);
  var rgb: vec3f;
  for (var n = 0; n < 3; n++) {
    let k = (f32(n) * 4 + hh * 12) % 12;
    rgb[n] = l - a * max(-1.0, min(min(k - 3, 9 - k), 1.0));
  }
  return rgb;
}
`;

/**
 * Camera-ray builder for the 3D (raymarch) nodes — appended after COMMON_WGSL
 * by nodes that need it. `eye`/`target`/`fov` come from camera3d.cameraEye on
 * the CPU; this turns the fullscreen uv into a world-space ray. Up is +Y;
 * pitch is range-clamped so the up-vector never degenerates.
 */
export const CAMERA_WGSL = /* wgsl */ `
struct Ray { ro: vec3f, rd: vec3f };

fn cameraRay(uv: vec2f, aspect: f32, eye: vec3f, ctr: vec3f, fov: f32) -> Ray {
  let fwd = normalize(ctr - eye);
  let right = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, fwd);
  let ndc = vec2f((uv.x * 2.0 - 1.0) * aspect, (1.0 - uv.y) * 2.0 - 1.0);
  let f = 1.0 / tan(fov * 0.5);
  var r: Ray;
  r.ro = eye;
  r.rd = normalize(fwd * f + right * ndc.x + up * ndc.y);
  return r;
}
`;

interface DeviceCache {
  pipelines: Map<string, GPURenderPipeline>;
  sampler: GPUSampler;
}

const deviceCaches = new WeakMap<GPUDevice, DeviceCache>();

function cacheFor(device: GPUDevice): DeviceCache {
  let c = deviceCaches.get(device);
  if (!c) {
    c = {
      pipelines: new Map(),
      sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
    };
    deviceCaches.set(device, c);
  }
  return c;
}

export function sharedSampler(device: GPUDevice): GPUSampler {
  return cacheFor(device).sampler;
}

/**
 * Build (or fetch) a fullscreen pipeline. `key` must uniquely identify the
 * fragment code + target format; `code` is the fragment stage with entry
 * `fs` (COMMON_WGSL is prepended).
 */
export function fullscreenPipeline(
  device: GPUDevice,
  key: string,
  code: string,
  format: GPUTextureFormat = RT_FORMAT,
): GPURenderPipeline {
  const cache = cacheFor(device);
  const fullKey = `${key}:${format}`;
  let p = cache.pipelines.get(fullKey);
  if (!p) {
    const module = device.createShaderModule({ code: COMMON_WGSL + code });
    p = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    cache.pipelines.set(fullKey, p);
  }
  return p;
}

/** As fullscreenPipeline but with a caller-supplied descriptor (particles). */
export function customPipeline(
  device: GPUDevice,
  key: string,
  build: () => GPURenderPipeline,
): GPURenderPipeline {
  const cache = cacheFor(device);
  let p = cache.pipelines.get(key);
  if (!p) {
    p = build();
    cache.pipelines.set(key, p);
  }
  return p;
}

// -- texture pool -----------------------------------------------------------

const RT_USAGE =
  GPUTextureUsage.RENDER_ATTACHMENT |
  GPUTextureUsage.TEXTURE_BINDING |
  GPUTextureUsage.COPY_SRC |
  GPUTextureUsage.COPY_DST;

/**
 * Frame-scoped render targets. acquire() during a frame, endFrame() returns
 * everything to the free lists. Persistent textures (feedback history, media
 * uploads) do NOT come from here — they live in NodeState.
 */
export class TexturePool {
  private free = new Map<string, GPUTexture[]>();
  private used: { key: string; tex: GPUTexture }[] = [];
  private freeDepth = new Map<string, GPUTexture[]>();
  private usedDepth: { key: string; tex: GPUTexture }[] = [];

  constructor(private readonly device: GPUDevice) {}

  acquire(width: number, height: number): GPUTexture {
    const key = `${width}x${height}`;
    const tex =
      this.free.get(key)?.pop() ??
      this.device.createTexture({ size: { width, height }, format: RT_FORMAT, usage: RT_USAGE });
    this.used.push({ key, tex });
    return tex;
  }

  /** Frame-scoped depth attachment for raster passes (returned on endFrame). */
  acquireDepth(width: number, height: number): GPUTexture {
    const key = `${width}x${height}`;
    const tex =
      this.freeDepth.get(key)?.pop() ??
      this.device.createTexture({
        size: { width, height },
        format: DEPTH_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    this.usedDepth.push({ key, tex });
    return tex;
  }

  endFrame(): void {
    for (const { key, tex } of this.used) {
      let list = this.free.get(key);
      if (!list) this.free.set(key, (list = []));
      list.push(tex);
    }
    this.used = [];
    for (const { key, tex } of this.usedDepth) {
      let list = this.freeDepth.get(key);
      if (!list) this.freeDepth.set(key, (list = []));
      list.push(tex);
    }
    this.usedDepth = [];
  }

  /** Drop everything (canvas resize → stale sizes accumulate otherwise). */
  destroy(): void {
    this.endFrame();
    for (const list of this.free.values()) for (const tex of list) tex.destroy();
    this.free.clear();
    for (const list of this.freeDepth.values()) for (const tex of list) tex.destroy();
    this.freeDepth.clear();
  }
}

// -- cube geometry (raster 3D) ------------------------------------------------
// One device-cached non-indexed unit cube (36 verts, position + normal). Bars
// instance it; y spans 0..1 so a bar grows up from the ground plane.

const cubeBuffers = new WeakMap<GPUDevice, { buffer: GPUBuffer; count: number }>();

function buildUnitCube(): Float32Array {
  // 6 faces × 2 triangles × 3 verts, each [px,py,pz, nx,ny,nz]. y in [0,1].
  const faces: Array<{ n: [number, number, number]; verts: Array<[number, number, number]> }> = [];
  const add = (
    n: [number, number, number],
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
  ) => faces.push({ n, verts: [a, b, c, a, c, d] });
  // x = ±0.5, z = ±0.5, y = 0..1
  add([0, 0, 1], [-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]); // front +z
  add([0, 0, -1], [0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5], [0.5, 1, -0.5]); // back -z
  add([1, 0, 0], [0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5]); // right +x
  add([-1, 0, 0], [-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5], [-0.5, 1, -0.5]); // left -x
  add([0, 1, 0], [-0.5, 1, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5]); // top +y
  add([0, -1, 0], [-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5]); // bottom -y
  const data = new Float32Array(faces.length * 6 * 6);
  let o = 0;
  for (const f of faces) {
    for (const v of f.verts) {
      data[o++] = v[0]; data[o++] = v[1]; data[o++] = v[2];
      data[o++] = f.n[0]; data[o++] = f.n[1]; data[o++] = f.n[2];
    }
  }
  return data;
}

/** Device-cached unit cube vertex buffer (pos+normal, 36 verts). */
export function unitCube(device: GPUDevice): { buffer: GPUBuffer; count: number } {
  let c = cubeBuffers.get(device);
  if (!c) {
    const data = buildUnitCube();
    const buffer = device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, data);
    c = { buffer, count: data.length / 6 };
    cubeBuffers.set(device, c);
  }
  return c;
}

export function createPersistentTexture(device: GPUDevice, width: number, height: number): GPUTexture {
  return device.createTexture({ size: { width, height }, format: RT_FORMAT, usage: RT_USAGE });
}

// -- per-node persistent state ------------------------------------------------

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  hue: number;
  /** 3D depth + its velocity (particles3d). The 2D particles node leaves these 0. */
  z: number;
  vz: number;
}

/** Mutable per-node-instance state surviving across frames. */
export class NodeState {
  /** Cached uniform buffers by byte length. */
  private uniforms = new Map<number, GPUBuffer>();
  /** Generic storage buffer (scope wave, particle instances). */
  storage: GPUBuffer | null = null;
  /** Persistent texture (feedback history, media upload). */
  texture: GPUTexture | null = null;
  /** Second persistent texture (bloom ping-pong is frame-scoped; this is for swap nodes). */
  texture2: GPUTexture | null = null;
  /** Texture dims for media/persistent reallocation checks. */
  texW = 0;
  texH = 0;
  /** Media source bookkeeping. */
  srcKey: string | null = null;
  video: HTMLVideoElement | null = null;
  stream: MediaStream | null = null;
  loading = false;
  /** CPU particle sim. */
  particles: Particle[] = [];
  instanceData: Float32Array | null = null;
  /** Ring-buffer write cursor + CPU staging row (terrain spectrum history). */
  ring = 0;
  scratch: Float32Array | null = null;
  /** 2D rasterization surface (Text Layer). */
  canvas2d: OffscreenCanvas | null = null;
  /** Timestamp marker (typewriter restart on content change). */
  mark = 0;

  uniform(device: GPUDevice, byteLength: number): GPUBuffer {
    let b = this.uniforms.get(byteLength);
    if (!b) {
      b = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.uniforms.set(byteLength, b);
    }
    return b;
  }

  dispose(): void {
    for (const b of this.uniforms.values()) b.destroy();
    this.uniforms.clear();
    this.storage?.destroy();
    this.texture?.destroy();
    this.texture2?.destroy();
    this.video?.pause();
    this.video?.remove();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.video = null;
    this.stream = null;
  }
}

export class NodeStateStore {
  private states = new Map<string, NodeState>();

  get(nodeId: string): NodeState {
    let s = this.states.get(nodeId);
    if (!s) {
      s = new NodeState();
      this.states.set(nodeId, s);
    }
    return s;
  }

  /**
   * Dispose state for nodes no longer rendered (stops webcam tracks).
   * Keys are "<containerId>/<nodeId>" (chained containers share one store);
   * multi-pass nodes append ":suffix" — same lifetime as their base key.
   */
  prune(liveKeys: ReadonlySet<string>): void {
    for (const [id, s] of this.states) {
      const base = id.split(':')[0];
      if (!liveKeys.has(base)) {
        s.dispose();
        this.states.delete(id);
      }
    }
  }

  destroy(): void {
    for (const s of this.states.values()) s.dispose();
    this.states.clear();
  }
}

// -- render environment ---------------------------------------------------

/** Everything a node implementation needs to render one frame. */
export interface RenderEnv {
  device: GPUDevice;
  encoder: GPUCommandEncoder;
  pool: TexturePool;
  states: NodeStateStore;
  width: number;
  height: number;
  features: VisFeatures | null;
  /** Seconds since renderer creation. */
  time: number;
  /** Seconds since last frame. */
  dt: number;
  /** State-key namespace, "<containerId>/" — chained containers share the store. */
  ns: string;
  /** Frame from the container's Vis In pole (upstream visualizer), if wired. */
  upstream: GPUTexture | null;
}

/**
 * Run one fullscreen fragment pass into a pooled texture.
 * `bindings` order must match @binding indices in the fragment code.
 */
export function runPass(
  env: RenderEnv,
  pipeline: GPURenderPipeline,
  bindings: GPUBindingResource[],
  target?: GPUTexture,
  clear: GPUColor = { r: 0, g: 0, b: 0, a: 0 },
): GPUTexture {
  const out = target ?? env.pool.acquire(env.width, env.height);
  const pass = env.encoder.beginRenderPass({
    colorAttachments: [
      { view: out.createView(), clearValue: clear, loadOp: 'clear', storeOp: 'store' },
    ],
  });
  pass.setPipeline(pipeline);
  if (bindings.length > 0) {
    pass.setBindGroup(
      0,
      env.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: bindings.map((resource, i) => ({ binding: i, resource })),
      }),
    );
  }
  pass.draw(3);
  pass.end();
  return out;
}

/** A 1×1 transparent-black texture for unwired visual inputs. */
const blackTextures = new WeakMap<GPUDevice, GPUTexture>();

export function blackTexture(device: GPUDevice): GPUTexture {
  let t = blackTextures.get(device);
  if (!t) {
    t = device.createTexture({ size: { width: 1, height: 1 }, format: RT_FORMAT, usage: RT_USAGE });
    device.queue.writeTexture({ texture: t }, new Uint8Array(4), {}, { width: 1, height: 1 });
    blackTextures.set(device, t);
  }
  return t;
}
