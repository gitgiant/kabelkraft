/**
 * Pure graph operations for the visual engine — no GPU/DOM so unit tests and
 * core code can import them. The runtime builds on these.
 */

import { VIS_NODE_DEFS } from './registry';
import type { VisFeatures, VisGraphData, VisNodeInstance } from './types';

/** Kahn topological order; nodes caught in a cycle are omitted. */
export function topoOrder(graph: VisGraphData): VisNodeInstance[] {
  const indeg = new Map<string, number>(graph.nodes.map((n) => [n.id, 0]));
  for (const w of graph.wires) {
    if (indeg.has(w.to.nodeId) && indeg.has(w.from.nodeId)) {
      indeg.set(w.to.nodeId, (indeg.get(w.to.nodeId) ?? 0) + 1);
    }
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const queue = graph.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: VisNodeInstance[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(byId.get(id)!);
    for (const w of graph.wires) {
      if (w.from.nodeId !== id || !indeg.has(w.to.nodeId)) continue;
      const d = indeg.get(w.to.nodeId)! - 1;
      indeg.set(w.to.nodeId, d);
      if (d === 0) queue.push(w.to.nodeId);
    }
  }
  return order;
}

/** Features-node control output value for one port id. */
export function featureValue(features: VisFeatures | null, portId: string): number {
  if (!features) return 0;
  switch (portId) {
    case 'level':
      return Math.min(1, features.level * 2.2);
    case 'bass':
      return features.bands.bass;
    case 'mid':
      return features.bands.mid;
    case 'high':
      return features.bands.high;
    case 'onset':
      return features.onset;
    default:
      return 0;
  }
}

/**
 * Resolve a node's effective params: def defaults ← stored values ← control
 * in-port modulation (a wired control port whose id matches a param id
 * multiplies that param by the 0–1 control value).
 */
export function resolveParams(
  graph: VisGraphData,
  node: VisNodeInstance,
  features: VisFeatures | null,
): Record<string, number> {
  const def = VIS_NODE_DEFS.get(node.type);
  const out: Record<string, number> = {};
  if (!def) return out;
  for (const p of def.params) out[p.id] = node.params[p.id] ?? p.default;
  for (const port of def.ports) {
    if (port.type !== 'control' || port.direction !== 'in' || !(port.id in out)) continue;
    const wire = graph.wires.find((w) => w.to.nodeId === node.id && w.to.portId === port.id);
    if (!wire) continue;
    out[port.id] *= Math.min(1, Math.max(0, featureValue(features, wire.from.portId)));
  }
  return out;
}
