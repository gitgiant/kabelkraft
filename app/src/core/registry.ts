/**
 * Built-in module definitions — Phase 0 set (PRD §17):
 * Master Transport, Synth (classic), Keyboard, Audio Out, Levels.
 */

import type { ModuleDef } from './module';

export const WAVEFORMS = ['sine', 'triangle', 'square', 'sawtooth', 'noise'] as const;

const transport: ModuleDef = {
  type: 'transport',
  name: 'Master Transport',
  category: 'io',
  description:
    'Global tempo and play/stop/pause/rewind. Every tempo-aware module syncs to it by default.',
  ports: [
    {
      id: 'out',
      label: 'Transport',
      type: 'transport',
      direction: 'out',
      description: 'Explicit transport feed for advanced routing (implicit sync needs no wire).',
    },
  ],
  params: [
    { id: 'tempo', label: 'Tempo', min: 20, max: 300, default: 120, unit: 'BPM', randomizable: false },
  ],
  width: 200,
  height: 110,
};

const synth: ModuleDef = {
  type: 'synth',
  name: 'Synth',
  category: 'generator',
  description: 'Classic polyphonic synthesizer: waveform, octave, ADSR amplitude envelope.',
  ports: [
    { id: 'notes', label: 'Notes', type: 'note', direction: 'in', description: 'Note input controlling the voices.' },
    { id: 'out', label: 'Audio', type: 'audio', direction: 'out', description: 'Synthesized audio output (stereo).' },
  ],
  params: [
    { id: 'waveform', label: 'Wave', min: 0, max: WAVEFORMS.length - 1, default: 3, options: [...WAVEFORMS], randomizable: true },
    { id: 'octave', label: 'Octave', min: -3, max: 3, default: 0, randomizable: true },
    { id: 'attack', label: 'Attack', min: 0.001, max: 4, default: 0.01, unit: 's', curve: 'exp', randomizable: true },
    { id: 'decay', label: 'Decay', min: 0.001, max: 4, default: 0.15, unit: 's', curve: 'exp', randomizable: true },
    { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 0.7, randomizable: true },
    { id: 'release', label: 'Release', min: 0.001, max: 8, default: 0.3, unit: 's', curve: 'exp', randomizable: true },
    { id: 'level', label: 'Level', min: 0, max: 1, default: 0.8, randomizable: false },
  ],
  width: 220,
  height: 170,
};

const keyboard: ModuleDef = {
  type: 'keyboard',
  name: 'Keyboard',
  category: 'controller',
  description: 'On-screen piano keys; computer keyboard also plays (A–L row). Outputs notes.',
  ports: [
    { id: 'notes', label: 'Notes', type: 'note', direction: 'out', description: 'Played notes as a polyphonic stream.' },
  ],
  params: [
    { id: 'octave', label: 'Octave', min: -3, max: 3, default: 0, randomizable: true },
  ],
  width: 260,
  height: 120,
};

const audioOut: ModuleDef = {
  type: 'audioOut',
  name: 'Audio Out',
  category: 'io',
  description:
    'Routes audio to the output device. Brickwall safety limiter is ON by default (PRD §9.4).',
  ports: [
    { id: 'in', label: 'Audio', type: 'audio', direction: 'in', description: 'Audio to play; multiple wires are summed.' },
  ],
  params: [
    { id: 'level', label: 'Level', min: 0, max: 1, default: 0.8, randomizable: false },
    { id: 'limiter', label: 'Limiter', min: 0, max: 1, default: 1, options: ['off', 'on'], randomizable: false },
  ],
  width: 180,
  height: 110,
};

const levels: ModuleDef = {
  type: 'levels',
  name: 'Levels',
  category: 'visual',
  description: 'Peak/RMS meters with clip indicators (click to reset).',
  ports: [
    { id: 'in', label: 'Audio', type: 'audio', direction: 'in', description: 'Audio to meter; multiple wires are summed.' },
  ],
  params: [],
  width: 160,
  height: 120,
};

export const MODULE_DEFS: Map<string, ModuleDef> = new Map(
  [transport, synth, keyboard, audioOut, levels].map((d) => [d.type, d]),
);
