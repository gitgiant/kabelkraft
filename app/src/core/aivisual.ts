/**
 * AI visual-graph generation (.kkvis) — VISUALIZER_ENGINE_PLAN.md Phase 5.
 * Spec pack generated from the live visual node registry + a validation
 * gauntlet mirroring the .kkgroup importer: structural errors abort (and feed
 * the provider repair loop); recoverable issues are clamped with warnings.
 */

import { closest, extractJson } from './aiimport';
import { VIS_NODE_DEFS, visualInPorts } from '../visual/registry';
import { topoOrder } from '../visual/graphops';
import type { VisGraphData, VisNodeDef, VisNodeInstance, VisWire } from '../visual/types';

// ---------------------------------------------------------------------------
// Spec pack
// ---------------------------------------------------------------------------

const VIS_FORMAT_RULES = `
## Visual graph format (.kkvis)

Reply with ONE JSON code block, no prose inside it:

\`\`\`json
{
  "kind": "kkvis",
  "name": "Short scene name",
  "nodes": [
    { "id": "spec1", "type": "spectrum", "params": { "gain": 2 } },
    { "id": "out", "type": "output" }
  ],
  "wires": [
    { "from": { "node": "spec1", "port": "out" }, "to": { "node": "out", "port": "in" } }
  ],
  "note": "Optional one-line tip for the user (e.g. a module worth wiring on the main canvas)."
}
\`\`\`

Rules:
- \`id\` is any string unique within the graph; wires reference these ids.
- \`params\` may list only the params you change; everything else gets its default.
  Values are numbers; for option params use the option's INDEX (0-based).
- The graph is a DAG — cycles are invalid. Trails/tunnels come from the \`feedback\` node.
- Exactly ONE \`output\` node; the frame wired into it is what the user sees.
- \`visual\` inputs accept ONE wire each. Layer multiple sources with \`blend\`
  (a = bottom, b = top); stack blends for more layers.
- Every continuous param has a \`control\` in-port of the same id (e.g.
  \`amount\` on \`blur\`). Wiring it from a \`features\` output
  (level/bass/mid/high/onset) makes the visual move with the music:
  the 0–1 signal MULTIPLIES the param's set value, except circular params
  (\`hue\`, \`hue2\`, \`hueShift\`, \`angle\`) where it ADDS and wraps within
  0–1. The result is clamped to the param's range. Option params have no
  control port.
- Sources read the container's audio implicitly; you never wire audio inside.
- The container's text input (lyrics, readouts) renders via \`textlayer\`;
  an upstream visualizer chained on the main canvas arrives via \`visualin\`.
- \`x\`/\`y\` are optional layout hints; omit them and the app auto-lays-out.
`;

