/**
 * AI project generation (.kkproject): a spec pack an LLM needs to write an
 * ENTIRE KabelKraft project — modules, wires, nested groups, tempo, and
 * composer clips (MIDI embedded in the JSON) — plus the validator that turns
 * its reply into an insertable structure. Mirrors the AI patch flow
 * (aispec.ts / aiimport.ts): copy the spec for an external chatbot, or
 * generate in-app via aiprovider.
 */

import { extractJson, parseKkGroup, type KkGroupModule } from './aiimport';
import { MIDI_FIELDS, MIDI_GUIDANCE } from './aimidi';
import { moduleCatalogSection, SIGNAL_FLOW } from './aispec';
import { clipFromData } from './composer';
import type { ModuleDef } from './module';

const PROJECT_FORMAT_RULES = `
## Project format (.kkproject)

Reply with ONE JSON code block, no prose inside it:

\`\`\`json
{
  "kind": "kkproject",
  "formatVersion": 1,
  "name": "Short project name",
  "tempo": 120,
  "modules": [
    { "id": "comp1", "type": "composer", "data": { "length": 16, "notes": [ { "start": 0, "length": 1, "pitch": 48, "vel": 0.9 } ] } },
    { "id": "osc1", "type": "osc", "params": { "wave": 3 }, "x": 0, "y": 0 }
  ],
  "wires": [
    { "from": { "module": "osc1", "port": "out" }, "to": { "module": "out", "port": "in" } }
  ],
  "groups": [
    { "id": "bass", "name": "Bass Synth", "modules": ["comp1", "osc1"], "groups": [] }
  ]
}
\`\`\`

Rules:
- \`tempo\`: master BPM, 20–300 (default 120).
- \`modules\`/\`wires\`: same rules as a patch — \`id\` is any string unique in the
  project, \`params\` lists only what you change (option params use the 0-based
  INDEX), \`x\`/\`y\` are layout hints, wires connect OUT → IN of the same signal
  type, control inputs take ONE wire, audio inputs sum.
- This is a COMPLETE project: every voice chain must end at an \`audioOut\`
  (one shared \`audioOut\` after a \`mixer\` is the usual shape), and everything
  that should play must be driven by a note source — use \`composer\` modules
  with embedded clips so the project plays by itself on Play.

### Groups (encapsulation)

\`groups\` is optional but recommended: it organizes the project into named,
collapsible units (one per instrument/effect chain). Groups NEST — a group may
contain other groups via its \`groups\` array, e.g. a "Drums" group containing
"Kick" and "Snare" groups.
- \`modules\`: ids of modules directly inside this group.
- \`groups\`: ids of child groups directly inside this group.
- Each module and each group may appear in at most ONE parent.
- \`collapsed\` (optional, default true): collapsed groups render as one tile.

### Composer clips (MIDI embedded in the JSON)

Every \`composer\` module carries its music in \`data\`: \`{ "length": beats,
"notes": [...] }\` — the clip is loaded straight into that composer's piano
roll on import.

${MIDI_FIELDS}

Musical guidance:

${MIDI_GUIDANCE}
`;

const PROJECT_SHAPE = `
## The shape of a full project

Aim for the complete signal path: composer clips → synth voices → effects →
mixer → audioOut.

- One \`composer\` per musical part (bassline, chords, lead, drum pattern),
  each with its clip embedded in \`data\`. Give parts the same \`length\` (or
  multiples) so they loop in phase.
- Each part feeds its own instrument: \`composer.notes → voice → osc/wtosc/smpl
  → vcf → vca → ...\` (see the signal-flow patterns above).
- Per-part effects (delay, reverb, drive...) sit in that part's audio path.
- All parts meet at a \`mixer\` (set per-channel levels) → optional master
  effects (compressor, limiter, eq) → ONE \`audioOut\`.
- Group each instrument chain (composer + voice + synth + its effects) into
  its own group; nest related groups (e.g. drum voices inside "Drums").
- Set \`tempo\` to fit the style. Do NOT include keyboard/midiIn modules unless
  asked — the project should play on its own.
`;

export interface KkProjectGroup {
  id: string;
  name: string;
  moduleIds: string[];
  groupIds: string[];
  collapsed: boolean;
}

export interface ParsedKkProject {
  name: string;
  tempo: number;
  modules: KkGroupModule[];
  wires: Array<{ from: { module: string; port: string }; to: { module: string; port: string } }>;
  /** Validated nested group tree (parents reference children by id). */
  groups: KkProjectGroup[];
}

export interface ParseProjectResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  project?: ParsedKkProject;
}

/** Full project spec pack: format + signal flow + module catalog. */
export function generateProjectSpecPack(): string {
  const lines: string[] = [];
  lines.push('# KabelKraft AI project spec');
  lines.push('');
  lines.push(
    'You are writing a COMPLETE project for KabelKraft, a modular audio playground. ' +
      'Modules are connected with typed wires; composer modules hold the music as embedded ' +
      'MIDI-style clips. Produce a single JSON code block in the format below.',
  );
  lines.push(PROJECT_FORMAT_RULES);
  lines.push(SIGNAL_FLOW);
  lines.push(PROJECT_SHAPE);
  lines.push(moduleCatalogSection());
  return lines.join('\n');
}

