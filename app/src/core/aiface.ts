/**
 * AI face generation (.kkface): a spec pack an LLM needs to design a front
 * panel for an EXISTING module group — the group's real modules and params
 * ride along as context, so element bindings use real instance ids and need
 * no remapping. Mirrors the visual-graph flow (aivisual.ts): generate in-app
 * via aiprovider, or copy the spec for an external chatbot.
 */

import { extractJson, parseFace } from './aiimport';
import { FACE_ELEMENT_RULES } from './aispec';
import { fitFaceToContent, meterTargets, type FaceSpec } from './face';
import type { Graph } from './graph';
import { MODULE_DEFS } from './registry';

export interface ParseFaceResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  face?: FaceSpec;
}

const FACE_FORMAT = `
## Face format (.kkface)

Reply with ONE JSON code block, no prose inside it — the face object itself
plus a \`kind\` marker:

\`\`\`json
{ "kind": "kkface", "width": 360, "height": 230, "elements": [ ... ] }
\`\`\`

The \`elements\` array follows the face rules below. \`module\` must be one of
the EXACT module ids listed under "The group you are designing for" — they are
live instance ids, do not invent new ones.
${FACE_ELEMENT_RULES}`;

const FACE_GUIDANCE = `
## Design guidance

- A face is a performance surface, not a settings page: expose the FEW params
  a player would reach for (cutoff, levels, sends, rates), not every value.
- Start with a title \`label\`, group related controls under section labels,
  and add a \`meter\` on the output module so the panel shows life.
- Respect the listed param ranges; option params are bound like any other
  (the control steps through the options).
`;

/** Spec pack + live context for one group: format, rules, modules, params. */
export function generateFaceSpecPack(graph: Graph, groupId: string): string {
  const group = graph.groups.get(groupId);
  const lines: string[] = [];
  lines.push('# KabelKraft AI face spec');
  lines.push('');
  lines.push(
    'You are designing the front panel (face) of an existing module group in ' +
      'KabelKraft, a modular audio playground. The group already works — you ' +
      'only lay out controls bound to its inner module params.',
  );
  lines.push(FACE_FORMAT);
  lines.push(FACE_GUIDANCE);
  lines.push(`## The group you are designing for`);
  lines.push('');
  lines.push(`Group name: "${group?.name ?? 'Group'}". Modules inside (bind \`module\` to these exact ids):`);
  for (const moduleId of graph.modulesInGroup(groupId)) {
    const mod = graph.modules.get(moduleId);
    if (!mod) continue;
    const def = graph.def(mod.type);
    const params = def.params
      .map((p) => {
        const range = p.options ? p.options.join('/') : `${p.min}–${p.max}${p.unit ? ` ${p.unit}` : ''}`;
        return `${p.id} (${range})`;
      })
      .join(', ');
    lines.push(`- id "${moduleId}" — ${mod.type} "${mod.label ?? def.name}"${params ? `: params ${params}` : ' (no params)'}`);
  }
  const meters = meterTargets(graph, groupId);
  if (meters.length) {
    lines.push('');
    lines.push(`Meter targets (audio modules): ${meters.map((m) => `"${m.moduleId}" (${m.label})`).join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Validate an LLM's .kkface reply against the group's live modules. Bindings
 * are checked against real instance ids (nested members included) — bad ones
 * are dropped with warnings, parseFace-style; no elements at all is an error.
 */
export function parseKkFace(text: string, graph: Graph, groupId: string): ParseFaceResult {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(extractJson(text));
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${(e as Error).message}`], warnings };
  }

  const byId = new Map<string, { type: string }>();
  for (const moduleId of graph.modulesInGroup(groupId)) {
    const mod = graph.modules.get(moduleId);
    if (mod) byId.set(moduleId, mod);
  }

  // Lenient on the wrapper: accept the face object itself or `{ "face": {...} }`.
  const doc = raw as Record<string, unknown> | null;
  const payload = doc && !Array.isArray(doc.elements) && doc.face ? doc.face : raw;
  const face = parseFace(payload, byId, MODULE_DEFS, warnings);
  if (!face) {
    return {
      ok: false,
      errors: ['Face needs a non-empty "elements" array (kinds: knob, slider, xy, button, label, meter, readout).'],
      warnings,
    };
  }
  return { ok: true, errors: [], warnings, face: fitFaceToContent(face) };
}
