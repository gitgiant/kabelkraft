/**
 * Auto-wire planner — greedy type matching between selected modules.
 *
 * Modules are chained left-to-right by canvas position; each adjacent pair
 * gets the source's unwired outputs matched to the target's unwired inputs
 * of the same type, in port-declaration order. If a pair yields nothing
 * left-to-right, the reverse direction is tried. Already-wired ports are
 * never touched, so auto-wire only ever adds wires.
 *
 * Pure planning: callers apply the pairs via graph.connect(), which keeps
 * validation, fan-in rules, and undo handling in one place.
 */

import type { Graph, PortRef } from './graph';
import type { ModuleInstance, PortSpec } from './module';
import type { PortType } from './types';

/** Audio first — the signal path matters more than modulation. */
const TYPE_PRIORITY: PortType[] = ['audio', 'note', 'trigger', 'control', 'transport', 'text', 'visual'];

export interface PlannedWire {
  from: PortRef;
  to: PortRef;
}

export function planAutoWire(graph: Graph, moduleIds: string[]): PlannedWire[] {
  const mods = moduleIds
    .map((id) => graph.modules.get(id))
    .filter((m): m is ModuleInstance => m !== undefined)
    .sort((a, b) => a.x - b.x || a.y - b.y);

  const plan: PlannedWire[] = [];
  const claimed = new Set<string>(); // `${moduleId}:${portId}` already used by the plan
  for (let i = 0; i < mods.length - 1; i++) {
    const pairs =
      pairUp(graph, mods[i], mods[i + 1], claimed) ??
      pairUp(graph, mods[i + 1], mods[i], claimed) ??
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
  mod: ModuleInstance,
  direction: 'in' | 'out',
  claimed: Set<string>,
): PortSpec[] {
  return graph.def(mod.type).ports.filter((p) => {
    if (p.direction !== direction || claimed.has(`${mod.id}:${p.id}`)) return false;
    const ref = { moduleId: mod.id, portId: p.id };
    const wired = direction === 'out' ? graph.wiresOutOf(ref) : graph.wiresInto(ref);
    return wired.length === 0;
  });
}

/** Match source outputs to target inputs per type; null when nothing fits. */
function pairUp(
  graph: Graph,
  source: ModuleInstance,
  target: ModuleInstance,
  claimed: Set<string>,
): PlannedWire[] | null {
  const outs = freePorts(graph, source, 'out', claimed);
  const ins = freePorts(graph, target, 'in', claimed);
  const pairs: PlannedWire[] = [];
  for (const type of TYPE_PRIORITY) {
    const typedOuts = outs.filter((p) => p.type === type);
    const typedIns = ins.filter((p) => p.type === type);
    for (let i = 0; i < Math.min(typedOuts.length, typedIns.length); i++) {
      pairs.push({
        from: { moduleId: source.id, portId: typedOuts[i].id },
        to: { moduleId: target.id, portId: typedIns[i].id },
      });
    }
  }
  return pairs.length > 0 ? pairs : null;
}
