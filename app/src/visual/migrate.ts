/**
 * Visual graph synthesis + legacy migration — VISUALIZER_ENGINE_PLAN.md.
 * Pure data, no GPU/DOM: serialize.ts and core/registry.ts import this.
 *
 * Pre-engine visualizer modules carried `scene` (0 scope / 1 spectrum /
 * 2 particles) and `gain` params; both retire into an equivalent node graph
 * stored as `data.graph`.
 */

import { VIS_NODE_DEFS } from './registry';
import type { VisGraphData, VisNodeInstance } from './types';

/** Legacy scene order — index = old `scene` param value. */
export const LEGACY_SCENES = ['scope', 'spectrum', 'particles'] as const;
export type LegacyScene = (typeof LEGACY_SCENES)[number];

function sourceGraph(sourceType: LegacyScene, gain: number): VisGraphData {
  return {
    nodes: [
      { id: 'v1', type: sourceType, x: 40, y: 60, params: { gain } },
      { id: 'v2', type: 'output', x: 320, y: 60, params: {} },
    ],
    wires: [{ id: 'vw1', from: { nodeId: 'v1', portId: 'out' }, to: { nodeId: 'v2', portId: 'in' } }],
  };
}

/**
 * Fresh visualizer content: a four-scene showcase rotating through every
 * effect via the Scenes switcher, with Features wires demoing param
 * modulation (multiply on bloom/warp, add-wrap on colorgrade hue).
 */
export function initVisGraph(): VisGraphData {
  const n = (id: string, type: string, x: number, y: number, params: Record<string, number> = {}): VisNodeInstance =>
    ({ id, type, x, y, params });
  const w = (id: string, from: [string, string], to: [string, string]) =>
    ({ id, from: { nodeId: from[0], portId: from[1] }, to: { nodeId: to[0], portId: to[1] } });
  return {
    nodes: [
      n('feat', 'features', 40, 20),
      // Scene A — pulse grid: gradient + shapes, bloom riding the bass.
      n('bg', 'gradient', 40, 150, { mode: 3, hue: 0.7, hue2: 0.85, lum: 0.15, drift: 0.05 }),
      n('shp', 'shapes', 40, 280, { shape: 3, count: 5, size: 0.5, spin: 0.3, pulse: 0.8, hue: 0.55 }),
      n('mixa', 'blend', 230, 215, { mode: 2 }),
      n('glow', 'bloom', 420, 215, { threshold: 0.4, amount: 1.2 }),
      n('mir', 'mirror', 610, 215, { mode: 0 }),
      // Scene B — note tunnel: particles through feedback, kaleido-folded.
      n('parts', 'particles', 40, 410, { rate: 0.7, size: 1.3 }),
      n('trail', 'feedback', 230, 410, { zoom: 0.3, spin: 0.15, fade: 0.93 }),
      n('kal', 'kaleido', 420, 410, { segments: 6, spin: 0.1 }),
      // Scene C — liquid scope: chroma fringe + warp driven by the mids.
      n('scp', 'scope', 40, 540, { gain: 2, glow: 0.6 }),
      n('chr', 'chromashift', 230, 540, { amount: 0.35 }),
      n('wrp', 'warp', 420, 540, { amount: 0.35, freq: 8, speed: 1 }),
      n('blr', 'blur', 610, 540, { amount: 0.15 }),
      // Scene D — mosaic bars: pixelated spectrum, hue cycling with level.
      n('spc', 'spectrum', 40, 670, { gain: 2 }),
      n('pix', 'pixelate', 230, 670, { amount: 0.25 }),
      n('cg', 'colorgrade', 420, 670, { sat: 1.2 }),
      n('show', 'scenes', 800, 410),
      n('out', 'output', 990, 410),
    ],
    wires: [
      w('vw1', ['bg', 'out'], ['mixa', 'a']),
      w('vw2', ['shp', 'out'], ['mixa', 'b']),
      w('vw3', ['mixa', 'out'], ['glow', 'in']),
      w('vw4', ['glow', 'out'], ['mir', 'in']),
      w('vw5', ['mir', 'out'], ['show', 'a']),
      w('vw6', ['parts', 'out'], ['trail', 'in']),
      w('vw7', ['trail', 'out'], ['kal', 'in']),
      w('vw8', ['kal', 'out'], ['show', 'b']),
      w('vw9', ['scp', 'out'], ['chr', 'in']),
      w('vw10', ['chr', 'out'], ['wrp', 'in']),
      w('vw11', ['wrp', 'out'], ['blr', 'in']),
      w('vw12', ['blr', 'out'], ['show', 'c']),
      w('vw13', ['spc', 'out'], ['pix', 'in']),
      w('vw14', ['pix', 'out'], ['cg', 'in']),
      w('vw15', ['cg', 'out'], ['show', 'd']),
      w('vw16', ['show', 'out'], ['out', 'in']),
      w('vw17', ['feat', 'bass'], ['glow', 'amount']),
      w('vw18', ['feat', 'mid'], ['wrp', 'amount']),
      w('vw19', ['feat', 'level'], ['cg', 'hueShift']),
    ],
  };
}

