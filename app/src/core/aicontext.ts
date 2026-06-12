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

/** Prefix a user request with context, clearly separated. */
export function withContext(context: string, prompt: string): string {
  return `${context}\n\nRequest: ${prompt}`;
}
