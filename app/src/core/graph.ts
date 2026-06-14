/**
 * Patch graph: modules + wires, with connection rules — PRD §4.3.
 *
 * Rules enforced here (UI-independent, unit-tested):
 *  - A wire connects one output to one input of the same type.
 *  - Fan-out: unlimited.
 *  - Fan-in: audio/note/trigger inputs accept multiple wires;
 *    control inputs accept ONE wire — connecting a new one detaches the old
 *    (returned so the UI can animate the detach).
 *  - No duplicate wires, no output-to-output / input-to-input, no self-port.
 */

import type { FaceSpec } from './face';
import type { ModuleDef, ModuleInstance, ModulePreset, PortSpec } from './module';
import type { PortType } from './types';

export interface PortRef {
  moduleId: string;
  portId: string;
}

/** A group's exposed boundary port (pole). Shape matches canvas BoundaryPort. */
export interface GroupPole {
  key: string; // `${moduleId}:${portId}` — moduleId is the group id for intrinsic poles
  moduleId: string;
  portId: string;
  direction: 'in' | 'out';
  type: PortType;
  label: string;
  /** True for poles owned by the group itself (no member port behind them). */
  intrinsic?: boolean;
}

/**
 * Ports owned by the group itself rather than forwarded from a member.
 * Wires may legally end on a group id + one of these port ids; the engine
 * never sees such wires (they are filtered out of the engine sync).
 */
export const INTRINSIC_GROUP_PORTS: PortSpec[] = [
  {
    id: 'tint',
    label: 'Tint',
    type: 'visual',
    direction: 'in',
    description: 'Wire a visualizer frame — accent colors inside this group take its derived color.',
  },
];

export interface Wire {
  id: string;
  from: PortRef; // always an output
  to: PortRef; // always an input
  type: PortType;
  label?: string;
  color?: number;
}

export type ConnectResult =
  | { ok: true; wire: Wire; detached?: Wire }
  | { ok: false; reason: string };

/**
 * Module group (PRD §6) — a pure organization layer over the flat graph.
 * The engine never sees groups: audio-path wires stay between concrete
 * modules, so grouping/collapsing never interrupts audio. The one exception
 * is intrinsic group poles (INTRINSIC_GROUP_PORTS) — UI-only wires may end
 * on a group id and are filtered out of the engine sync (isGroupWire).
 */
export interface ModuleGroup {
  id: string;
  name: string;
  color?: number;
  /** Collapsed tile position. */
  x: number;
  y: number;
  /** Plain-tile size override (world px); faced tiles size from face.width/height. */
  w?: number;
  h?: number;
  collapsed: boolean;
  moduleIds: string[];
  /** Nested child groups (PRD §6: layers of abstraction). */
  groupIds: string[];
  /** Designed front panel rendered on the collapsed tile (core/face.ts). */
  face?: FaceSpec;
  /**
   * Pole override (keys `moduleId:portId`). Group poles default to a baseline
   * (member ports with crossing wires ∪ unconnected member ports); `poleHidden`
   * removes baseline poles, `poleAdded` surfaces extra member ports as taps.
   * Final poles = baseline − poleHidden + poleAdded.
   */
  poleHidden?: string[];
  poleAdded?: string[];
  /** Saved configuration snapshots (PRESETS_PLAN.md); lazily created. */
  presets?: ModulePreset[];
  /** Last-loaded preset id; dirty = live state differs from this snapshot. */
  activePresetId?: string;
}

let nextGroupId = 1;

export function bumpGroupId(existing: string): void {
  const n = Number(existing.replace(/^g/, ''));
  if (Number.isFinite(n) && n >= nextGroupId) nextGroupId = n + 1;
}

let nextWireId = 1;

export function bumpWireId(existing: string): void {
  const n = Number(existing.replace(/^w/, ''));
  if (Number.isFinite(n) && n >= nextWireId) nextWireId = n + 1;
}

export class Graph {
  readonly modules = new Map<string, ModuleInstance>();
  readonly wires = new Map<string, Wire>();
  readonly groups = new Map<string, ModuleGroup>();

  constructor(private defs: Map<string, ModuleDef>) {}

  // -- groups ---------------------------------------------------------------

