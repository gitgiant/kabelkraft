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

export class ContainerRenderer {
  private pool: TexturePool;
  private states = new NodeStateStore();
  private readonly t0 = performance.now();
  private lastTime = 0;

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

  /** Draw one frame of the container's graph into the canvas. */
  render(graph: VisGraphData, features: VisFeatures | null): void {
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

    const env: RenderEnv = {
      device: this.device,
      encoder: this.device.createCommandEncoder(),
      pool: this.pool,
      states: this.states,
      width: this.canvas.width,
      height: this.canvas.height,
      features,
      time: now,
      dt,
    };

    // Evaluate the DAG.
    const textures = new Map<string, GPUTexture | null>();
    let final: GPUTexture | null = null;
    for (const node of topoOrder(graph)) {
      const def = VIS_NODE_DEFS.get(node.type);
      if (!def) continue;
      if (node.type === 'output') {
        const wire = graph.wires.find((w) => w.to.nodeId === node.id && w.to.portId === 'in');
        final = wire ? (textures.get(wire.from.nodeId) ?? null) : null;
        continue;
      }
      const impl = NODE_IMPLS[node.type];
      if (!impl) continue;
      const inputs = visualInPorts(def).map((port) => {
        const wire = graph.wires.find((w) => w.to.nodeId === node.id && w.to.portId === port.id);
        return wire ? (textures.get(wire.from.nodeId) ?? null) : null;
      });
      textures.set(node.id, impl.render(env, node, inputs, resolveParams(graph, node, features)));
    }

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

    this.device.queue.submit([env.encoder.finish()]);
    this.pool.endFrame();
    this.states.prune(new Set(graph.nodes.map((n) => n.id)));
    framesRendered++;
  }

  /** Release GPU resources (stops webcam tracks via node-state disposal). */
  destroy(): void {
    this.states.destroy();
    this.pool.destroy();
  }
}
