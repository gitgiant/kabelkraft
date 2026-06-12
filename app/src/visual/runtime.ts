/**
 * WebGPU render runtime — graph evaluator (VISUALIZER_ENGINE_PLAN.md Phase 2).
 * Walks a container's visual graph in topological order, rendering each node
 * into pooled textures and blitting the Output node's input to the canvas.
 * One shared GPUDevice across all views; each view (overlay, pop-out, tile
 * thumbnail) owns a ContainerRenderer with its own pool + node state, so
 * feedback trails are per-view.
 *
 * Shaders are WGSL on purpose: the Phase-3 C++ core runs the same shaders
 * natively through Dawn — keep them dependency-free.
 */

import { resolveParams, topoOrder } from './graphops';
import { NODE_IMPLS } from './nodes';
import {
  fullscreenPipeline,
  sharedSampler,
  NodeStateStore,
  TexturePool,
  type RenderEnv,
} from './passes';
import { VIS_NODE_DEFS, visualInPorts } from './registry';
import type { VisFeatures, VisGraphData } from './types';

export { featureValue, resolveParams, topoOrder } from './graphops';

export function webgpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

/** The GPU path renders any graph whose node types are all known. */
export function graphSupported(graph: VisGraphData | null): boolean {
  return !!graph && graph.nodes.every((n) => VIS_NODE_DEFS.has(n.type));
}

let devicePromise: Promise<GPUDevice | null> | null = null;

/** WebGPU validation errors this session (shader/pipeline bugs) — e2e probe. */
let gpuErrors = 0;

export function visGpuErrors(): number {
  return gpuErrors;
}

/** Shared device across all containers/views; null = WebGPU unavailable. */
export function getDevice(): Promise<GPUDevice | null> {
  devicePromise ??= (async () => {
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      const device = (await adapter?.requestDevice()) ?? null;
      // A lost device (driver reset, tab backgrounding) gets re-requested lazily.
      device?.lost.then(() => {
        devicePromise = null;
      });
      if (device) {
        device.onuncapturederror = (e) => {
          gpuErrors++;
          console.error('WebGPU validation error:', e.error.message);
        };
      }
      return device;
    } catch {
      return null;
    }
  })();
  return devicePromise;
}

/** Total GPU frames rendered this session — e2e progress probe. */
let framesRendered = 0;

export function visFramesRendered(): number {
  return framesRendered;
}

// Background matches the legacy scenes (#0c0c12).
const CLEAR = { r: 0x0c / 255, g: 0x0c / 255, b: 0x12 / 255, a: 1 };

