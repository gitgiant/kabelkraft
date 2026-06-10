/**
 * AI patch (.kkgroup) validation (PRD §10.2). Structural errors abort the
 * import and are reported readably, including closest-match suggestions
 * ("module 'superSaw' unknown — closest match 'synth'"). Recoverable issues
 * (unknown param, out-of-range value) become warnings and are fixed up.
 */

import { ELEMENT_DEFAULTS, type FaceElement, type FaceElementKind, type FaceSpec } from './face';
import type { ModuleDef } from './module';

export interface KkGroupWireEnd {
  module: string;
  port: string;
}

export interface KkGroupModule {
  id: string;
  type: string;
  params: Record<string, number>;
  data?: Record<string, unknown>;
  label?: string;
  x: number;
  y: number;
}

export interface ParsedKkGroup {
  name: string;
  modules: KkGroupModule[];
  wires: Array<{ from: KkGroupWireEnd; to: KkGroupWireEnd }>;
  /** Optional designed front panel. Element bindings reference patch module ids. */
  face?: FaceSpec;
}

export interface ParseResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  patch?: ParsedKkGroup;
}

/** Small Levenshtein for "did you mean" suggestions. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[n];
}

export function closest(name: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = editDistance(name.toLowerCase(), c.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return bestDist <= Math.max(2, Math.floor(name.length / 3)) ? best : null;
}

/** Common AI vocabulary → real module types, when edit distance can't help. */
const TYPE_ALIASES: Record<string, string> = {
  saw: 'synth', supersaw: 'synth', osc: 'synth', oscillator: 'synth', pad: 'synth', bass: 'synth', lead: 'synth',
  drums: 'drum', drummachine: 'drum', kick: 'drum', beat: 'drum',
  echo: 'delay', filter: 'eq', comp: 'compressor', verb: 'reverb',
  piano: 'keyboard', keys: 'keyboard', output: 'audioOut', master: 'audioOut', speaker: 'audioOut',
  env: 'adsr', envelope: 'adsr', noise: 'random', seq: 'sequencer', arpeggiator: 'arp',
};

export function suggestType(name: string, candidates: Iterable<string>): string | null {
  const byDistance = closest(name, candidates);
  if (byDistance) return byDistance;
  const lower = name.toLowerCase();
  for (const [alias, type] of Object.entries(TYPE_ALIASES)) {
    if (lower.includes(alias)) return type;
  }
  return null;
}

/** Accept raw JSON or a markdown reply containing a ```json block. */
export function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fence ? fence[1] : text).trim();
}

const FACE_KINDS = new Set<FaceElementKind>([
  'knob', 'slider', 'xy', 'button', 'label', 'image', 'meter', 'readout',
]);

/**
 * Parse an optional designed front panel (PRD §6/§10). Element bindings keep the
 * patch's own module ids here; importAiPatch remaps them to real instance ids.
 * Face problems are warnings (recoverable) — a bad face never blocks the import.
 */
function parseFace(
  raw: unknown,
  byId: Map<string, KkGroupModule>,
  defs: Map<string, ModuleDef>,
  warnings: string[],
): FaceSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const doc = raw as Record<string, unknown>;
  const rawEls = Array.isArray(doc.elements) ? (doc.elements as Array<Record<string, unknown>>) : [];
  if (rawEls.length === 0) return undefined;

  const elements: FaceElement[] = [];
  rawEls.forEach((e, i) => {
    const kind = String(e.kind ?? '') as FaceElementKind;
    if (!FACE_KINDS.has(kind)) {
      warnings.push(`Face element ${i + 1}: unknown kind "${e.kind}" — dropped.`);
      return;
    }
    if (kind === 'image') {
      warnings.push('Face element: "image" needs an uploaded asset, which AI patches can\'t supply — dropped.');
      return;
    }
    const size = ELEMENT_DEFAULTS[kind];
    const el: FaceElement = {
      id: typeof e.id === 'string' && e.id ? e.id : `e${elements.length + 1}`,
      kind,
      x: Number(e.x) || 0,
      y: Number(e.y) || 0,
      w: Number(e.w) || size.w,
      h: Number(e.h) || size.h,
    };

    if (kind === 'label') {
      el.text = typeof e.text === 'string' ? e.text : typeof e.label === 'string' ? e.label : 'Label';
      if (Number.isFinite(Number(e.size))) el.size = Number(e.size);
    } else {
      // Bound elements reference a module (and, except meter, a param).
      const moduleId = String(e.module ?? e.moduleId ?? '');
      const mod = byId.get(moduleId);
      if (!mod) {
        warnings.push(`Face ${kind} ${i + 1}: module "${moduleId}" not in this patch — left unbound.`);
      } else {
        el.moduleId = moduleId;
        const def = defs.get(mod.type)!;
        if (kind !== 'meter') {
          const paramId = String(e.param ?? e.paramId ?? '');
          if (def.params.some((p) => p.id === paramId)) {
            el.paramId = paramId;
          } else {
            const hint = closest(paramId, def.params.map((p) => p.id));
            warnings.push(`Face ${kind} on "${mod.type}": param "${paramId}" unknown${hint ? ` (did you mean "${hint}"?)` : ''} — left unbound.`);
          }
        }
      }
      if (kind === 'xy') {
        const moduleId2 = String(e.module2 ?? e.moduleId2 ?? '');
        const mod2 = byId.get(moduleId2);
        const paramId2 = String(e.param2 ?? e.paramId2 ?? '');
        if (mod2 && defs.get(mod2.type)!.params.some((p) => p.id === paramId2)) {
          el.moduleId2 = moduleId2;
          el.paramId2 = paramId2;
        }
      }
      if (typeof e.label === 'string') el.label = e.label;
    }
    elements.push(el);
  });

  if (elements.length === 0) return undefined;
  return {
    width: Number(doc.width) || 360,
    height: Number(doc.height) || 240,
    grid: Number(doc.grid) || 10,
    snap: doc.snap !== false,
    elements,
  };
}

