/**
 * AI preset generation (.kkpreset) — PRESETS_PLAN.md.
 *
 * A spec pack an LLM needs to retune (and, for a container, rewire) an existing
 * module or group, plus the validator that turns its JSON reply into a
 * ModulePreset payload. Like aiface.ts, the target's LIVE module ids ride along
 * in the spec, so the output binds to real instance ids and needs no remap.
 *
 * The model retunes params and (containers only) rewires the internal graph; it
 * does NOT author module `data` (sequencer steps, samples) — clip generation
 * lives in the composer AI flow.
 */

import { extractJson } from './aiimport';
import type { Graph } from './graph';
import type { ModulePreset, PresetWire } from './module';
import type { PresetTarget } from './preset';

export interface ParsePresetResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  name?: string;
  category?: string;
  /** Payload (members+wires for a container; params for a module). */
  preset?: Pick<ModulePreset, 'params' | 'members' | 'wires'>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Member module ids the target covers (flattened for a group). */
function targetMembers(graph: Graph, target: PresetTarget): string[] {
  return target.isGroup ? [...graph.modulesInGroup(target.id)] : [target.id];
}

const FORMAT = `
## Reply format (.kkpreset)

Reply with ONE JSON code block, no prose inside it:

\`\`\`json
{
  "kind": "kkpreset",
  "name": "Short preset name",
  "category": "Bass",
  "members": {
    "<moduleId>": { "params": { "<paramId>": <number> } }
  },
  "wires": [
    { "from": { "module": "<moduleId>", "port": "<portId>" },
      "to":   { "module": "<moduleId>", "port": "<portId>" } }
  ]
}
\`\`\`

Rules:
- \`members\`: keyed by the EXACT module ids listed below (live ids — do not
  invent). For each, set only the params you want to change; option params take
  the 0-based INDEX. Stay within each param's listed range.
- \`wires\`: the COMPLETE internal wiring you want (it replaces the current
  internal wiring). Connect an OUTPUT port to an INPUT port of the SAME signal
  type; both endpoints must be modules listed below; control inputs accept only
  ONE wire. Omit \`wires\` to keep the current wiring.
- Do not add or remove modules. Do not set \`data\`.`;

const MODULE_FORMAT = `
## Reply format (.kkpreset)

Reply with ONE JSON code block, no prose inside it:

\`\`\`json
{ "kind": "kkpreset", "name": "Short preset name", "category": "Lead",
  "members": { "<moduleId>": { "params": { "<paramId>": <number> } } } }
\`\`\`

Set only the params you want to change; option params take the 0-based INDEX.
Stay within each param's listed range. There is one module and no wiring.`;

/** Spec pack + live context for one preset target. */
export function generatePresetSpecPack(graph: Graph, target: PresetTarget): string {
  const lines: string[] = ['# KabelKraft AI preset spec', ''];
  lines.push(
    'You tune a preset for an existing module setup in KabelKraft, a modular ' +
      'audio playground. It already works — you only choose new param values' +
      (target.isGroup ? ' and (optionally) the internal wiring.' : '.'),
  );
  lines.push(target.isGroup ? FORMAT : MODULE_FORMAT);
  lines.push('');
  lines.push(target.isGroup ? '## Modules in this container' : '## The module');
  lines.push('');

  const members = targetMembers(graph, target);
  for (const moduleId of members) {
    const mod = graph.modules.get(moduleId);
    if (!mod) continue;
    const def = graph.def(mod.type);
    const params = def.params
      .map((p) => {
        const range = p.options ? `0–${p.options.length - 1}: ${p.options.join('/')}` : `${p.min}–${p.max}${p.unit ? ` ${p.unit}` : ''}`;
        const cur = mod.params[p.id];
        return `${p.id} [${range}] = ${cur}`;
      })
      .join('; ');
    lines.push(`- id "${moduleId}" — ${mod.type} "${mod.label ?? def.name}"${params ? `\n    params: ${params}` : ' (no params)'}`);
    if (target.isGroup) {
      const ports = def.ports.map((p) => `${p.id}(${p.type} ${p.direction})`).join(', ');
      if (ports) lines.push(`    ports: ${ports}`);
    }
  }

  if (target.isGroup) {
    const memberSet = new Set(members);
    const internal = [...graph.wires.values()].filter(
      (w) => memberSet.has(w.from.moduleId) && memberSet.has(w.to.moduleId),
    );
    lines.push('');
    lines.push('## Current internal wiring');
    if (internal.length === 0) lines.push('(none)');
    for (const w of internal) {
      lines.push(`- ${w.from.moduleId}.${w.from.portId} → ${w.to.moduleId}.${w.to.portId}`);
    }
  }
  return lines.join('\n');
}

