/**
 * Module / container presets — PRESETS_PLAN.md.
 *
 * A preset is a saved configuration snapshot. Plain modules store their own
 * `params`/`data`; containers store every member's params/data plus the
 * internal wires. This module owns the pure, graph-independent transforms;
 * capture/apply/dirty live alongside AppState (Phase 2).
 */

import type { Graph } from './graph';
import type { ModulePreset, PresetWire } from './module';

export const DEFAULT_PRESET_CATEGORY = 'Default';
export const DEFAULT_PRESET_NAME = 'Default';
export const AI_PRESET_LABEL = '✨ AI Generated';

/** A preset target: a plain module or a container (group). */
export interface PresetTarget {
  id: string;
  isGroup: boolean;
}

/** Fresh preset id, unique within one host's array (random suffix). */
export function newPresetId(): string {
  return `pr${Math.random().toString(36).slice(2, 9)}`;
}

// -- pure deep compare ------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
}

/** Wire lists equal as unordered sets of endpoints. */
function sameWires(a: PresetWire[] = [], b: PresetWire[] = []): boolean {
  if (a.length !== b.length) return false;
  const key = (w: PresetWire) =>
    `${w.from.moduleId}:${w.from.portId}->${w.to.moduleId}:${w.to.portId}`;
  const set = new Set(a.map(key));
  return b.every((w) => set.has(key(w)));
}

// -- capture / apply / dirty ------------------------------------------------

const cloneData = (d: Record<string, unknown> | undefined): Record<string, unknown> | undefined =>
  d ? (structuredClone(d) as Record<string, unknown>) : undefined;

/**
 * Snapshot live state into a preset payload. Plain module → its own
 * params/data; container → every (flattened) member's params/data plus the
 * internal wires (both endpoints among the members).
 */
export function captureLivePreset(
  graph: Graph,
  target: PresetTarget,
): Pick<ModulePreset, 'params' | 'data' | 'members' | 'wires'> {
  if (!target.isGroup) {
    const mod = graph.modules.get(target.id);
    if (!mod) return {};
    const data = cloneData(mod.data);
    return { params: { ...mod.params }, ...(data ? { data } : {}) };
  }

  const members = graph.modulesInGroup(target.id);
  const memberObj: NonNullable<ModulePreset['members']> = {};
  for (const mid of members) {
    const m = graph.modules.get(mid);
    if (!m) continue;
    const data = cloneData(m.data);
    memberObj[mid] = { params: { ...m.params }, ...(data ? { data } : {}) };
  }
  const wires: PresetWire[] = [];
  for (const w of graph.wires.values()) {
    if (members.has(w.from.moduleId) && members.has(w.to.moduleId)) {
      wires.push({ from: { ...w.from }, to: { ...w.to } });
    }
  }
  return { members: memberObj, wires };
}

/**
 * Write a preset into live graph state. Params overlay (so a param added to the
 * def since the preset was saved keeps its current value). For a container the
 * internal wires are fully replaced: every wholly-internal wire is dropped and
 * the preset's list recreated through `graph.connect` (so control single-fan-in
 * still holds). Crossing/external wires are left untouched.
 */
export function applyPreset(graph: Graph, target: PresetTarget, preset: ModulePreset): void {
  if (!target.isGroup) {
    const mod = graph.modules.get(target.id);
    if (!mod) return;
    if (preset.params) mod.params = { ...mod.params, ...preset.params };
    if (preset.data) mod.data = cloneData(preset.data);
    return;
  }

  const members = graph.modulesInGroup(target.id);
  for (const [mid, entry] of Object.entries(preset.members ?? {})) {
    if (!members.has(mid)) continue;
    const m = graph.modules.get(mid);
    if (!m) continue;
    m.params = { ...m.params, ...entry.params };
    if (entry.data) m.data = cloneData(entry.data);
  }
  // Replace internal wiring.
  for (const w of [...graph.wires.values()]) {
    if (members.has(w.from.moduleId) && members.has(w.to.moduleId)) graph.disconnect(w.id);
  }
  for (const pw of preset.wires ?? []) {
    if (!members.has(pw.from.moduleId) || !members.has(pw.to.moduleId)) continue;
    graph.connect(pw.from, pw.to);
  }
}

/** True when live state still matches the preset snapshot (i.e. NOT dirty). */
export function liveMatchesPreset(graph: Graph, target: PresetTarget, preset: ModulePreset): boolean {
  const live = captureLivePreset(graph, target);
  if (!target.isGroup) {
    return deepEqual(live.params ?? {}, preset.params ?? {}) && deepEqual(live.data, preset.data);
  }
  if (!sameWires(live.wires, preset.wires)) return false;
  const liveMembers = live.members ?? {};
  const presetMembers = preset.members ?? {};
  const keys = new Set([...Object.keys(liveMembers), ...Object.keys(presetMembers)]);
  for (const k of keys) {
    const a = liveMembers[k];
    const b = presetMembers[k];
    if (!a || !b) return false;
    if (!deepEqual(a.params, b.params) || !deepEqual(a.data, b.data)) return false;
  }
  return true;
}

/**
 * Randomize live params in place, honoring each param's `randomizable` flag
 * (PRD §7). Discrete (option) params pick a random index; continuous params a
 * uniform value in [min, max]. Module → itself; container → all members.
 */
export function randomizeLive(graph: Graph, target: PresetTarget): void {
  const ids = target.isGroup ? [...graph.modulesInGroup(target.id)] : [target.id];
  for (const mid of ids) {
    const m = graph.modules.get(mid);
    if (!m) continue;
    for (const p of graph.def(m.type).params) {
      if (!p.randomizable) continue;
      m.params[p.id] = p.options
        ? Math.floor(Math.random() * p.options.length)
        : p.min + Math.random() * (p.max - p.min);
    }
  }
}

/**
 * Rewrite the module ids inside a preset through `moduleIdMap` (a .kkmod import
 * remaps every module to a fresh id). Member entries whose id is not in the map
 * are dropped; wires touching an unmapped endpoint are dropped. Group ids never
 * appear inside a preset, so only module ids are remapped.
 */
export function remapPreset(preset: ModulePreset, moduleIdMap: Map<string, string>): ModulePreset {
  const out: ModulePreset = {
    id: preset.id,
    name: preset.name,
    category: preset.category,
  };
  if (preset.params) out.params = { ...preset.params };
  if (preset.data) out.data = preset.data;

  if (preset.members) {
    const members: NonNullable<ModulePreset['members']> = {};
    for (const [oldId, entry] of Object.entries(preset.members)) {
      const newId = moduleIdMap.get(oldId);
      if (!newId) continue;
      members[newId] = {
        params: { ...entry.params },
        ...(entry.data ? { data: entry.data } : {}),
      };
    }
    out.members = members;
  }

  if (preset.wires) {
    const wires: PresetWire[] = [];
    for (const w of preset.wires) {
      const from = moduleIdMap.get(w.from.moduleId);
      const to = moduleIdMap.get(w.to.moduleId);
      if (!from || !to) continue;
      wires.push({
        from: { moduleId: from, portId: w.from.portId },
        to: { moduleId: to, portId: w.to.portId },
      });
    }
    out.wires = wires;
  }

  return out;
}
