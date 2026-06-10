/**
 * Module faces (PRD §6 "macro controls", realized as a design framework):
 * a group can carry a designed front panel — placed elements bound to inner
 * module params — rendered on its collapsed tile instead of the plain tile.
 *
 * Faces live on ModuleGroup.face, so they ride the existing serializer and
 * undo snapshots. Image pixels do NOT: elements reference assetIds resolved
 * against an asset store kept outside the graph (same pattern as samples),
 * embedded only in explicit saves.
 */

import type { Graph, ModuleGroup, Wire } from './graph';
import { createInstance, type ModuleDef, type ModuleInstance } from './module';

export type FaceElementKind =
  | 'knob'
  | 'slider'
  | 'xy'
  | 'button'
  | 'label'
  | 'image'
  | 'meter'
  | 'readout';

export interface FaceElement {
  id: string;
  kind: FaceElementKind;
  /** Position/size in face-local px (origin under the title bar). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Caption drawn under controls / used as meter+readout title. */
  label?: string;
  /** Binding target inside the group (param controls, meter, readout). */
  moduleId?: string;
  paramId?: string;
  /** XY pad: Y-axis target (moduleId/paramId is the X axis). */
  moduleId2?: string;
  paramId2?: string;
  /** Label elements. */
  text?: string;
  size?: number;
  color?: number;
  /** Image elements: key into the face asset store. */
  assetId?: string;
}

export interface FaceSpec {
  width: number;
  height: number;
  bgColor?: number;
  /** Background image asset; drawn behind elements, stretched to fit. */
  bgAssetId?: string;
  grid: number;
  snap: boolean;
  elements: FaceElement[];
}

export function defaultFace(): FaceSpec {
  return { width: 320, height: 220, grid: 10, snap: true, elements: [] };
}

const ELEMENT_DEFAULTS: Record<FaceElementKind, { w: number; h: number }> = {
  knob: { w: 70, h: 86 },
  slider: { w: 36, h: 120 },
  xy: { w: 120, h: 120 },
  button: { w: 70, h: 44 },
  label: { w: 120, h: 20 },
  image: { w: 100, h: 100 },
  meter: { w: 90, h: 16 },
  readout: { w: 90, h: 22 },
};

export function newFaceElement(face: FaceSpec, kind: FaceElementKind, x: number, y: number): FaceElement {
  let n = 1;
  while (face.elements.some((e) => e.id === `e${n}`)) n++;
  const d = ELEMENT_DEFAULTS[kind];
  return {
    id: `e${n}`,
    kind,
    x: Math.round(x),
    y: Math.round(y),
    w: d.w,
    h: d.h,
    ...(kind === 'label' ? { text: 'Label', size: 13 } : {}),
  };
}

export function snapTo(v: number, grid: number, snap: boolean): number {
  return snap && grid > 0 ? Math.round(v / grid) * grid : Math.round(v);
}

export interface BindTarget {
  moduleId: string;
  paramId: string;
  label: string;
}

/** Every bindable param inside the group, nested groups included. */
export function bindableParams(graph: Graph, groupId: string): BindTarget[] {
  const out: BindTarget[] = [];
  for (const moduleId of graph.modulesInGroup(groupId)) {
    const mod = graph.modules.get(moduleId);
    if (!mod) continue;
    const def = graph.def(mod.type);
    const name = mod.label ?? def.name;
    for (const p of def.params) {
      out.push({ moduleId, paramId: p.id, label: `${name} · ${p.label}` });
    }
  }
  return out;
}

/** Inner modules with an audio output — meter targets. */
export function meterTargets(graph: Graph, groupId: string): Array<{ moduleId: string; label: string }> {
  const out: Array<{ moduleId: string; label: string }> = [];
  for (const moduleId of graph.modulesInGroup(groupId)) {
    const mod = graph.modules.get(moduleId);
    if (!mod) continue;
    const def = graph.def(mod.type);
    if (!def.ports.some((p) => p.type === 'audio' && p.direction === 'out') && def.type !== 'audioOut') continue;
    out.push({ moduleId, label: mod.label ?? def.name });
  }
  return out;
}