/** Spec + optional user prompt in one paste-able block. */
export function generatePresetSpecPackWithPrompt(graph: Graph, target: PresetTarget, prompt?: string): string {
  const spec = generatePresetSpecPack(graph, target);
  const p = prompt?.trim();
  return p ? `${spec}\n\nRequest: ${p}` : spec;
}

function asPortRef(v: unknown): { moduleId: string; portId: string } | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const module = o.module ?? o.moduleId;
  const port = o.port ?? o.portId;
  if (typeof module !== 'string' || typeof port !== 'string') return null;
  return { moduleId: module, portId: port };
}

/**
 * Validate an LLM's .kkpreset reply against the target's live modules. Unknown
 * module/param ids are dropped with warnings; params are clamped to range.
 * Wires are validated structurally (output→input, same type, both members,
 * control single-fan-in) and bad ones dropped. Returns a ModulePreset payload.
 */
export function parseKkPreset(text: string, graph: Graph, target: PresetTarget): ParsePresetResult {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(extractJson(text));
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${(e as Error).message}`], warnings };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['Top level must be a JSON object.'], warnings };
  }
  const doc = raw as Record<string, unknown>;
  if (doc.kind !== undefined && doc.kind !== 'kkpreset') {
    warnings.push(`"kind" is "${String(doc.kind)}" — expected "kkpreset".`);
  }

  const memberIds = new Set(targetMembers(graph, target));
  const rawMembers = (typeof doc.members === 'object' && doc.members) ? (doc.members as Record<string, unknown>) : {};

  const members: NonNullable<ModulePreset['members']> = {};
  let touchedParams = 0;
  for (const [moduleId, entry] of Object.entries(rawMembers)) {
    if (!memberIds.has(moduleId)) {
      warnings.push(`Unknown module "${moduleId}" skipped.`);
      continue;
    }
    const mod = graph.modules.get(moduleId)!;
    const def = graph.def(mod.type);
    const rawParams = (entry && typeof entry === 'object' && (entry as Record<string, unknown>).params) || {};
    const params: Record<string, number> = {};
    for (const [pid, val] of Object.entries(rawParams as Record<string, unknown>)) {
      const spec = def.params.find((p) => p.id === pid);
      const num = Number(val);
      if (!spec || !Number.isFinite(num)) {
        if (!spec) warnings.push(`Unknown param "${moduleId}.${pid}" skipped.`);
        continue;
      }
      params[pid] = spec.options
        ? clamp(Math.round(num), 0, spec.options.length - 1)
        : clamp(num, spec.min, spec.max);
      touchedParams++;
    }
    members[moduleId] = { params };
  }

  // Wires (containers only).
  let wires: PresetWire[] | undefined;
  if (target.isGroup) {
    wires = [];
    const controlTargets = new Set<string>();
    for (const w of Array.isArray(doc.wires) ? doc.wires : []) {
      const from = asPortRef((w as Record<string, unknown>)?.from);
      const to = asPortRef((w as Record<string, unknown>)?.to);
      if (!from || !to) { warnings.push('Malformed wire skipped.'); continue; }
      if (!memberIds.has(from.moduleId) || !memberIds.has(to.moduleId)) {
        warnings.push(`Wire ${from.moduleId}.${from.portId} → ${to.moduleId}.${to.portId} skipped (not a member).`);
        continue;
      }
      const fromSpec = graph.port(from);
      const toSpec = graph.port(to);
      if (!fromSpec || !toSpec) { warnings.push(`Wire references unknown port: ${from.portId}/${to.portId}.`); continue; }
      if (fromSpec.direction !== 'out' || toSpec.direction !== 'in' || fromSpec.type !== toSpec.type) {
        warnings.push(`Invalid wire ${from.moduleId}.${from.portId} → ${to.moduleId}.${to.portId} (must be out→in, same type).`);
        continue;
      }
      const toKey = `${to.moduleId}:${to.portId}`;
      if ((toSpec.type === 'control' || toSpec.type === 'visual') && controlTargets.has(toKey)) {
        warnings.push(`Dropped extra wire into single-input ${toKey}.`);
        continue;
      }
      controlTargets.add(toKey);
      wires.push({ from, to });
    }
  }

  if (touchedParams === 0 && (!wires || wires.length === 0)) {
    return { ok: false, errors: ['No usable params or wires in the reply.'], warnings };
  }

  const name = typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : undefined;
  const category = typeof doc.category === 'string' && doc.category.trim() ? doc.category.trim() : undefined;

  // Assemble payload by target shape.
  const preset: Pick<ModulePreset, 'params' | 'members' | 'wires'> = target.isGroup
    ? { members, wires }
    : { params: members[target.id]?.params ?? {} };

  return { ok: true, errors: [], warnings, name, category, preset };
}