/** Old scene/gain params → equivalent graph (clamped, NaN-safe). */
export function sceneToGraph(scene: unknown, gain: unknown): VisGraphData {
  const sceneIdx = Math.min(LEGACY_SCENES.length - 1, Math.max(0, Math.round(Number(scene) || 0)));
  const g = Number(gain);
  return sourceGraph(LEGACY_SCENES[sceneIdx], Number.isFinite(g) ? Math.min(4, Math.max(0.5, g)) : 1.5);
}

/** True when the payload looks like a usable visual graph. */
export function isVisGraph(value: unknown): value is VisGraphData {
  const g = value as VisGraphData | null;
  return !!g && Array.isArray(g.nodes) && Array.isArray(g.wires);
}

/** Read a module's visual graph, tolerating missing/foreign data. */
export function visGraphOf(data: Record<string, unknown> | undefined): VisGraphData | null {
  return data && isVisGraph(data.graph) ? data.graph : null;
}

/**
 * Best-effort builtin look for a graph — drives the Canvas2D approximation
 * tier (tile face, no-WebGPU overlay). Effects are ignored; every recognized
 * source type contributes one layer (first instance of each type wins),
 * spectrum when none found.
 */
export function approximateScenes(graph: VisGraphData | null): { scene: LegacyScene; gain: number }[] {
  const layers: { scene: LegacyScene; gain: number }[] = [];
  for (const node of graph?.nodes ?? []) {
    if (
      (LEGACY_SCENES as readonly string[]).includes(node.type) &&
      !layers.some((l) => l.scene === node.type)
    ) {
      layers.push({ scene: node.type as LegacyScene, gain: node.params.gain ?? 1.5 });
    }
  }
  return layers.length > 0 ? layers : [{ scene: 'spectrum', gain: 1.5 }];
}

/** Single-scene variant for the thrifty tile fallback. */
export function approximateScene(graph: VisGraphData | null): { scene: LegacyScene; gain: number } {
  return approximateScenes(graph)[0];
}

/**
 * Drop nodes of unknown type and wires whose ends don't resolve — keeps a
 * loaded project usable when a graph was saved by a newer version.
 */
export function sanitizeVisGraph(graph: VisGraphData): { graph: VisGraphData; dropped: number } {
  const nodes: VisNodeInstance[] = graph.nodes.filter((n) => VIS_NODE_DEFS.has(n.type));
  const ids = new Set(nodes.map((n) => n.id));
  const wires = graph.wires.filter((w) => ids.has(w.from.nodeId) && ids.has(w.to.nodeId));
  return {
    graph: { nodes, wires },
    dropped: graph.nodes.length - nodes.length + (graph.wires.length - wires.length),
  };
}