function visCatalogSection(): string {
  const lines: string[] = ['## Visual node catalog', ''];
  for (const def of VIS_NODE_DEFS.values()) {
    lines.push(`### ${def.type} — ${def.name} (${def.category})`);
    lines.push(def.description);
    const ports = def.ports.map((p) => `\`${p.id}\` (${p.type} ${p.direction})`).join(', ');
    lines.push(`Ports: ${ports || 'none'}`);
    if (def.params.length > 0) {
      lines.push('Params:');
      for (const p of def.params) {
        const opts = p.options ? ` options: [${p.options.map((o, i) => `${i}=${o}`).join(', ')}]` : '';
        lines.push(`- \`${p.id}\` (${p.min}–${p.max}, default ${p.default})${opts}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

const VIS_EXAMPLES = `
## Annotated examples

### 1. Bass-pump shapes with bloom
\`\`\`json
{
  "kind": "kkvis", "name": "Pump Grid",
  "nodes": [
    { "id": "bg", "type": "gradient", "params": { "mode": 3, "hue": 0.7, "hue2": 0.85, "lum": 0.12 } },
    { "id": "shapes", "type": "shapes", "params": { "shape": 3, "count": 5, "size": 0.5, "pulse": 0.9, "hue": 0.55 } },
    { "id": "feat", "type": "features" },
    { "id": "mix", "type": "blend", "params": { "mode": 2 } },
    { "id": "glow", "type": "bloom", "params": { "threshold": 0.4, "amount": 1.2 } },
    { "id": "out", "type": "output" }
  ],
  "wires": [
    { "from": { "node": "bg", "port": "out" }, "to": { "node": "mix", "port": "a" } },
    { "from": { "node": "shapes", "port": "out" }, "to": { "node": "mix", "port": "b" } },
    { "from": { "node": "feat", "port": "bass" }, "to": { "node": "glow", "port": "amount" } },
    { "from": { "node": "mix", "port": "out" }, "to": { "node": "glow", "port": "in" } },
    { "from": { "node": "glow", "port": "out" }, "to": { "node": "out", "port": "in" } }
  ]
}
\`\`\`
Hex grid pulsing with the level (\`pulse\`), screen-blended over a radial
gradient; bloom strength rides the bass via a \`features\` control wire.

### 2. Karaoke lyrics over webcam
\`\`\`json
{
  "kind": "kkvis", "name": "Karaoke Cam",
  "nodes": [
    { "id": "cam", "type": "webcam", "params": { "fit": 0, "mirror": 1 } },
    { "id": "fringe", "type": "chromashift", "params": { "amount": 0.25 } },
    { "id": "words", "type": "textlayer", "params": { "mode": 3, "size": 0.1, "hue": 0.13, "sat": 0.9, "y": 0.7 } },
    { "id": "mix", "type": "blend", "params": { "mode": 0 } },
    { "id": "out", "type": "output" }
  ],
  "wires": [
    { "from": { "node": "cam", "port": "out" }, "to": { "node": "fringe", "port": "in" } },
    { "from": { "node": "fringe", "port": "out" }, "to": { "node": "mix", "port": "a" } },
    { "from": { "node": "words", "port": "out" }, "to": { "node": "mix", "port": "b" } },
    { "from": { "node": "mix", "port": "out" }, "to": { "node": "out", "port": "in" } }
  ],
  "note": "Wire a Speech to Text module into the visualizer's Text input for live lyrics."
}
\`\`\`
\`textlayer\` stack mode draws the lyric history; interim speech glows as it
arrives. The note tells the user what to wire on the main canvas.

### 3. Particle tunnel (feedback)
\`\`\`json
{
  "kind": "kkvis", "name": "Note Tunnel",
  "nodes": [
    { "id": "parts", "type": "particles", "params": { "rate": 0.8, "size": 1.4 } },
    { "id": "trail", "type": "feedback", "params": { "zoom": 0.35, "spin": 0.15, "fade": 0.93 } },
    { "id": "kal", "type": "kaleido", "params": { "segments": 6, "spin": 0.1 } },
    { "id": "out", "type": "output" }
  ],
  "wires": [
    { "from": { "node": "parts", "port": "out" }, "to": { "node": "trail", "port": "in" } },
    { "from": { "node": "trail", "port": "out" }, "to": { "node": "kal", "port": "in" } },
    { "from": { "node": "kal", "port": "out" }, "to": { "node": "out", "port": "in" } }
  ]
}
\`\`\`
Note bursts feed a zooming feedback loop — the classic infinite tunnel —
then mirror-fold into a mandala. No wire cycles needed: \`feedback\` holds
the previous frame internally.
`;

export function generateVisualSpecPack(): string {
  return [
    '# KabelKraft AI visualizer spec',
    '',
    'You are writing the visual graph inside one KabelKraft visualizer container — ' +
      'audio-reactive graphics built from wired nodes (sources → effects → output), ' +
      'rendered on the GPU. Produce a single JSON code block in the format below.',
    VIS_FORMAT_RULES,
    visCatalogSection(),
    VIS_EXAMPLES,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Validation gauntlet
// ---------------------------------------------------------------------------

export interface ParseVisResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  graph?: VisGraphData;
  name?: string;
  /** Model's optional human-readable tip, shown after apply. */
  note?: string;
}

export function parseKkVis(text: string): ParseVisResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(extractJson(text)) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${(e as Error).message}`], warnings };
  }
  if (doc.kind !== undefined && doc.kind !== 'kkvis') {
    warnings.push(`kind is "${doc.kind}" (expected "kkvis") — continuing anyway.`);
  }
  const rawNodes = Array.isArray(doc.nodes) ? (doc.nodes as Array<Record<string, unknown>>) : null;
  if (!rawNodes || rawNodes.length === 0) {
    return { ok: false, errors: ['"nodes" must be a non-empty array.'], warnings };
  }

  // Nodes: known types, unique ids, clamped params.
  const nodes: VisNodeInstance[] = [];
  const byId = new Map<string, { node: VisNodeInstance; def: VisNodeDef }>();
  rawNodes.forEach((n, i) => {
    const id = String(n.id ?? `v${i + 1}`);
    const type = String(n.type ?? '');
    const def = VIS_NODE_DEFS.get(type);
    if (!def) {
      const hint = closest(type, VIS_NODE_DEFS.keys());
      errors.push(`Node "${id}": unknown type "${type}"${hint ? ` — closest match "${hint}"` : ''}.`);
      return;
    }
    if (byId.has(id)) {
      errors.push(`Duplicate node id "${id}".`);
      return;
    }
    const params: Record<string, number> = {};
    for (const p of def.params) params[p.id] = p.default;
    for (const [key, raw] of Object.entries((n.params as Record<string, unknown>) ?? {})) {
      const spec = def.params.find((p) => p.id === key);
      if (!spec) {
        const hint = closest(key, def.params.map((p) => p.id));
        warnings.push(`Node "${id}": unknown param "${key}"${hint ? ` (did you mean "${hint}"?)` : ''} — dropped.`);
        continue;
      }
      const v = Number(raw);
      if (!Number.isFinite(v)) {
        warnings.push(`Node "${id}": param "${key}" is not a number — default kept.`);
        continue;
      }
      const clamped = Math.min(spec.max, Math.max(spec.min, v));
      if (clamped !== v) warnings.push(`Node "${id}": param "${key}" clamped to ${clamped}.`);
      params[key] = clamped;
    }
    const node: VisNodeInstance = {
      id,
      type,
      x: Number(n.x) || 0,
      y: Number(n.y) || 0,
      params,
    };
    if (typeof (n.data as Record<string, unknown>)?.text === 'string') {
      node.data = { text: (n.data as Record<string, unknown>).text };
    }
    nodes.push(node);
    byId.set(id, { node, def });
  });

  // Exactly one output.
  const outputs = nodes.filter((n) => n.type === 'output');
  if (outputs.length === 0) errors.push('The graph needs exactly one "output" node — none found.');
  if (outputs.length > 1) errors.push(`The graph needs exactly one "output" node — found ${outputs.length}.`);

  // Wires: resolved ends, type/direction match, single fan-in.
  const wires: VisWire[] = [];
  const rawWires = Array.isArray(doc.wires) ? (doc.wires as Array<Record<string, unknown>>) : [];
  const takenInputs = new Set<string>();
  rawWires.forEach((w, i) => {
    const from = w.from as Record<string, unknown> | undefined;
    const to = w.to as Record<string, unknown> | undefined;
    const fromId = String(from?.node ?? from?.module ?? '');
    const toId = String(to?.node ?? to?.module ?? '');
    const fromPort = String(from?.port ?? 'out');
    const toPort = String(to?.port ?? 'in');
    const src = byId.get(fromId);
    const dst = byId.get(toId);
    if (!src || !dst) {
      errors.push(`Wire ${i + 1}: ${!src ? `unknown source node "${fromId}"` : `unknown target node "${toId}"`}.`);
      return;
    }
    const srcPort = src.def.ports.find((p) => p.id === fromPort && p.direction === 'out');
    const dstPort = dst.def.ports.find((p) => p.id === toPort && p.direction === 'in');
    if (!srcPort || !dstPort) {
      errors.push(
        `Wire ${i + 1}: ${!srcPort ? `"${src.node.type}" has no output port "${fromPort}"` : `"${dst.node.type}" has no input port "${toPort}"`}.`,
      );
      return;
    }
    if (srcPort.type !== dstPort.type) {
      errors.push(`Wire ${i + 1}: type mismatch — ${srcPort.type} output into ${dstPort.type} input.`);
      return;
    }
    const inputKey = `${toId}:${toPort}`;
    if (takenInputs.has(inputKey)) {
      warnings.push(`Wire ${i + 1}: input "${toPort}" of "${toId}" already wired — extra wire dropped (use blend to layer).`);
      return;
    }
    takenInputs.add(inputKey);
    wires.push({ id: `vw${wires.length + 1}`, from: { nodeId: fromId, portId: fromPort }, to: { nodeId: toId, portId: toPort } });
  });

  const graph: VisGraphData = { nodes, wires };

  // DAG check: topoOrder omits nodes caught in cycles.
  if (errors.length === 0 && topoOrder(graph).length !== nodes.length) {
    errors.push('The graph contains a wire cycle — visual graphs are DAGs (use the feedback node for trails).');
  }

  // Output actually fed?
  if (errors.length === 0 && outputs.length === 1) {
    const fed = wires.some((w) => w.to.nodeId === outputs[0].id);
    if (!fed) errors.push('The "output" node has nothing wired into it.');
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  // Auto-layout by topological depth when positions were omitted.
  if (nodes.every((n) => n.x === 0 && n.y === 0)) {
    const depth = new Map<string, number>();
    for (const n of topoOrder(graph)) {
      let d = 0;
      for (const w of wires) {
        if (w.to.nodeId === n.id) d = Math.max(d, (depth.get(w.from.nodeId) ?? 0) + 1);
      }
      depth.set(n.id, d);
    }
    const rows = new Map<number, number>();
    for (const n of nodes) {
      const d = depth.get(n.id) ?? 0;
      const row = rows.get(d) ?? 0;
      rows.set(d, row + 1);
      n.x = 40 + d * 190;
      n.y = 60 + row * 130;
    }
  }

  return {
    ok: true,
    errors,
    warnings,
    graph,
    name: typeof doc.name === 'string' ? doc.name : undefined,
    note: typeof doc.note === 'string' ? doc.note : undefined,
  };
}