const BLIT_FS = /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, in.uv);
  // Composite over the engine background (premultiplied input).
  let bg = vec3f(${CLEAR.r}, ${CLEAR.g}, ${CLEAR.b});
  return vec4f(c.rgb + bg * (1 - c.a), 1);
}
`;

/**
 * One container plus the upstream containers feeding its Vis In pole —
 * built by the caller (state.visFrame) from main-canvas visual wires, with
 * cycles already broken.
 */
export interface ContainerFrame {
  /** Container module id — namespaces node state across the chain. */
  id: string;
  graph: VisGraphData;
  features: VisFeatures | null;
  /** Rendered before this container; [0] feeds the Visual In node. */
  upstream: ContainerFrame[];
}

// -- derived tint -------------------------------------------------------------
// The UI tint system averages a container's rendered frame into one RGB value
// (group tint poles / module tint ports). A small linear-tap downsample pass
// renders the final frame into a TINT_DS² grid, copies it to a mappable
// buffer, and averages on the CPU after an async map — no pipeline stall.

const TINT_DS = 16;
const TINT_INTERVAL_MS = 66; // ~15 Hz; consumers smooth, so steps don't show
const TINT_ROW_BYTES = 256; // copyTextureToBuffer minimum row alignment
const CLEAR_RGB_INT = (0x0c << 16) | (0x0c << 8) | 0x12;

/** Per-container throttle, shared across views so duplicates don't double-sample. */
const lastTintAt = new Map<string, number>();

export class ContainerRenderer {
  private pool: TexturePool;
  private states = new NodeStateStore();
  private readonly t0 = performance.now();
  private lastTime = 0;

  /** UI hook: should this container's frame be averaged into a tint? */
  static tintWanted: ((id: string) => boolean) | null = null;
  /** UI hook: receives the averaged frame color (packed 24-bit RGB). */
  static tintSink: ((id: string, rgb: number) => void) | null = null;

  private tintTex: GPUTexture | null = null;
  private tintBuf: GPUBuffer | null = null;
  private tintPending = false;

  private constructor(
    private readonly device: GPUDevice,
    private readonly ctx: GPUCanvasContext,
    private readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    private readonly format: GPUTextureFormat,
  ) {
    this.pool = new TexturePool(device);
    ctx.configure({ device, format, alphaMode: 'opaque' });
  }

  /** Null when WebGPU is unavailable or the device can't be acquired. */
  static async create(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<ContainerRenderer | null> {
    if (!webgpuAvailable()) return null;
    const device = await getDevice();
    const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!device || !ctx) return null;
    return new ContainerRenderer(device, ctx, canvas, navigator.gpu.getPreferredCanvasFormat());
  }

  /**
   * Backing-store multiplier over CSS size — set to the patch-canvas zoom
   * when the target sits inside a CSS-scaled panel so output stays sharp.
   */
  resolutionScale = 1;

  /** Render one container graph; recurses into upstream containers first. */
  private evalContainer(
    base: Omit<RenderEnv, 'ns' | 'upstream' | 'features'>,
    frame: ContainerFrame,
    liveKeys: Set<string>,
  ): GPUTexture | null {
    const upstream =
      frame.upstream.length > 0 ? this.evalContainer(base, frame.upstream[0], liveKeys) : null;
    const env: RenderEnv = { ...base, ns: `${frame.id}/`, upstream, features: frame.features };
    const textures = new Map<string, GPUTexture | null>();
    let final: GPUTexture | null = null;
    for (const node of topoOrder(frame.graph)) {
      const def = VIS_NODE_DEFS.get(node.type);
      if (!def) continue;
      liveKeys.add(env.ns + node.id);
      if (node.type === 'output') {
        const wire = frame.graph.wires.find((w) => w.to.nodeId === node.id && w.to.portId === 'in');
        final = wire ? (textures.get(wire.from.nodeId) ?? null) : null;
        continue;
      }
      const impl = NODE_IMPLS[node.type];
      if (!impl) continue;
      const inputs = visualInPorts(def).map((port) => {
        const wire = frame.graph.wires.find(
          (w) => w.to.nodeId === node.id && w.to.portId === port.id,
        );
        return wire ? (textures.get(wire.from.nodeId) ?? null) : null;
      });
      textures.set(
        node.id,
        impl.render(env, node, inputs, resolveParams(frame.graph, node, frame.features)),
      );
    }
    return final;
  }

  /** Draw one frame of the container chain into the canvas. */
  render(frame: ContainerFrame): void {
    const el = this.canvas as HTMLCanvasElement;
    const s = Math.max(0.25, Math.min(3, this.resolutionScale));
    const w = el.clientWidth ? Math.round(el.clientWidth * s) : this.canvas.width;
    const h = el.clientHeight ? Math.round(el.clientHeight * s) : this.canvas.height;
    if (w > 0 && h > 0 && (this.canvas.width !== w || this.canvas.height !== h)) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.pool.destroy();
      this.pool = new TexturePool(this.device);
    }
    if (this.canvas.width === 0 || this.canvas.height === 0) return;

    const now = (performance.now() - this.t0) / 1000;
    const dt = Math.min(0.1, Math.max(0.001, now - this.lastTime));
    this.lastTime = now;

    const base = {
      device: this.device,
      encoder: this.device.createCommandEncoder(),
      pool: this.pool,
      states: this.states,
      width: this.canvas.width,
      height: this.canvas.height,
      time: now,
      dt,
    };
    const liveKeys = new Set<string>();
    const final = this.evalContainer(base, frame, liveKeys);
    const env = base as unknown as RenderEnv;

    // Blit (or clear) to the canvas.
    const view = this.ctx.getCurrentTexture().createView();
    if (final) {
      const pipeline = fullscreenPipeline(this.device, 'blit', BLIT_FS, this.format);
      const pass = env.encoder.beginRenderPass({
        colorAttachments: [{ view, clearValue: CLEAR, loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: sharedSampler(this.device) },
            { binding: 1, resource: final.createView() },
          ],
        }),
      );
      pass.draw(3);
      pass.end();
    } else {
      const pass = env.encoder.beginRenderPass({
        colorAttachments: [{ view, clearValue: CLEAR, loadOp: 'clear', storeOp: 'store' }],
      });
      pass.end();
    }

    // Derived tint: encode the downsample+copy into the same submission.
    let tintEncoded = false;
    if (
      ContainerRenderer.tintWanted?.(frame.id) &&
      !this.tintPending &&
      performance.now() - (lastTintAt.get(frame.id) ?? 0) >= TINT_INTERVAL_MS
    ) {
      lastTintAt.set(frame.id, performance.now());
      if (final) {
        this.encodeTintSample(env.encoder, final);
        tintEncoded = true;
      } else {
        // Nothing wired to Output — the canvas shows the clear color.
        ContainerRenderer.tintSink?.(frame.id, CLEAR_RGB_INT);
      }
    }

    this.device.queue.submit([env.encoder.finish()]);
    if (tintEncoded) this.resolveTintSample(frame.id);
    this.pool.endFrame();
    this.states.prune(liveKeys);
    framesRendered++;
  }

  /** Downsample the final frame into a TINT_DS² grid and queue a buffer copy. */
  private encodeTintSample(encoder: GPUCommandEncoder, final: GPUTexture): void {
    this.tintTex ??= this.device.createTexture({
      size: { width: TINT_DS, height: TINT_DS },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.tintBuf ??= this.device.createBuffer({
      size: TINT_ROW_BYTES * TINT_DS,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    // The blit shader (over-background composite) at low resolution: linear
    // taps make each output texel a small average of the frame.
    const pipeline = fullscreenPipeline(this.device, 'blit', BLIT_FS, 'rgba8unorm');
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: this.tintTex.createView(), clearValue: CLEAR, loadOp: 'clear', storeOp: 'store' },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: sharedSampler(this.device) },
          { binding: 1, resource: final.createView() },
        ],
      }),
    );
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: this.tintTex },
      { buffer: this.tintBuf, bytesPerRow: TINT_ROW_BYTES },
      { width: TINT_DS, height: TINT_DS },
    );
  }

  /** Async map → average → sink. Never stalls the render path. */
  private resolveTintSample(id: string): void {
    const buf = this.tintBuf;
    if (!buf) return;
    this.tintPending = true;
    buf
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const data = new Uint8Array(buf.getMappedRange());
        let r = 0;
        let g = 0;
        let b = 0;
        for (let y = 0; y < TINT_DS; y++) {
          const row = y * TINT_ROW_BYTES;
          for (let x = 0; x < TINT_DS; x++) {
            const px = row + x * 4;
            r += data[px];
            g += data[px + 1];
            b += data[px + 2];
          }
        }
        buf.unmap();
        const n = TINT_DS * TINT_DS;
        const rgb =
          (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n);
        ContainerRenderer.tintSink?.(id, rgb);
      })
      .catch(() => {
        // Device loss / destroyed buffer — drop the sample.
      })
      .finally(() => {
        this.tintPending = false;
      });
  }

  /** Release GPU resources (stops webcam tracks via node-state disposal). */
  destroy(): void {
    this.states.destroy();
    this.pool.destroy();
    this.tintTex?.destroy();
    if (!this.tintPending) this.tintBuf?.destroy();
    this.tintTex = null;
    this.tintBuf = null;
  }
}
