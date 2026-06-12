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

/** Fresh visualizer content: audio input → Spectrum → Output. */
export function initVisGraph(): VisGraphData {
  return sourceGraph('spectrum', 1.5);
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
