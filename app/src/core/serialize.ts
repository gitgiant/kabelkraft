/**
 * Project serialization — .kkproj JSON (PRD §15).
 * Same schema family the AI patch format (§10.1) builds on.
 */

import { Graph, bumpGroupId, bumpWireId, type ModuleGroup, type Wire } from './graph';
import { bumpModuleId, type ModuleDef, type ModuleInstance } from './module';
import type { SerializedSample } from './samples';
import { DEFAULT_TRANSPORT, type TransportState } from './types';

export const FORMAT_VERSION = 1;

export interface ProjectFile {
  formatVersion: number;
  name: string;
  transport: TransportState;
  modules: ModuleInstance[];
  wires: Wire[];
  groups?: ModuleGroup[];
  /** Embedded sample PCM — present only in explicit project saves, never in undo snapshots. */
  samples?: SerializedSample[];
  /** MIDI-learn mappings: "channel:cc" → target param. */
  midiMap?: Record<string, { moduleId: string; paramId: string }>;
}

export function serializeProject(
  name: string,
  graph: Graph,
  transport: TransportState,
  samples?: SerializedSample[],
  midiMap?: Record<string, { moduleId: string; paramId: string }>,
): string {
  const file: ProjectFile = {
    formatVersion: FORMAT_VERSION,
    name,
    transport: { ...transport, playing: false },
    modules: [...graph.modules.values()],
    wires: [...graph.wires.values()],
    groups: [...graph.groups.values()],
    samples,
    midiMap,
  };
  return JSON.stringify(file, null, 2);
}

export interface LoadResult {
  graph: Graph;
  name: string;
  transport: TransportState;
  warnings: string[];
  samples: SerializedSample[];
  midiMap: Record<string, { moduleId: string; paramId: string }>;
}

export function deserializeProject(json: string, defs: Map<string, ModuleDef>): LoadResult {
  const raw = JSON.parse(json) as ProjectFile;
  if (typeof raw.formatVersion !== 'number' || raw.formatVersion > FORMAT_VERSION) {
    throw new Error(`Unsupported project format version: ${raw.formatVersion}`);
  }
  const warnings: string[] = [];
  const graph = new Graph(defs);

  for (const mod of raw.modules ?? []) {
    if (!defs.has(mod.type)) {
      warnings.push(`Unknown module type "${mod.type}" skipped (id ${mod.id})`);
      continue;
    }
    // Fill params added since save; drop unknown ones silently.
    const def = defs.get(mod.type)!;
    const params: Record<string, number> = {};
    for (const p of def.params) params[p.id] = mod.params?.[p.id] ?? p.default;
    graph.addModule({ ...mod, params });
    bumpModuleId(mod.id);
  }

  for (const wire of raw.wires ?? []) {
    const result = graph.connect(wire.from, wire.to);
    if (!result.ok) {
      warnings.push(`Wire ${wire.id} dropped: ${result.reason}`);
      continue;
    }
    // Preserve saved identity and styling on the restored wire.
    graph.wires.delete(result.wire.id);
    result.wire.id = wire.id;
    result.wire.label = wire.label;
    result.wire.color = wire.color;
    graph.wires.set(wire.id, result.wire);
    bumpWireId(wire.id);
  }

  for (const group of raw.groups ?? []) {
    const moduleIds = group.moduleIds.filter((id) => graph.modules.has(id));
    graph.groups.set(group.id, { ...group, moduleIds });
    bumpGroupId(group.id);
  }
  // Drop dangling child-group references (e.g. a skipped group).
  for (const group of graph.groups.values()) {
    group.groupIds = group.groupIds.filter((id) => graph.groups.has(id));
  }

  const midiMap: Record<string, { moduleId: string; paramId: string }> = {};
  for (const [key, target] of Object.entries(raw.midiMap ?? {})) {
    if (graph.modules.has(target.moduleId)) midiMap[key] = target;
  }

  return {
    graph,
    name: raw.name ?? 'Untitled',
    transport: { ...DEFAULT_TRANSPORT, ...raw.transport, playing: false },
    warnings,
    samples: (raw.samples ?? []).filter((s) => graph.modules.has(s.moduleId)),
    midiMap,
  };
}
