/**
 * Auto-wire planner — greedy type matching between modules and groups.
 *
 * Entities (modules and collapsed groups via their poles) are chained
 * left-to-right by canvas position; each adjacent pair gets the source's
 * unwired outputs matched to the target's unwired inputs of the same type,
 * in port-declaration order. If a pair yields nothing left-to-right, the
 * reverse direction is tried. Already-wired ports are never touched, so
 * auto-wire only ever adds wires.
 *
 * Pure planning: callers apply the pairs via graph.connect(), which keeps
 * validation, fan-in rules, and undo handling in one place.
 */

import type { Graph, PortRef } from './graph';
import type { PortType } from './types';

/** Audio first — the signal path matters more than modulation. */
const TYPE_PRIORITY: PortType[] = ['audio', 'note', 'trigger', 'control', 'transport', 'text', 'visual'];

export interface PlannedWire {
  from: PortRef;
  to: PortRef;
}

interface EntityPort {
  ref: PortRef;
  direction: 'in' | 'out';
  type: PortType;
}

/** A wireable thing on the canvas: a module, or a group seen through its poles. */
interface Entity {
  x: number;
  y: number;
  ports: EntityPort[];
}

function moduleEntity(graph: Graph, id: string): Entity | null {
  const mod = graph.modules.get(id);
  if (!mod) return null;
  return {
    x: mod.x,
    y: mod.y,
    ports: graph.def(mod.type).ports.map((p) => ({
      ref: { moduleId: id, portId: p.id },
      direction: p.direction,
      type: p.type,
    })),
  };
}

function groupEntity(graph: Graph, id: string): Entity | null {
  const group = graph.groups.get(id);
  if (!group) return null;
  return {
    x: group.x,
    y: group.y,
    // Intrinsic poles (tint) belong to the group id itself and follow their
    // own wiring rules — leave them to manual wiring.
    ports: graph
      .groupPoles(id)
      .filter((p) => !p.intrinsic)
      .map((p) => ({
        ref: { moduleId: p.moduleId, portId: p.portId },
        direction: p.direction,
        type: p.type,
      })),
  };
}

export function planAutoWire(graph: Graph, moduleIds: string[], groupIds: string[] = []): PlannedWire[] {
  const entities = [
    ...moduleIds.map((id) => moduleEntity(graph, id)),
    ...groupIds.map((id) => groupEntity(graph, id)),
  ]
    .filter((e): e is Entity => e !== null)
    .sort((a, b) => a.x - b.x || a.y - b.y);

  const plan: PlannedWire[] = [];
  const claimed = new Set<string>(); // `${moduleId}:${portId}` already used by the plan
  for (let i = 0; i < entities.length - 1; i++) {
    const pairs =
      pairUp(graph, entities[i], entities[i + 1], claimed) ??
      pairUp(graph, entities[i + 1], entities[i], claimed) ??
      [];
    for (const p of pairs) {
      claimed.add(`${p.from.moduleId}:${p.from.portId}`);
      claimed.add(`${p.to.moduleId}:${p.to.portId}`);
      plan.push(p);
    }
  }
  return plan;
}

/** Ports of one direction with no existing wire and no claim from the plan. */
function freePorts(
  graph: Graph,
  entity: Entity,
  direction: 'in' | 'out',
  claimed: Set<string>,
): EntityPort[] {
  return entity.ports.filter((p) => {
    if (p.direction !== direction || claimed.has(`${p.ref.moduleId}:${p.ref.portId}`)) return false;
    const wired = direction === 'out' ? graph.wiresOutOf(p.ref) : graph.wiresInto(p.ref);
    return wired.length === 0;
  });
}

/** Match source outputs to target inputs per type; null when nothing fits. */
function pairUp(
  graph: Graph,
  source: Entity,
  target: Entity,
  claimed: Set<string>,
): PlannedWire[] | null {
  const outs = freePorts(graph, source, 'out', claimed);
  const ins = freePorts(graph, target, 'in', claimed);
  const pairs: PlannedWire[] = [];
  for (const type of TYPE_PRIORITY) {
    const typedOuts = outs.filter((p) => p.type === type);
    const typedIns = ins.filter((p) => p.type === type);
    for (let i = 0; i < Math.min(typedOuts.length, typedIns.length); i++) {
      pairs.push({ from: typedOuts[i].ref, to: typedIns[i].ref });
    }
  }
  return pairs.length > 0 ? pairs : null;
}
