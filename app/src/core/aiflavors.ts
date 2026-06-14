/**
 * AI flavor catalog — the seven generation flavors and the optional context
 * inputs each one can feed the model. Drives the Options → AI input-config UI
 * and the per-input gating at every generate call site (aiInputEnabled).
 *
 * Only OPTIONAL, automatic context inputs live here — the things the app adds
 * silently around the user's prompt (canvas state, transport, the current
 * design being edited). Each flavor's core spec and any REQUIRED live dump
 * (a face/preset target's modules) are never toggleable; they always ride.
 */

import { appSettings, updateSettings } from './settings';

export type AiFlavorId = 'patch' | 'project' | 'visual' | 'face' | 'preset' | 'midi' | 'lyrics';

export interface AiInputDef {
  /** Stable id, unique within the flavor; the settings key. */
  id: string;
  label: string;
  description: string;
  /** Included unless the user turns it off. */
  default: boolean;
}

export interface AiFlavorDef {
  id: AiFlavorId;
  name: string;
  /** One-line description of what the flavor writes. */
  description: string;
  /** Toggleable optional context inputs (may be empty). */
  inputs: AiInputDef[];
}

export const AI_FLAVORS: AiFlavorDef[] = [
  {
    id: 'patch',
    name: 'Patch',
    description: 'Builds a self-contained instrument/effect group (modules + wires) from scratch.',
    inputs: [
      {
        id: 'canvas',
        label: 'Canvas summary',
        description: 'A count of the modules already on the canvas. Rarely useful — a patch is self-contained.',
        default: false,
      },
      {
        id: 'groupConfig',
        label: 'Existing group config',
        description: 'When editing an existing group, sends its full current modules/wires/face so the model tweaks instead of starting blank.',
        default: true,
      },
    ],
  },
  {
    id: 'project',
    name: 'Project',
    description: 'Writes a whole project — instruments, effects, mixer, nested groups, and embedded clips.',
    inputs: [
      {
        id: 'canvas',
        label: 'Canvas summary',
        description: 'A count of the modules already on the canvas.',
        default: false,
      },
    ],
  },
  {
    id: 'visual',
    name: 'Visualizer',
    description: 'Designs a visual node graph for a visualizer container.',
    inputs: [
      {
        id: 'container',
        label: 'Container state',
        description: 'Which container poles are wired (audio/notes/text/…) and the current visual graph, so edits build on what exists.',
        default: true,
      },
    ],
  },
  {
    id: 'face',
    name: 'Face',
    description: 'Designs a front panel (knobs/sliders/meters) for an existing group. Always sees that group’s modules.',
    inputs: [],
  },
  {
    id: 'preset',
    name: 'Preset',
    description: 'Retunes (and, for a container, rewires) an existing target. Always sees its modules, values, and wiring.',
    inputs: [],
  },
  {
    id: 'midi',
    name: 'MIDI clip',
    description: 'Writes a piano-roll clip for a Composer module.',
    inputs: [
      {
        id: 'transport',
        label: 'Transport',
        description: 'Song tempo, time signature, and this clip’s loop length, so the clip fits the song.',
        default: true,
      },
      {
        id: 'targetInstrument',
        label: 'Target instrument',
        description: 'What the clip feeds downstream — a melodic voice, or a drum kit with its exact trigger pitches.',
        default: true,
      },
      {
        id: 'existingNotes',
        label: 'Existing notes',
        description: 'Sends the clip’s current notes and asks the model to variate on them. (Per-clip checkbox defaults to this.)',
        default: false,
      },
      {
        id: 'canvas',
        label: 'Canvas summary',
        description: 'A count of the modules on the canvas.',
        default: false,
      },
    ],
  },
  {
    id: 'lyrics',
    name: 'Lyrics',
    description: 'Writes timed, song-absolute lyrics for the Lyrics module.',
    inputs: [
      {
        id: 'songContext',
        label: 'Song context',
        description: 'Tempo and time signature, so the model can lay lines out in bars.',
        default: true,
      },
      {
        id: 'songLength',
        label: 'Song length',
        description: 'A target song length (derived from the longest clip) so verse/chorus pacing fits the arrangement.',
        default: true,
      },
    ],
  },
];

const FLAVOR_BY_ID = new Map(AI_FLAVORS.map((f) => [f.id, f]));

/** Default-enabled map for one flavor, from the registry. */
function defaultsFor(flavor: AiFlavorId): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const inp of FLAVOR_BY_ID.get(flavor)?.inputs ?? []) out[inp.id] = inp.default;
  return out;
}

/**
 * Is an optional input enabled for a flavor? Honors the user's stored override,
 * falling back to the registry default. Unknown ids default false.
 */
export function aiInputEnabled(flavor: AiFlavorId, input: string): boolean {
  const stored = appSettings().ai.inputs?.[flavor]?.[input];
  if (typeof stored === 'boolean') return stored;
  const def = FLAVOR_BY_ID.get(flavor)?.inputs.find((i) => i.id === input);
  return def?.default ?? false;
}

/** Persist one input toggle. */
export function setAiInputEnabled(flavor: AiFlavorId, input: string, enabled: boolean): void {
  updateSettings((s) => {
    const all = (s.ai.inputs ??= {});
    const f = (all[flavor] ??= { ...defaultsFor(flavor) });
    f[input] = enabled;
  });
}
