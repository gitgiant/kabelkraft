/**
 * Shared AI prompt context (VISUALIZER_ENGINE_PLAN.md Phase 5) — every AI
 * flow (patch, project, MIDI, visualizer) prepends a structured summary of
 * relevant live state so the model builds on what exists instead of
 * hallucinating a blank canvas.
 */

import type { Graph } from './graph';
import { visGraphOf } from '../visual/migrate';

/** One-paragraph summary of the current project for AI prompts. */
export function buildAiContext(graph: Graph): string {
  if (graph.modules.size === 0) return 'Current project: empty canvas.';
  const counts = new Map<string, number>();
  for (const m of graph.modules.values()) counts.set(m.type, (counts.get(m.type) ?? 0) + 1);
  const mods = [...counts.entries()].map(([t, c]) => (c > 1 ? `${t}×${c}` : t)).join(', ');
  return `Current project: modules on canvas: ${mods}; ${graph.wires.size} wires.`;
}

/**
 * Pole wiring + current internal graph for one visualizer container — the
 * context for visual-graph generation (enables "make it more blue" edits and
 * stops the model writing karaoke graphs with no text source).
 */
export function buildVisContext(graph: Graph, moduleId: string): string {
  const wired = (portId: string): boolean => {
    for (const w of graph.wires.values()) {
      if (w.to.moduleId === moduleId && w.to.portId === portId) return true;
    }
    return false;
  };
  const yn = (b: boolean) => (b ? 'yes' : 'no');
  const lines = [
    `Container inputs wired on the main canvas: audio: ${yn(wired('in'))}, notes: ${yn(wired('notes'))}, ` +
      `mod: ${yn(wired('mod'))}, text: ${yn(wired('text'))}, upstream visualizer (vin): ${yn(wired('vin'))}.`,
  ];
  const mod = graph.modules.get(moduleId);
  const vis = mod ? visGraphOf(mod.data) : null;
  if (vis && vis.nodes.length > 0) {
    const compact = {
      nodes: vis.nodes.map((n) => ({ id: n.id, type: n.type, params: n.params })),
      wires: vis.wires.map((w) => ({
        from: { node: w.from.nodeId, port: w.from.portId },
        to: { node: w.to.nodeId, port: w.to.portId },
      })),
    };
    lines.push(`Current visual graph (edit it when the request is a tweak, replace it when the request is a new scene):`);
    lines.push('```json\n' + JSON.stringify(compact) + '\n```');
  }
  return lines.join('\n');
}

/**
 * Full configuration of one module group as .kkgroup-shaped JSON — modules
 * (params that differ from defaults, labels, data), internal wires, face, and
 * the boundary ports with their external wiring. The context for group-scoped
 * AI edits: the model edits the existing design instead of starting blank, and
 * keeping module ids lets external wires survive the replacement.
 */
export function buildGroupContext(graph: Graph, groupId: string): string {
  const group = graph.groups.get(groupId);
  if (!group) return '';
  const members = graph.modulesInGroup(groupId);

  const modules = [...members].flatMap((id) => {
    const mod = graph.modules.get(id);
    if (!mod) return [];
    const def = graph.def(mod.type);
    const params: Record<string, number> = {};
    for (const p of def.params) {
      const v = mod.params[p.id];
      if (v !== undefined && v !== p.default) params[p.id] = v;
    }
    return [
      {
        id,
        type: mod.type,
        ...(mod.label ? { label: mod.label } : {}),
        ...(Object.keys(params).length ? { params } : {}),
        ...(mod.data && Object.keys(mod.data).length ? { data: mod.data } : {}),
        x: Math.round(mod.x - group.x),
        y: Math.round(mod.y - group.y),
      },
    ];
  });

  const wires = [...graph.wires.values()]
    .filter((w) => members.has(w.from.moduleId) && members.has(w.to.moduleId))
    .map((w) => ({
      from: { module: w.from.moduleId, port: w.from.portId },
      to: { module: w.to.moduleId, port: w.to.portId },
    }));

  const face = group.face
    ? {
        width: group.face.width,
        height: group.face.height,
        // Spec-format elements (module/param keys), internal-only fields dropped.
        elements: group.face.elements.map((el) => ({
          kind: el.kind,
          x: el.x,
          y: el.y,
          w: el.w,
          h: el.h,
          ...(el.label ? { label: el.label } : {}),
          ...(el.text ? { text: el.text } : {}),
          ...(el.moduleId ? { module: el.moduleId } : {}),
          ...(el.paramId ? { param: el.paramId } : {}),
          ...(el.moduleId2 ? { module2: el.moduleId2 } : {}),
          ...(el.paramId2 ? { param2: el.paramId2 } : {}),
        })),
      }
    : undefined;

  const current = {
    kind: 'kkgroup',
    formatVersion: 1,
    name: group.name,
    modules,
    wires,
    ...(face ? { face } : {}),
  };

  // Boundary ports + their wiring on the main canvas — the group's "inputs".
  const externallyWired = new Set<string>();
  for (const w of graph.wires.values()) {
    const fromIn = members.has(w.from.moduleId);
    const toIn = members.has(w.to.moduleId);
    if (fromIn !== toIn) {
      const inner = fromIn ? w.from : w.to;
      externallyWired.add(`${inner.moduleId}:${inner.portId}`);
    }
  }
  const poles = graph
    .groupPoles(groupId)
    .map(
      (p) =>
        `- "${p.label}" (${p.type} ${p.direction}) = ${p.moduleId}.${p.portId}` +
        (externallyWired.has(p.key) ? ' — WIRED on the main canvas, keep this module id + port so the wire survives' : ''),
    );

  return [
    'You are EDITING an existing group. Its full current configuration (same .kkgroup format as your reply):',
    '```json\n' + JSON.stringify(current) + '\n```',
    'Boundary ports (the group\'s inputs/outputs on the main canvas):',
    ...(poles.length ? poles : ['- none']),
    'Rules for the edit: KEEP the existing module ids for modules you keep (external wires reconnect by id). ' +
      'Edit the configuration when the request is a tweak; replace it when the request is a new design. ' +
      'Your reply replaces the ENTIRE group — include everything that should remain, face included.',
  ].join('\n');
}

/** Prefix a user request with context, clearly separated. */
export function withContext(context: string, prompt: string): string {
  return `${context}\n\nRequest: ${prompt}`;
}
