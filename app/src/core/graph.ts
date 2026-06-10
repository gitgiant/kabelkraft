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

import type { ModuleDef, ModuleInstance, PortSpec } from './module';
import type { PortType } from './types';

export interface PortRef {
  moduleId: string;
  portId: string;
}

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
 * The engine never sees groups; wires stay between concrete modules, so
 * grouping/collapsing never interrupts audio.
 */
export interface ModuleGroup {
  id: string;
  name: string;
  color?: number;
  /** Collapsed tile position. */
  x: number;
  y: number;
  collapsed: boolean;
  moduleIds: string[];
  /** Nested child groups (PRD §6: layers of abstraction). */
  groupIds: string[];
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

  /** Dissolve a group; members are reparented to the group's parent (if any). */
  dissolveGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    const parent = this.parentGroup(groupId);
    if (parent) {
      parent.moduleIds.push(...group.moduleIds);
      parent.groupIds.push(...group.groupIds.filter((g) => g !== groupId));
      parent.groupIds = parent.groupIds.filter((g) => g !== groupId);
    }
    this.groups.delete(groupId);
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

  port(ref: PortRef): PortSpec | undefined {
    const mod = this.modules.get(ref.moduleId);
    if (!mod) return undefined;
    return this.def(mod.type).ports.find((p) => p.id === ref.portId);
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

    // Control fan-in: one wire only; last-connected wins (PRD §4.3).
    let detached: Wire | undefined;
    if (type === 'control') {
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
