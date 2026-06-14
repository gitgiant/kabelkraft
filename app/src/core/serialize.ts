/**
 * Project serialization — .kkproj JSON (PRD §15).
 * Same schema family the AI patch format (§10.1) builds on.
 */

import { clipFromData } from './composer';
import { Graph, bumpGroupId, bumpWireId, type ModuleGroup, type Wire } from './graph';
import { bumpModuleId, type ModuleDef, type ModuleInstance } from './module';
import { isVisGraph, sanitizeVisGraph, sceneToGraph } from '../visual/migrate';
import type { VisGraphData } from '../visual/types';
import type { SerializedSample } from './samples';
import { DEFAULT_TRANSPORT, type TransportState } from './types';

export const FORMAT_VERSION = 2;

/** Descriptive project metadata — display only, nothing reads it for behavior. */
export interface ProjectMeta {
  artists?: string;
  description?: string;
  /** Cover image data URL, downscaled on input (≤512px). */
  picture?: string;
}

export interface ProjectFile {
  formatVersion: number;
  name: string;
  /** Present only in explicit saves, like samples/faceAssets. */
  meta?: ProjectMeta;
  transport: TransportState;
  modules: ModuleInstance[];
  wires: Wire[];
  groups?: ModuleGroup[];
  /** Embedded sample PCM — present only in explicit project saves, never in undo snapshots. */
  samples?: SerializedSample[];
  /** MIDI-learn mappings: "channel:cc" → target param. */
  midiMap?: Record<string, { moduleId: string; paramId: string }>;
  /** Face image assets (assetId → data URL) — explicit saves only, like samples. */
  faceAssets?: Record<string, string>;
}

export function serializeProject(
  name: string,
  graph: Graph,
  transport: TransportState,
  samples?: SerializedSample[],
  midiMap?: Record<string, { moduleId: string; paramId: string }>,
  faceAssets?: Record<string, string>,
  meta?: ProjectMeta,
): string {
  const file: ProjectFile = {
    formatVersion: FORMAT_VERSION,
    name,
    meta,
    transport: { ...transport, playing: false },
    modules: [...graph.modules.values()],
    wires: [...graph.wires.values()],
    groups: [...graph.groups.values()],
    samples,
    midiMap,
    faceAssets,
  };
  return JSON.stringify(file, null, 2);
}

export interface LoadResult {
  graph: Graph;
  name: string;
  meta: ProjectMeta;
  transport: TransportState;
  warnings: string[];
  samples: SerializedSample[];
  midiMap: Record<string, { moduleId: string; paramId: string }>;
  faceAssets: Record<string, string>;
}

export function deserializeProject(json: string, defs: Map<string, ModuleDef>): LoadResult {
  const raw = JSON.parse(json) as ProjectFile;
  if (typeof raw.formatVersion !== 'number' || raw.formatVersion > FORMAT_VERSION) {
    throw new Error(`Unsupported project format version: ${raw.formatVersion}`);
  }
  const warnings: string[] = [];
  const graph = new Graph(defs);

  for (const mod of raw.modules ?? []) {
    // Legacy 'adsr' modules became the richer 'envelope' (same ports + params).
    if (mod.type === 'adsr') mod.type = 'envelope';
    if (!defs.has(mod.type)) {
      warnings.push(`Unknown module type "${mod.type}" skipped (id ${mod.id})`);
      continue;
    }
    // Fill params added since save; drop unknown ones silently.
    const def = defs.get(mod.type)!;
    const params: Record<string, number> = {};
    for (const p of def.params) params[p.id] = mod.params?.[p.id] ?? p.default;
    // Legacy composer pattern banks become piano-roll clips.
    let data = mod.data;
    if (mod.type === 'composer' && data && !Array.isArray(data.notes)) {
      const clip = clipFromData(data);
      data = { notes: clip.notes, length: clip.length };
      warnings.push(`Composer ${mod.id}: legacy patterns converted to a piano-roll clip`);
    }
    // Legacy visualizers (scene/gain params, no graph) become node graphs.
    if (mod.type === 'visualizer') {
      if (!isVisGraph(data?.graph)) {
        // Raw saved params — the def-based fill below no longer knows scene/gain.
        data = { ...data, graph: sceneToGraph(mod.params?.scene, mod.params?.gain) };
        warnings.push(`Visualizer ${mod.id}: legacy scene converted to a visual graph`);
      } else {
        const cleaned = sanitizeVisGraph(data!.graph as VisGraphData);
        if (cleaned.dropped > 0) {
          data = { ...data, graph: cleaned.graph };
          warnings.push(`Visualizer ${mod.id}: ${cleaned.dropped} unknown visual node(s)/wire(s) dropped`);
        }
      }
    }
    graph.addModule({ ...mod, params, data });
    bumpModuleId(mod.id);
  }

  // Groups install before wires: wires may end on a group's intrinsic pole.
  for (const group of raw.groups ?? []) {
    const moduleIds = group.moduleIds.filter((id) => graph.modules.has(id));
    graph.groups.set(group.id, { ...group, moduleIds });
    bumpGroupId(group.id);
  }
  // Drop dangling child-group references (e.g. a skipped group).
  for (const group of graph.groups.values()) {
    group.groupIds = group.groupIds.filter((id) => graph.groups.has(id));
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

  const midiMap: Record<string, { moduleId: string; paramId: string }> = {};
  for (const [key, target] of Object.entries(raw.midiMap ?? {})) {
    if (graph.modules.has(target.moduleId)) midiMap[key] = target;
  }

  const meta: ProjectMeta = {};
  if (typeof raw.meta?.artists === 'string') meta.artists = raw.meta.artists;
  if (typeof raw.meta?.description === 'string') meta.description = raw.meta.description;
  if (typeof raw.meta?.picture === 'string' && raw.meta.picture.startsWith('data:image/')) {
    meta.picture = raw.meta.picture;
  }

  return {
    graph,
    name: raw.name ?? 'Untitled',
    meta,
    transport: { ...DEFAULT_TRANSPORT, ...raw.transport, playing: false },
    warnings,
    samples: (raw.samples ?? []).filter((s) => graph.modules.has(s.moduleId)),
    midiMap,
    faceAssets: raw.faceAssets ?? {},
  };
}