  createGroup(name: string, moduleIds: string[], groupIds: string[], x: number, y: number): ModuleGroup {
    const group: ModuleGroup = {
      id: `g${nextGroupId++}`,
      name,
      x,
      y,
      collapsed: true,
      moduleIds: [...moduleIds],
      groupIds: [...groupIds],
    };
    this.groups.set(group.id, group);
    return group;
  }

  /** Dissolve a group; members are reparented to the group's parent (if any).
   * Wires ending on the group's intrinsic poles die with it. */
  dissolveGroup(groupId: string): Wire[] {
    const group = this.groups.get(groupId);
    if (!group) return [];
    const parent = this.parentGroup(groupId);
    if (parent) {
      parent.moduleIds.push(...group.moduleIds);
      parent.groupIds.push(...group.groupIds.filter((g) => g !== groupId));
      parent.groupIds = parent.groupIds.filter((g) => g !== groupId);
    }
    this.groups.delete(groupId);
    const removed: Wire[] = [];
    for (const wire of this.wires.values()) {
      if (wire.from.moduleId === groupId || wire.to.moduleId === groupId) removed.push(wire);
    }
    for (const w of removed) this.wires.delete(w.id);
    return removed;
  }

  /** Direct parent group of a module, if any. */
  groupOfModule(moduleId: string): ModuleGroup | undefined {
    for (const g of this.groups.values()) {
      if (g.moduleIds.includes(moduleId)) return g;
    }
    return undefined;
  }

  parentGroup(groupId: string): ModuleGroup | undefined {
    for (const g of this.groups.values()) {
      if (g.groupIds.includes(groupId)) return g;
    }
    return undefined;
  }

  /** All module ids inside a group, including nested child groups. */
  modulesInGroup(groupId: string): Set<string> {
    const result = new Set<string>();
    const visit = (id: string) => {
      const g = this.groups.get(id);
      if (!g) return;
      for (const m of g.moduleIds) result.add(m);
      for (const child of g.groupIds) visit(child);
    };
    visit(groupId);
    return result;
  }

  /**
   * Topmost collapsed ancestor group hiding this module, or undefined if the
   * module is visible on the canvas.
   */
  hiddenBehind(moduleId: string): ModuleGroup | undefined {
    let result: ModuleGroup | undefined;
    let group = this.groupOfModule(moduleId);
    while (group) {
      if (group.collapsed) result = group;
      group = this.parentGroup(group.id);
    }
    return result;
  }

  /** Same resolution for a group: topmost collapsed ancestor (excluding itself). */
  groupHiddenBehind(groupId: string): ModuleGroup | undefined {
    let result: ModuleGroup | undefined;
    let group = this.parentGroup(groupId);
    while (group) {
      if (group.collapsed) result = group;
      group = this.parentGroup(group.id);
    }
    return result;
  }

  def(type: string): ModuleDef {
    const d = this.defs.get(type);
    if (!d) throw new Error(`Unknown module type: ${type}`);
    return d;
  }

  addModule(instance: ModuleInstance): void {
    this.def(instance.type); // validate type exists
    this.modules.set(instance.id, instance);
  }

  removeModule(moduleId: string): Wire[] {
    const removed: Wire[] = [];
    for (const wire of this.wires.values()) {
      if (wire.from.moduleId === moduleId || wire.to.moduleId === moduleId) {
        removed.push(wire);
      }
    }
    for (const w of removed) this.wires.delete(w.id);
    this.modules.delete(moduleId);
    for (const g of this.groups.values()) {
      g.moduleIds = g.moduleIds.filter((m) => m !== moduleId);
    }
    return removed;
  }