export function parseKkGroup(text: string, defs: Map<string, ModuleDef>): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(extractJson(text));
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${(e as Error).message}`], warnings };
  }
  const doc = raw as Record<string, unknown>;
  if (!Array.isArray(doc.modules) || doc.modules.length === 0) {
    return { ok: false, errors: ['Patch needs a non-empty "modules" array.'], warnings };
  }

  const modules: KkGroupModule[] = [];
  const seenIds = new Set<string>();
  (doc.modules as Array<Record<string, unknown>>).forEach((m, i) => {
    const id = typeof m.id === 'string' && m.id ? m.id : `m${i}`;
    if (seenIds.has(id)) {
      errors.push(`Duplicate module id "${id}".`);
      return;
    }
    seenIds.add(id);
    const type = String(m.type ?? '');
    const def = defs.get(type);
    if (!def) {
      const hint = suggestType(type, defs.keys());
      errors.push(`Module "${type}" unknown${hint ? ` — closest match "${hint}"` : ''}.`);
      return;
    }
    const params: Record<string, number> = {};
    for (const [key, value] of Object.entries((m.params as Record<string, unknown>) ?? {})) {
      const spec = def.params.find((p) => p.id === key);
      if (!spec) {
        const hint = closest(key, def.params.map((p) => p.id));
        warnings.push(`${type}: param "${key}" unknown${hint ? ` (did you mean "${hint}"?)` : ''} — dropped.`);
        continue;
      }
      const num = Number(value);
      if (!Number.isFinite(num)) {
        warnings.push(`${type}.${key}: not a number — using default ${spec.default}.`);
        continue;
      }
      const clamped = Math.min(spec.max, Math.max(spec.min, num));
      if (clamped !== num) warnings.push(`${type}.${key}: ${num} out of range ${spec.min}–${spec.max} — clamped.`);
      params[key] = clamped;
    }
    modules.push({
      id,
      type,
      params,
      data: (m.data as Record<string, unknown>) ?? undefined,
      label: typeof m.label === 'string' ? m.label : undefined,
      x: Number(m.x) || 0,
      y: Number(m.y) || 0,
    });
  });

  const byId = new Map(modules.map((m) => [m.id, m]));
  const wires: ParsedKkGroup['wires'] = [];
  ((doc.wires as Array<Record<string, unknown>>) ?? []).forEach((w, i) => {
    const norm = (end: unknown, side: string): KkGroupWireEnd | null => {
      const e = end as Record<string, unknown> | undefined;
      const moduleId = String(e?.module ?? e?.moduleId ?? '');
      const portId = String(e?.port ?? e?.portId ?? '');
      const mod = byId.get(moduleId);
      if (!mod) {
        errors.push(`Wire ${i + 1} ${side}: module "${moduleId}" not in this patch.`);
        return null;
      }
      const def = defs.get(mod.type)!;
      if (!def.ports.some((p) => p.id === portId)) {
        const hint = closest(portId, def.ports.map((p) => p.id));
        errors.push(`Wire ${i + 1} ${side}: "${mod.type}" has no port "${portId}"${hint ? ` — closest match "${hint}"` : ''}.`);
        return null;
      }
      return { module: moduleId, port: portId };
    };
    const from = norm(w.from, 'from');
    const to = norm(w.to, 'to');
    if (!from || !to) return;
    // Direction + type checks here; fan-in rules are enforced at insert time.
    const fromDef = defs.get(byId.get(from.module)!.type)!;
    const toDef = defs.get(byId.get(to.module)!.type)!;
    const fromPort = fromDef.ports.find((p) => p.id === from.port)!;
    const toPort = toDef.ports.find((p) => p.id === to.port)!;
    if (fromPort.direction !== 'out' || toPort.direction !== 'in') {
      errors.push(`Wire ${i + 1}: must go from an OUT port to an IN port (${from.module}.${from.port} → ${to.module}.${to.port}).`);
      return;
    }
    if (fromPort.type !== toPort.type) {
      errors.push(`Wire ${i + 1}: type mismatch — ${fromPort.type} output into ${toPort.type} input.`);
      return;
    }
    wires.push({ from, to });
  });

  if (errors.length > 0) return { ok: false, errors, warnings };

  const face = parseFace(doc.face, byId, defs, warnings);
  return {
    ok: true,
    errors,
    warnings,
    patch: { name: typeof doc.name === 'string' && doc.name ? doc.name : 'AI Patch', modules, wires, face },
  };
}