/** Drop bindings whose target module/param no longer exists in the group. */
export function pruneFaceBindings(graph: Graph, groupId: string, face: FaceSpec): void {
  const members = graph.modulesInGroup(groupId);
  const valid = (moduleId?: string, paramId?: string): boolean => {
    if (!moduleId || !members.has(moduleId)) return false;
    if (paramId === undefined) return true;
    const mod = graph.modules.get(moduleId);
    return !!mod && graph.def(mod.type).params.some((p) => p.id === paramId);
  };
  for (const el of face.elements) {
    if (el.kind === 'label' || el.kind === 'image') continue;
    if (el.kind === 'meter') {
      if (!valid(el.moduleId)) el.moduleId = undefined;
      continue;
    }
    if (!valid(el.moduleId, el.paramId)) {
      el.moduleId = undefined;
      el.paramId = undefined;
    }
    if (el.kind === 'xy' && !valid(el.moduleId2, el.paramId2)) {
      el.moduleId2 = undefined;
      el.paramId2 = undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// .kkmod — a faced group exported as a reusable custom module (PRD §15)
// ---------------------------------------------------------------------------

export const KKMOD_VERSION = 1;

export interface KkmodFile {
  formatVersion: number;
  kind: 'kkmod';
  name: string;
  modules: ModuleInstance[];
  wires: Array<{ from: Wire['from']; to: Wire['to'] }>;
  groups: ModuleGroup[];
  rootGroupId: string;
  /** assetId → data URL for face backgrounds/images. */
  faceAssets?: Record<string, string>;
}

/** Group ids of the subtree rooted at groupId (root first). */
function groupSubtree(graph: Graph, groupId: string): ModuleGroup[] {
  const out: ModuleGroup[] = [];
  const visit = (id: string) => {
    const g = graph.groups.get(id);
    if (!g) return;
    out.push(g);
    for (const child of g.groupIds) visit(child);
  };
  visit(groupId);
  return out;
}

export function exportKkmod(graph: Graph, groupId: string, assets: Map<string, string>): string {
  const root = graph.groups.get(groupId);
  if (!root) throw new Error(`Unknown group: ${groupId}`);
  const groups = groupSubtree(graph, groupId);
  const members = graph.modulesInGroup(groupId);
  const modules = [...members]
    .map((id) => graph.modules.get(id))
    .filter((m): m is ModuleInstance => !!m);
  const wires = [...graph.wires.values()]
    .filter((w) => members.has(w.from.moduleId) && members.has(w.to.moduleId))
    .map((w) => ({ from: w.from, to: w.to }));

  const faceAssets: Record<string, string> = {};
  for (const g of groups) {
    for (const id of [g.face?.bgAssetId, ...(g.face?.elements.map((e) => e.assetId) ?? [])]) {
      if (id && assets.has(id)) faceAssets[id] = assets.get(id)!;
    }
  }

  const file: KkmodFile = {
    formatVersion: KKMOD_VERSION,
    kind: 'kkmod',
    name: root.name,
    modules,
    wires,
    groups,
    rootGroupId: groupId,
    faceAssets: Object.keys(faceAssets).length ? faceAssets : undefined,
  };
  return JSON.stringify(file, null, 2);
}

export interface KkmodImport {
  name: string;
  modules: ModuleInstance[];
  wires: Array<{ from: Wire['from']; to: Wire['to'] }>;
  /** Root last is NOT guaranteed; rootGroupId identifies it. Fresh ids throughout. */
  groups: ModuleGroup[];
  rootGroupId: string;
  /** Original assetId → data URL; caller re-keys into its asset store. */
  assets: Record<string, string>;
  warnings: string[];
}

/**
 * Parse a .kkmod and remap every module/group id to fresh ones so the result
 * can be inserted into any graph. Unknown module types are dropped (warned),
 * as are wires touching them.
 */
export function importKkmod(json: string, defs: Map<string, ModuleDef>): KkmodImport {
  const raw = JSON.parse(json) as KkmodFile;
  if (raw.kind !== 'kkmod') throw new Error('Not a .kkmod file');
  if (typeof raw.formatVersion !== 'number' || raw.formatVersion > KKMOD_VERSION) {
    throw new Error(`Unsupported .kkmod version: ${raw.formatVersion}`);
  }
  if (!raw.groups?.some((g) => g.id === raw.rootGroupId)) {
    throw new Error('Missing root group');
  }
  const warnings: string[] = [];

  const moduleIdMap = new Map<string, string>();
  const modules: ModuleInstance[] = [];
  for (const m of raw.modules ?? []) {
    const def = defs.get(m.type);
    if (!def) {
      warnings.push(`Unknown module type "${m.type}" skipped`);
      continue;
    }
    const inst = createInstance(def, m.x, m.y);
    inst.params = { ...inst.params };
    for (const p of def.params) {
      if (m.params?.[p.id] !== undefined) inst.params[p.id] = m.params[p.id];
    }
    if (m.data) inst.data = m.data;
    if (m.label) inst.label = m.label;
    if (m.color !== undefined) inst.color = m.color;
    moduleIdMap.set(m.id, inst.id);
    modules.push(inst);
  }

  const wires = (raw.wires ?? [])
    .filter((w) => {
      if (moduleIdMap.has(w.from.moduleId) && moduleIdMap.has(w.to.moduleId)) return true;
      warnings.push(`Wire ${w.from.moduleId}.${w.from.portId} → ${w.to.moduleId}.${w.to.portId} dropped`);
      return false;
    })
    .map((w) => ({
      from: { moduleId: moduleIdMap.get(w.from.moduleId)!, portId: w.from.portId },
      to: { moduleId: moduleIdMap.get(w.to.moduleId)!, portId: w.to.portId },
    }));

  // Fresh group ids: g-import-N placeholders re-keyed by the caller via
  // graph.createGroup would lose face/groupIds wiring, so remap here and let
  // the caller install them directly.
  const groupIdMap = new Map<string, string>();
  raw.groups.forEach((g, i) => groupIdMap.set(g.id, `gi${Date.now().toString(36)}${i}`));
  const groups: ModuleGroup[] = raw.groups.map((g) => ({
    ...g,
    id: groupIdMap.get(g.id)!,
    moduleIds: g.moduleIds.map((id) => moduleIdMap.get(id)!).filter(Boolean),
    groupIds: g.groupIds.map((id) => groupIdMap.get(id)!).filter(Boolean),
    collapsed: true,
    face: g.face
      ? {
          ...g.face,
          elements: g.face.elements.map((el) => ({
            ...el,
            moduleId: el.moduleId ? moduleIdMap.get(el.moduleId) : undefined,
            moduleId2: el.moduleId2 ? moduleIdMap.get(el.moduleId2) : undefined,
          })),
        }
      : undefined,
  }));

  return {
    name: raw.name ?? 'Module',
    modules,
    wires,
    groups,
    rootGroupId: groupIdMap.get(raw.rootGroupId)!,
    assets: raw.faceAssets ?? {},
    warnings,
  };
}