  /**
   * A group's poles. Baseline = member ports with a wire crossing the boundary
   * ∪ member ports with no wire at all (so detaching a wire never drops a pole —
   * bug fix). Then `poleAdded` surfaces extra member ports (e.g. an internally
   * driven output as a tap) and `poleHidden` removes baseline poles.
   * Final = baseline + added − hidden.
   */
  groupPoles(groupId: string): GroupPole[] {
    const group = this.groups.get(groupId);
    if (!group) return [];
    const members = this.modulesInGroup(groupId);
    const poles = new Map<string, GroupPole>();
    const add = (moduleId: string, portId: string, direction: 'in' | 'out', type: PortType, label: string) => {
      const key = `${moduleId}:${portId}`;
      if (!poles.has(key)) poles.set(key, { key, moduleId, portId, direction, type, label });
    };

    // One pass over wires: record which member ports are wired (internal or
    // crossing) and surface crossing-wire ports as baseline poles.
    const wired = new Set<string>();
    for (const wire of this.wires.values()) {
      const fromIn = members.has(wire.from.moduleId);
      const toIn = members.has(wire.to.moduleId);
      if (fromIn) wired.add(`${wire.from.moduleId}:${wire.from.portId}`);
      if (toIn) wired.add(`${wire.to.moduleId}:${wire.to.portId}`);
      if (fromIn === toIn) continue; // internal or fully-external wire
      const inner = fromIn ? wire.from : wire.to;
      const spec = this.port(inner);
      add(inner.moduleId, inner.portId, fromIn ? 'out' : 'in', wire.type, spec?.label ?? inner.portId);
    }

    // Unconnected member ports are baseline poles too.
    for (const moduleId of members) {
      const mod = this.modules.get(moduleId);
      if (!mod) continue;
      for (const p of this.def(mod.type).ports) {
        if (wired.has(`${moduleId}:${p.id}`)) continue;
        add(moduleId, p.id, p.direction, p.type, p.label ?? p.id);
      }
    }

    // Override: explicit adds (e.g. an internally-driven output as a tap).
    for (const key of group.poleAdded ?? []) {
      if (poles.has(key)) continue;
      const sep = key.indexOf(':');
      const moduleId = key.slice(0, sep);
      const portId = key.slice(sep + 1);
      if (!members.has(moduleId)) continue;
      const spec = this.port({ moduleId, portId });
      if (!spec) continue;
      add(moduleId, portId, spec.direction, spec.type, spec.label ?? portId);
    }

    // Intrinsic poles (owned by the group itself, e.g. tint).
    for (const p of INTRINSIC_GROUP_PORTS) {
      const key = `${groupId}:${p.id}`;
      poles.set(key, {
        key,
        moduleId: groupId,
        portId: p.id,
        direction: p.direction,
        type: p.type,
        label: p.label ?? p.id,
        intrinsic: true,
      });
    }

    // Hidden wins over everything (applied last).
    for (const key of group.poleHidden ?? []) poles.delete(key);

    return [...poles.values()];
  }

  /**
   * Pole picture for the Face Editor: current poles (with a `wired` flag — a
   * pole with an external wire can't be hidden) and the `addable` member ports
   * (hidden baseline poles + internally-driven outputs offered as taps). Inputs
   * driven internally are never offered (control single fan-in).
   */
  groupPoleEditInfo(groupId: string): {
    poles: Array<GroupPole & { wired: boolean }>;
    addable: Array<{ key: string; label: string; baseline: boolean }>;
  } {
    const group = this.groups.get(groupId);
    if (!group) return { poles: [], addable: [] };
    const members = this.modulesInGroup(groupId);
    const wiredAny = new Set<string>();
    const crossing = new Set<string>();
    const internalOut = new Map<string, string>(); // key → label
    for (const w of this.wires.values()) {
      const fromIn = members.has(w.from.moduleId);
      const toIn = members.has(w.to.moduleId);
      if (fromIn) wiredAny.add(`${w.from.moduleId}:${w.from.portId}`);
      if (toIn) wiredAny.add(`${w.to.moduleId}:${w.to.portId}`);
      if (fromIn === toIn) {
        if (fromIn) {
          const key = `${w.from.moduleId}:${w.from.portId}`;
          if (!internalOut.has(key)) internalOut.set(key, this.port(w.from)?.label ?? w.from.portId);
        }
        continue;
      }
      const inner = fromIn ? w.from : w.to;
      crossing.add(`${inner.moduleId}:${inner.portId}`);
    }
    // Wires ending on the group itself wire its intrinsic poles.
    for (const w of this.wires.values()) {
      if (w.to.moduleId === groupId) crossing.add(`${groupId}:${w.to.portId}`);
    }
    const baseline = new Set(crossing);
    for (const moduleId of members) {
      const mod = this.modules.get(moduleId);
      if (!mod) continue;
      for (const p of this.def(mod.type).ports) {
        if (!wiredAny.has(`${moduleId}:${p.id}`)) baseline.add(`${moduleId}:${p.id}`);
      }
    }
    const current = this.groupPoles(groupId);
    const currentKeys = new Set(current.map((p) => p.key));
    const poles = current.map((p) => ({ ...p, wired: crossing.has(p.key) }));
    const hidden = new Set(group.poleHidden ?? []);
    const addable: Array<{ key: string; label: string; baseline: boolean }> = [];
    for (const key of hidden) {
      if (currentKeys.has(key)) continue;
      const sep = key.indexOf(':');
      const moduleId = key.slice(0, sep);
      const portId = key.slice(sep + 1);
      if (moduleId === groupId) {
        const spec = INTRINSIC_GROUP_PORTS.find((p) => p.id === portId);
        if (spec) addable.push({ key, label: spec.label ?? portId, baseline: true });
        continue;
      }
      if (!members.has(moduleId)) continue;
      const spec = this.port({ moduleId, portId });
      if (!spec) continue;
      addable.push({ key, label: spec.label ?? portId, baseline: baseline.has(key) });
    }
    for (const [key, label] of internalOut) {
      if (currentKeys.has(key) || hidden.has(key)) continue;
      addable.push({ key, label, baseline: false });
    }
    return { poles, addable };
  }