/**
 * Validate an LLM's .kkproject reply. Modules/wires reuse the .kkgroup
 * validator; groups (with nesting), tempo, and composer clips are validated
 * here. Structural errors abort; recoverable issues become warnings.
 */
export function parseKkProject(text: string, defs: Map<string, ModuleDef>): ParseProjectResult {
  const base = parseKkGroup(text, defs);
  if (!base.ok || !base.patch) {
    return { ok: false, errors: base.errors, warnings: base.warnings };
  }
  const warnings = [...base.warnings];
  const modules = base.patch.modules;

  // Composer clips: sanitize embedded notes/length so bad values can't load.
  for (const m of modules) {
    if (m.type !== 'composer') continue;
    const clip = clipFromData(m.data);
    if ((m.data?.notes as unknown[] | undefined)?.length && clip.notes.length === 0) {
      warnings.push(`Composer "${m.id}": clip had no usable notes.`);
    }
    m.data = { ...m.data, notes: clip.notes, length: clip.length };
  }

  // Tempo: clamp with a warning.
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(extractJson(text)) as Record<string, unknown>;
  } catch {
    /* parseKkGroup already succeeded, so this cannot happen */
  }
  let tempo = Number(raw.tempo);
  if (!Number.isFinite(tempo)) tempo = 120;
  const clamped = Math.min(300, Math.max(20, tempo));
  if (clamped !== tempo) warnings.push(`Tempo ${tempo} out of range 20–300 — clamped.`);
  tempo = clamped;

  const groups = parseGroups(raw.groups, modules, warnings);

  return {
    ok: true,
    errors: [],
    warnings,
    project: {
      name: base.patch.name === 'AI Patch' ? 'AI Project' : base.patch.name,
      tempo,
      modules,
      wires: base.patch.wires,
      groups,
    },
  };
}

/**
 * Validate the nested group list. Bad references are dropped with warnings;
 * a module/group claimed by two parents stays with the first; parent cycles
 * are broken by dropping the offending child link.
 */
function parseGroups(
  raw: unknown,
  modules: KkGroupModule[],
  warnings: string[],
): KkProjectGroup[] {
  if (!Array.isArray(raw)) return [];
  const moduleIds = new Set(modules.map((m) => m.id));

  const groups: KkProjectGroup[] = [];
  const byId = new Map<string, KkProjectGroup>();
  (raw as Array<Record<string, unknown>>).forEach((g, i) => {
    const id = typeof g.id === 'string' && g.id ? g.id : `group${i}`;
    if (byId.has(id)) {
      warnings.push(`Duplicate group id "${id}" — dropped.`);
      return;
    }
    const group: KkProjectGroup = {
      id,
      name: typeof g.name === 'string' && g.name.trim() ? g.name.trim() : `Group ${i + 1}`,
      moduleIds: Array.isArray(g.modules) ? (g.modules as unknown[]).map(String) : [],
      groupIds: Array.isArray(g.groups) ? (g.groups as unknown[]).map(String) : [],
      collapsed: g.collapsed !== false,
    };
    byId.set(id, group);
    groups.push(group);
  });

  // Module refs: must exist, one parent each.
  const moduleOwner = new Map<string, string>();
  for (const g of groups) {
    g.moduleIds = g.moduleIds.filter((mid) => {
      if (!moduleIds.has(mid)) {
        warnings.push(`Group "${g.id}": module "${mid}" not in this project — dropped.`);
        return false;
      }
      const owner = moduleOwner.get(mid);
      if (owner) {
        warnings.push(`Module "${mid}" is in groups "${owner}" and "${g.id}" — kept in "${owner}".`);
        return false;
      }
      moduleOwner.set(mid, g.id);
      return true;
    });
  }

  // Child-group refs: must exist, one parent each, no self/cycles.
  const groupOwner = new Map<string, string>();
  for (const g of groups) {
    g.groupIds = g.groupIds.filter((cid) => {
      if (cid === g.id || !byId.has(cid)) {
        warnings.push(`Group "${g.id}": child group "${cid}" invalid — dropped.`);
        return false;
      }
      const owner = groupOwner.get(cid);
      if (owner) {
        warnings.push(`Group "${cid}" is in groups "${owner}" and "${g.id}" — kept in "${owner}".`);
        return false;
      }
      groupOwner.set(cid, g.id);
      return true;
    });
  }
  // Cycle check: walk up from each group; a repeat means a parent loop.
  for (const g of groups) {
    const seen = new Set<string>([g.id]);
    let parent = groupOwner.get(g.id);
    while (parent) {
      if (seen.has(parent)) {
        const p = byId.get(parent)!;
        p.groupIds = p.groupIds.filter((c) => !seen.has(c));
        for (const c of seen) groupOwner.delete(c);
        warnings.push(`Group nesting cycle involving "${g.id}" — broken.`);
        break;
      }
      seen.add(parent);
      parent = groupOwner.get(parent);
    }
  }

  return groups;
}