  port(ref: PortRef): PortSpec | undefined {
    const mod = this.modules.get(ref.moduleId);
    if (mod) return this.def(mod.type).ports.find((p) => p.id === ref.portId);
    // Group endpoint: intrinsic ports (e.g. tint) make groups legal wire targets.
    if (this.groups.has(ref.moduleId)) {
      return INTRINSIC_GROUP_PORTS.find((p) => p.id === ref.portId);
    }
    return undefined;
  }

  /** True if a wire touches a group endpoint — such wires are UI-only and
   * must be filtered out of the engine sync. */
  isGroupWire(wire: Wire): boolean {
    return this.groups.has(wire.from.moduleId) || this.groups.has(wire.to.moduleId);
  }

  wiresInto(ref: PortRef): Wire[] {
    return [...this.wires.values()].filter(
      (w) => w.to.moduleId === ref.moduleId && w.to.portId === ref.portId,
    );
  }

  wiresOutOf(ref: PortRef): Wire[] {
    return [...this.wires.values()].filter(
      (w) => w.from.moduleId === ref.moduleId && w.from.portId === ref.portId,
    );
  }

  /** Validate without mutating — used for live highlight while wire-dragging. */
  canConnect(from: PortRef, to: PortRef): { ok: true } | { ok: false; reason: string } {
    const fromPort = this.port(from);
    const toPort = this.port(to);
    if (!fromPort || !toPort) return { ok: false, reason: 'Port not found' };
    if (fromPort.direction !== 'out') return { ok: false, reason: 'Source must be an output' };
    if (toPort.direction !== 'in') return { ok: false, reason: 'Target must be an input' };
    if (fromPort.type !== toPort.type) {
      return {
        ok: false,
        reason: `Type mismatch: ${fromPort.type} output cannot feed ${toPort.type} input`,
      };
    }
    if (from.moduleId === to.moduleId && from.portId === to.portId) {
      return { ok: false, reason: 'Cannot connect a port to itself' };
    }
    for (const w of this.wires.values()) {
      if (
        w.from.moduleId === from.moduleId &&
        w.from.portId === from.portId &&
        w.to.moduleId === to.moduleId &&
        w.to.portId === to.portId
      ) {
        return { ok: false, reason: 'Already connected' };
      }
    }
    return { ok: true };
  }

  connect(from: PortRef, to: PortRef): ConnectResult {
    const check = this.canConnect(from, to);
    if (!check.ok) return check;
    const type = this.port(from)!.type;

    // Control/visual fan-in: one wire only; last-connected wins (PRD §4.3).
    let detached: Wire | undefined;
    if (type === 'control' || type === 'visual') {
      const existing = this.wiresInto(to);
      if (existing.length > 0) {
        detached = existing[0];
        this.wires.delete(detached.id);
      }
    }

    const wire: Wire = { id: `w${nextWireId++}`, from, to, type };
    this.wires.set(wire.id, wire);
    return { ok: true, wire, detached };
  }

  disconnect(wireId: string): Wire | undefined {
    const wire = this.wires.get(wireId);
    if (wire) this.wires.delete(wireId);
    return wire;
  }
}
