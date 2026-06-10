/**
 * Built-in module definitions — Phase 0 set (PRD §17):
 * Master Transport, Synth (classic), Keyboard, Audio Out, Levels.
 */

import type { ModuleDef } from './module';
import { defaultDrumPads, defaultDrumPattern } from './drumkit';

export {
  DRUM_BASE_NOTE,
  DRUM_DECAY_MAX,
  DRUM_PADS,
  DRUM_STEPS,
  type DrumPad,
  type DrumStep,
} from './drumkit';

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

export const SYNTH_MODES = ['classic', 'wavetable', 'fm'] as const;
export const FILTER_TYPES = ['off', 'LP', 'HP', 'BP'] as const;
export const FM_ALGO_COUNT = 6;

const synth: ModuleDef = {
  type: 'synth',
  name: 'Synth',
  category: 'generator',
  description:
    'Polyphonic synthesizer with three modes (PRD §8.2): classic (2 osc + detune, PWM), ' +
    'wavetable (loadable table, position scan), FM (4 operators, 6 algorithms). ' +
    'Multimode filter with its own ADSR, glide, 1–16 voices.',
  ports: [
    { id: 'notes', label: 'Notes', type: 'note', direction: 'in', description: 'Note input controlling the voices.' },
    { id: 'pitchMod', label: 'Pitch Mod', type: 'control', direction: 'in', description: 'Pitch modulation input (vibrato); range set by PM Amt.' },
    { id: 'cutoffMod', label: 'Cutoff Mod', type: 'control', direction: 'in', description: 'Filter cutoff modulation, ±3 octaves around the Cutoff param.' },
    { id: 'posMod', label: 'Pos Mod', type: 'control', direction: 'in', description: 'Wavetable position (wavetable mode) / FM modulation depth scale (FM mode).' },
    { id: 'out', label: 'Audio', type: 'audio', direction: 'out', description: 'Synthesized audio output (stereo).' },
  ],
  params: [
    // -- shared -------------------------------------------------------------
    { id: 'mode', label: 'Mode', min: 0, max: SYNTH_MODES.length - 1, default: 0, options: [...SYNTH_MODES], randomizable: false },
    { id: 'voices', label: 'Voices', min: 1, max: 16, default: 8, randomizable: false },
    { id: 'octave', label: 'Octave', min: -3, max: 3, default: 0, randomizable: true },
    { id: 'coarse', label: 'Coarse', min: -12, max: 12, default: 0, unit: 'st', randomizable: true },
    { id: 'fine', label: 'Fine', min: -100, max: 100, default: 0, unit: 'ct', randomizable: true },
    { id: 'glide', label: 'Glide', min: 0, max: 1, default: 0, unit: 's', randomizable: true },
    { id: 'level', label: 'Level', min: 0, max: 1, default: 0.8, randomizable: false },
    { id: 'attack', label: 'Attack', min: 0.001, max: 4, default: 0.01, unit: 's', curve: 'exp', randomizable: true },
    { id: 'decay', label: 'Decay', min: 0.001, max: 4, default: 0.15, unit: 's', curve: 'exp', randomizable: true },
    { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 0.7, randomizable: true },
    { id: 'release', label: 'Release', min: 0.001, max: 8, default: 0.3, unit: 's', curve: 'exp', randomizable: true },
    { id: 'pmAmt', label: 'PM Amt', min: 0, max: 12, default: 2, unit: 'semitones', randomizable: true },
    // -- filter (multimode + own ADSR, PRD §8.2) ------------------------------
    { id: 'fType', label: 'Filter', min: 0, max: FILTER_TYPES.length - 1, default: 0, options: [...FILTER_TYPES], randomizable: true },
    { id: 'cutoff', label: 'Cutoff', min: 40, max: 16000, default: 8000, unit: 'Hz', curve: 'exp', randomizable: true },
    { id: 'res', label: 'Res', min: 0, max: 0.95, default: 0.2, randomizable: true },
    { id: 'fAmt', label: 'F Amt', min: -1, max: 1, default: 0, randomizable: true },
    { id: 'fAttack', label: 'F Atk', min: 0.001, max: 4, default: 0.01, unit: 's', curve: 'exp', randomizable: true },
    { id: 'fDecay', label: 'F Dec', min: 0.001, max: 4, default: 0.2, unit: 's', curve: 'exp', randomizable: true },
    { id: 'fSustain', label: 'F Sus', min: 0, max: 1, default: 0.5, randomizable: true },
    { id: 'fRelease', label: 'F Rel', min: 0.001, max: 8, default: 0.3, unit: 's', curve: 'exp', randomizable: true },
    // -- classic: 2 osc + detune, square PWM ---------------------------------
    { id: 'waveform', label: 'Wave 1', min: 0, max: WAVEFORMS.length - 1, default: 3, options: [...WAVEFORMS], group: 'classic', randomizable: true },
    { id: 'wave2', label: 'Wave 2', min: 0, max: WAVEFORMS.length - 1, default: 3, options: [...WAVEFORMS], group: 'classic', randomizable: true },
    { id: 'detune', label: 'Detune', min: 0, max: 50, default: 8, unit: 'ct', group: 'classic', randomizable: true },
    { id: 'oscMix', label: 'Osc Mix', min: 0, max: 1, default: 0.3, group: 'classic', randomizable: true },
    { id: 'pwm', label: 'PWM', min: 0.05, max: 0.95, default: 0.5, group: 'classic', randomizable: true },
    // -- wavetable -----------------------------------------------------------
    { id: 'wtPos', label: 'Position', min: 0, max: 1, default: 0, group: 'wavetable', randomizable: true },
    // -- FM: 4 operators, algorithm select -----------------------------------
    { id: 'algo', label: 'Algo', min: 0, max: FM_ALGO_COUNT - 1, default: 0, options: ['1', '2', '3', '4', '5', '6'], group: 'fm', randomizable: true },
    { id: 'fmFb', label: 'Op4 FB', min: 0, max: 1, default: 0, group: 'fm', randomizable: true },
    { id: 'r1', label: 'Ratio 1', min: 0.5, max: 12, default: 1, group: 'fm', randomizable: true },
    { id: 'l1', label: 'Level 1', min: 0, max: 1, default: 1, group: 'fm', randomizable: true },
    { id: 'r2', label: 'Ratio 2', min: 0.5, max: 12, default: 2, group: 'fm', randomizable: true },
    { id: 'l2', label: 'Level 2', min: 0, max: 1, default: 0.5, group: 'fm', randomizable: true },
    { id: 'r3', label: 'Ratio 3', min: 0.5, max: 12, default: 1, group: 'fm', randomizable: true },
    { id: 'l3', label: 'Level 3', min: 0, max: 1, default: 0, group: 'fm', randomizable: true },
    { id: 'r4', label: 'Ratio 4', min: 0.5, max: 12, default: 1, group: 'fm', randomizable: true },
    { id: 'l4', label: 'Level 4', min: 0, max: 1, default: 0, group: 'fm', randomizable: true },
  ],
  width: 400,
  height: 350,
  defaultData: () => ({ sampleName: '' }),
};

export const ARP_MODES = ['up', 'down', 'up-down', 'random', 'as-played'] as const;
export const ARP_DIVISIONS = ['1/4', '1/8', '1/16', '1/32'] as const;

const arp: ModuleDef = {
  type: 'arp',
  name: 'Arpeggiator',
  category: 'data',
  description:
    'Arpeggiates held notes (PRD §8.3): up/down/up-down/random/as-played, octave range, ' +
    'synced rate, gate length, latch. Free-runs at the master tempo when the transport is stopped.',
  ports: [
    { id: 'notes', label: 'Notes', type: 'note', direction: 'in', description: 'Held chord to arpeggiate.' },
    { id: 'out', label: 'Notes', type: 'note', direction: 'out', description: 'Arpeggiated note stream.' },
  ],
  params: [
    { id: 'mode', label: 'Mode', min: 0, max: ARP_MODES.length - 1, default: 0, options: [...ARP_MODES], randomizable: true },
    { id: 'octaves', label: 'Octaves', min: 1, max: 4, default: 1, randomizable: true },
    { id: 'division', label: 'Rate', min: 0, max: ARP_DIVISIONS.length - 1, default: 2, options: [...ARP_DIVISIONS], randomizable: true },
    { id: 'gate', label: 'Gate', min: 0.05, max: 1, default: 0.6, randomizable: true },
    { id: 'latch', label: 'Latch', min: 0, max: 1, default: 0, options: ['off', 'on'], randomizable: false },
  ],
  width: 200,
  height: 150,
};

const sampler: ModuleDef = {
  type: 'sampler',
  name: 'Sampler',
  category: 'generator',
  description:
    'Plays a loaded sample pitched by incoming notes. Root note maps the sample to the keyboard; one-shot or loop.',
  ports: [
    { id: 'notes', label: 'Notes', type: 'note', direction: 'in', description: 'Note input controlling sample playback.' },
    { id: 'out', label: 'Audio', type: 'audio', direction: 'out', description: 'Sample audio output (stereo).' },
  ],
  params: [
    { id: 'root', label: 'Root', min: 24, max: 96, default: 60, randomizable: false },
    { id: 'mode', label: 'Mode', min: 0, max: 1, default: 0, options: ['one-shot', 'loop'], randomizable: false },
    { id: 'attack', label: 'Attack', min: 0.001, max: 4, default: 0.005, unit: 's', curve: 'exp', randomizable: true },
    { id: 'decay', label: 'Decay', min: 0.001, max: 4, default: 0.1, unit: 's', curve: 'exp', randomizable: true },
    { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 1, randomizable: true },
    { id: 'release', label: 'Release', min: 0.001, max: 8, default: 0.2, unit: 's', curve: 'exp', randomizable: true },
    { id: 'level', label: 'Level', min: 0, max: 1, default: 0.8, randomizable: false },
  ],
  width: 230,
  height: 260,
  defaultData: () => ({ sampleName: '' }),
};

export const DRUM_DIVISIONS = ['1/8', '1/16', '1/32'] as const;

const drum: ModuleDef = {
  type: 'drum',
  name: 'Drum Machine',
  category: 'generator',
  description:
    '16-pad drum machine with built-in step sequencer (velocity, swing) synced to the transport. ' +
    'Click a pad to select and audition it; the step row edits the selected pad.',
  ports: [
    {
      id: 'notes',
      label: 'Notes',
      type: 'note',
      direction: 'in',
      description: 'External pad triggers: notes from C1 (36) upward map to pads 1–16.',
    },
    { id: 'out', label: 'Audio', type: 'audio', direction: 'out', description: 'Master drum output (stereo).' },
  ],
  params: [
    { id: 'division', label: 'Division', min: 0, max: DRUM_DIVISIONS.length - 1, default: 1, options: [...DRUM_DIVISIONS], randomizable: false },
    { id: 'swing', label: 'Swing', min: 0, max: 0.6, default: 0, randomizable: true },
    { id: 'level', label: 'Level', min: 0, max: 1, default: 0.8, randomizable: false },
  ],
  width: 380,
  height: 300,
  defaultData: () => ({
    pads: defaultDrumPads(),
    pattern: defaultDrumPattern(),
  }),
};

export const LFO_SHAPES = ['sine', 'triangle', 'square', 'sawtooth', 's&h'] as const;

const lfo: ModuleDef = {
  type: 'lfo',
  name: 'LFO',
  category: 'data',
  description: 'Low-frequency oscillator outputting a control signal: shape, rate, depth, offset.',
  ports: [
    { id: 'out', label: 'Control', type: 'control', direction: 'out', description: 'Control signal 0.0–1.0.' },
  ],
  params: [
    { id: 'shape', label: 'Shape', min: 0, max: LFO_SHAPES.length - 1, default: 0, options: [...LFO_SHAPES], randomizable: true },
    { id: 'rate', label: 'Rate', min: 0.01, max: 20, default: 2, unit: 'Hz', curve: 'exp', randomizable: true },
    { id: 'depth', label: 'Depth', min: 0, max: 1, default: 0.5, randomizable: true },
    { id: 'offset', label: 'Offset', min: 0, max: 1, default: 0.5, randomizable: true },
  ],
  width: 180,
  height: 130,
};

export interface SeqStep {
  on: boolean;
  /** MIDI pitch. */
  pitch: number;
}

export const SEQ_STEPS = 16;
export const SEQ_PITCH_MIN = 36;
export const SEQ_PITCH_MAX = 84;

const sequencer: ModuleDef = {
  type: 'sequencer',
  name: 'Sequencer',
  category: 'data',
  description:
    'Step sequencer synced to the Master Transport. Click a step to toggle, drag vertically to set pitch.',
  ports: [
    { id: 'notes', label: 'Notes', type: 'note', direction: 'out', description: 'Sequenced notes while the transport plays.' },
  ],
  params: [
    { id: 'division', label: 'Division', min: 0, max: 2, default: 2, options: ['1/4', '1/8', '1/16'], randomizable: false },
    { id: 'gate', label: 'Gate', min: 0.05, max: 1, default: 0.5, randomizable: true },
  ],
  width: 340,
  height: 160,
  defaultData: () => ({
    // A minor-ish default pattern so play immediately sounds musical.
    steps: [57, 0, 60, 0, 64, 0, 60, 0, 57, 0, 60, 0, 64, 67, 64, 60].map((p) => ({
      on: p > 0,
      pitch: p || 60,
    })) satisfies SeqStep[],
  }),
};

export const MIDI_CHANNELS = ['omni', ...Array.from({ length: 16 }, (_, i) => `${i + 1}`)] as const;

const midiIn: ModuleDef = {
  type: 'midiIn',
  name: 'MIDI In',
  category: 'controller',
  description:
    'Hardware/virtual MIDI input (PRD §8.7): channel filter, notes out, one CC mapped to a ' +
    'control output, optional MIDI-clock tempo sync. Click the device row to pick a port.',
  ports: [
    { id: 'notes', label: 'Notes', type: 'note', direction: 'out', description: 'Incoming MIDI notes as a polyphonic stream.' },
    { id: 'cc', label: 'CC', type: 'control', direction: 'out', description: 'The selected CC number, scaled 0–1.' },
  ],
  params: [
    { id: 'channel', label: 'Channel', min: 0, max: 16, default: 0, options: [...MIDI_CHANNELS], randomizable: false },
    { id: 'cc', label: 'CC #', min: 0, max: 127, default: 1, randomizable: false },
    { id: 'clock', label: 'Clock sync', min: 0, max: 1, default: 0, options: ['off', 'on'], randomizable: false },
  ],
  width: 230,
  height: 150,
  defaultData: () => ({ deviceId: '', deviceName: 'all inputs' }),
};

const midiOut: ModuleDef = {
  type: 'midiOut',
  name: 'MIDI Out',
  category: 'io',
  description:
    'Sends notes and a control input as MIDI to a hardware/virtual output port (PRD §8.7).',
  ports: [
    { id: 'notes', label: 'Notes', type: 'note', direction: 'in', description: 'Notes to send as MIDI note on/off.' },
    { id: 'cc', label: 'CC', type: 'control', direction: 'in', description: 'Control 0–1 sent as the selected CC number.' },
  ],
  params: [
    { id: 'channel', label: 'Channel', min: 1, max: 16, default: 1, randomizable: false },
    { id: 'cc', label: 'CC #', min: 0, max: 127, default: 1, randomizable: false },
  ],
  width: 230,
  height: 130,
  defaultData: () => ({ deviceId: '', deviceName: 'first output' }),
};

export const COMPOSER_TRACKS = 4;
export const COMPOSER_PATTERNS = 8;
export const COMPOSER_SLOTS = 16;
export const COMPOSER_PATTERN_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;

function defaultComposerData(): Record<string, unknown> {
  const patterns = Array.from({ length: COMPOSER_PATTERNS }, () =>
    Array.from({ length: COMPOSER_TRACKS }, () =>
      Array.from({ length: 16 }, () => ({ on: false, pitch: 60 })),
    ),
  );
  // Pattern A, track 1: a simple arp so the default song makes sound at once.
  [57, 60, 64, 60].forEach((pitch, i) => {
    patterns[0][0][i * 4] = { on: true, pitch };
  });
  const song = Array.from({ length: COMPOSER_SLOTS }, () => -1);
  song[0] = 0;
  song[1] = 0;
  return { patterns, song };
}

const composer: ModuleDef = {
  type: 'composer',
  name: 'Composer',
  category: 'data',
  description:
    'Pattern bank + song arrangement (PRD §8.3): 8 patterns × 4 tracks × 16 steps, ordered into ' +
    'a song that follows the Master Transport. One bar per slot; each track has its own Note output.',
  ports: [
    { id: 'out1', label: 'T1', type: 'note', direction: 'out', description: 'Track 1 note stream.' },
    { id: 'out2', label: 'T2', type: 'note', direction: 'out', description: 'Track 2 note stream.' },
    { id: 'out3', label: 'T3', type: 'note', direction: 'out', description: 'Track 3 note stream.' },
    { id: 'out4', label: 'T4', type: 'note', direction: 'out', description: 'Track 4 note stream.' },
  ],
  params: [
    { id: 'gate', label: 'Gate', min: 0.05, max: 1, default: 0.5, randomizable: true },
  ],
  width: 400,
  height: 264,
  defaultData: defaultComposerData,
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

export const VIS_SCENES = ['scope', 'spectrum', 'particles'] as const;

const visualizer: ModuleDef = {
  type: 'visualizer',
  name: 'Visualizer',
  category: 'visual',
  description:
    'Audio-reactive graphics (PRD §8.5): oscilloscope, spectrum or particles. Notes spawn ' +
    'particle bursts; the Mod input modulates intensity. ⛶ opens the big view (fullscreen-able).',
  ports: [
    { id: 'in', label: 'Audio', type: 'audio', direction: 'in', description: 'Audio to visualize; multiple wires are summed.' },
    { id: 'notes', label: 'Notes', type: 'note', direction: 'in', description: 'Note events spawn particles / flashes.' },
    { id: 'mod', label: 'Mod', type: 'control', direction: 'in', description: 'Modulates scene intensity (0–1).' },
  ],
  params: [
    { id: 'scene', label: 'Scene', min: 0, max: VIS_SCENES.length - 1, default: 0, options: [...VIS_SCENES], randomizable: true },
    { id: 'gain', label: 'Gain', min: 0.5, max: 4, default: 1.5, randomizable: true },
  ],
  width: 280,
  height: 220,
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

const adsr: ModuleDef = {
  type: 'adsr',
  name: 'ADSR',
  category: 'data',
  description:
    'Envelope as a control signal: gated by incoming notes, modulates anything with a control input.',
  ports: [
    { id: 'notes', label: 'Gate', type: 'note', direction: 'in', description: 'Notes gate the envelope (note on = attack, note off = release).' },
    { id: 'out', label: 'Control', type: 'control', direction: 'out', description: 'Envelope value 0.0–1.0.' },
  ],
  params: [
    { id: 'attack', label: 'Attack', min: 0.001, max: 4, default: 0.05, unit: 's', curve: 'exp', randomizable: true },
    { id: 'decay', label: 'Decay', min: 0.001, max: 4, default: 0.2, unit: 's', curve: 'exp', randomizable: true },
    { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 0.6, randomizable: true },
    { id: 'release', label: 'Release', min: 0.001, max: 8, default: 0.3, unit: 's', curve: 'exp', randomizable: true },
  ],
  width: 180,
  height: 130,
};

export const RANDOM_MODES = ['walk', 's&h'] as const;

const random: ModuleDef = {
  type: 'random',
  name: 'Random',
  category: 'data',
  description: 'Random control source: smooth random walk or stepped sample-and-hold.',
  ports: [
    { id: 'out', label: 'Control', type: 'control', direction: 'out', description: 'Random control signal 0.0–1.0.' },
  ],
  params: [
    { id: 'mode', label: 'Mode', min: 0, max: RANDOM_MODES.length - 1, default: 0, options: [...RANDOM_MODES], randomizable: true },
    { id: 'rate', label: 'Rate', min: 0.01, max: 20, default: 1, unit: 'Hz', curve: 'exp', randomizable: true },
    { id: 'depth', label: 'Depth', min: 0, max: 1, default: 0.5, randomizable: true },
    { id: 'offset', label: 'Offset', min: 0, max: 1, default: 0.5, randomizable: true },
  ],
  width: 180,
  height: 130,
};

const recorder: ModuleDef = {
  type: 'recorder',
  name: 'Recorder',
  category: 'io',
  description: 'Records incoming audio; stopping downloads a WAV file (PRD §8.7).',
  ports: [
    { id: 'in', label: 'Audio', type: 'audio', direction: 'in', description: 'Audio to record; multiple wires are summed.' },
  ],
  params: [],
  width: 190,
  height: 120,
};

export const DIST_ALGOS = ['soft', 'hard', 'tube', 'fold'] as const;

const audioIn = (desc = 'Audio input; multiple wires are summed.'): import('./module').PortSpec => ({
  id: 'in', label: 'Audio', type: 'audio', direction: 'in', description: desc,
});
const audioOutPort = (desc = 'Processed audio output.'): import('./module').PortSpec => ({
  id: 'out', label: 'Audio', type: 'audio', direction: 'out', description: desc,
});

const bypassParam = (): import('./module').ParamSpec => ({
  id: 'bypass', label: 'Bypass', min: 0, max: 1, default: 0, options: ['off', 'on'], randomizable: false,
});

export const DELAY_SYNCS = ['off', '1/16', '1/8', '1/8.', '1/4', '1/4.', '1/2'] as const;

const delay: ModuleDef = {
  type: 'delay',
  name: 'Delay',
  category: 'effect',
  description:
    'Echo: free (ms) or tempo-synced time, ping-pong stereo, tone filter in the feedback path.',
  ports: [audioIn(), audioOutPort()],
  params: [
    { id: 'sync', label: 'Sync', min: 0, max: DELAY_SYNCS.length - 1, default: 0, options: [...DELAY_SYNCS], randomizable: true },
    { id: 'time', label: 'Time', min: 1, max: 1500, default: 350, unit: 'ms', curve: 'exp', randomizable: true },
    { id: 'feedback', label: 'Feedback', min: 0, max: 0.95, default: 0.4, randomizable: true },
    { id: 'tone', label: 'Tone', min: 500, max: 16000, default: 16000, unit: 'Hz', curve: 'exp', randomizable: true },
    { id: 'pingpong', label: 'Ping-pong', min: 0, max: 1, default: 0, options: ['off', 'on'], randomizable: true },
    { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.35, randomizable: true },
    bypassParam(),
  ],
  width: 200,
  height: 190,
};

export const PEQ_BANDS = 6;
export const PEQ_BAND_TYPES = ['peak', 'lo-shelf', 'hi-shelf', 'lo-cut', 'hi-cut'] as const;

function peqParams(): import('./module').ParamSpec[] {
  const defaults = [
    { freq: 80, type: 1 },
    { freq: 250, type: 0 },
    { freq: 800, type: 0 },
    { freq: 2500, type: 0 },
    { freq: 6000, type: 0 },
    { freq: 12000, type: 2 },
  ];
  const out: import('./module').ParamSpec[] = [];
  defaults.forEach((d, i) => {
    const n = i + 1;
    out.push(
      { id: `b${n}type`, label: `B${n} Type`, min: 0, max: PEQ_BAND_TYPES.length - 1, default: d.type, options: [...PEQ_BAND_TYPES], randomizable: false },
      { id: `b${n}freq`, label: `B${n} Freq`, min: 20, max: 20000, default: d.freq, unit: 'Hz', curve: 'exp', randomizable: true },
      { id: `b${n}gain`, label: `B${n} Gain`, min: -18, max: 18, default: 0, unit: 'dB', randomizable: true },
      { id: `b${n}q`, label: `B${n} Q`, min: 0.3, max: 8, default: 0.9, curve: 'exp', randomizable: true },
    );
  });
  out.push(bypassParam());
  return out;
}

const peq: ModuleDef = {
  type: 'peq',
  name: 'Parametric EQ',
  category: 'effect',
  description:
    '6-band parametric EQ. Drag a band dot: frequency/gain. Shift-drag: Q. Click: cycle band type. ' +
    'Live input spectrum renders behind the curve.',
  ports: [audioIn(), audioOutPort()],
  params: peqParams(),
  width: 340,
  height: 230,
  customFace: true,
};

const mbBand = (n: number, name: string): import('./module').ParamSpec[] => [
  { id: `t${n}`, label: `${name} Thr`, min: -60, max: 0, default: -24, unit: 'dB', randomizable: true },
  { id: `r${n}`, label: `${name} Ratio`, min: 1, max: 20, default: 3, curve: 'exp', randomizable: true },
  { id: `a${n}`, label: `${name} Atk`, min: 0.1, max: 100, default: 10, unit: 'ms', curve: 'exp', randomizable: true },
  { id: `rl${n}`, label: `${name} Rel`, min: 10, max: 1000, default: 150, unit: 'ms', curve: 'exp', randomizable: true },
  { id: `g${n}`, label: `${name} Gain`, min: -12, max: 12, default: 0, unit: 'dB', randomizable: false },
  { id: `s${n}`, label: `${name} Solo`, min: 0, max: 1, default: 0, options: ['off', 'on'], randomizable: false },
];

const mbcomp: ModuleDef = {
  type: 'mbcomp',
  name: 'Multiband Comp',
  category: 'effect',
  description:
    '3-band compressor: Linkwitz-Riley crossovers, per-band threshold/ratio/attack/release/gain ' +
    'and solo. Red bar shows the deepest band gain reduction.',
  ports: [audioIn(), audioOutPort()],
  params: [
    { id: 'xLo', label: 'X-over Lo', min: 60, max: 800, default: 200, unit: 'Hz', curve: 'exp', randomizable: false },
    { id: 'xHi', label: 'X-over Hi', min: 800, max: 8000, default: 2000, unit: 'Hz', curve: 'exp', randomizable: false },
    ...mbBand(1, 'Lo'),
    ...mbBand(2, 'Mid'),
    ...mbBand(3, 'Hi'),
    bypassParam(),
  ],
  width: 400,
  height: 260,
  twoColumn: true,
};

const chorus: ModuleDef = {
  type: 'chorus',
  name: 'Chorus',
  category: 'effect',
  description: 'Modulated multi-voice chorus: rate, depth, voices, stereo width, mix.',
  ports: [audioIn(), audioOutPort()],
  params: [
    { id: 'rate', label: 'Rate', min: 0.05, max: 5, default: 0.8, unit: 'Hz', curve: 'exp', randomizable: true },
    { id: 'depth', label: 'Depth', min: 0, max: 1, default: 0.5, randomizable: true },
    { id: 'voices', label: 'Voices', min: 1, max: 3, default: 2, randomizable: true },
    { id: 'width', label: 'Width', min: 0, max: 1, default: 0.7, randomizable: true },
    { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.4, randomizable: true },
    bypassParam(),
  ],
  width: 190,
  height: 170,
};

const flanger: ModuleDef = {
  type: 'flanger',
  name: 'Flanger',
  category: 'effect',
  description: 'Swept short delay with feedback: rate, depth, feedback, manual offset, mix.',
  ports: [audioIn(), audioOutPort()],
  params: [
    { id: 'rate', label: 'Rate', min: 0.05, max: 2, default: 0.25, unit: 'Hz', curve: 'exp', randomizable: true },
    { id: 'depth', label: 'Depth', min: 0, max: 1, default: 0.7, randomizable: true },
    { id: 'feedback', label: 'Feedback', min: 0, max: 0.9, default: 0.5, randomizable: true },
    { id: 'manual', label: 'Manual', min: 0.5, max: 8, default: 2, unit: 'ms', curve: 'exp', randomizable: true },
    { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.5, randomizable: true },
    bypassParam(),
  ],
  width: 190,
  height: 170,
};

const bitcrusher: ModuleDef = {
  type: 'bitcrusher',
  name: 'Bitcrusher',
  category: 'effect',
  description: 'Lo-fi: bit-depth reduction and sample-rate decimation.',
  ports: [audioIn(), audioOutPort()],
  params: [
    { id: 'bits', label: 'Bits', min: 1, max: 16, default: 8, randomizable: true },
    { id: 'down', label: 'Downsample', min: 1, max: 50, default: 4, curve: 'exp', randomizable: true },
    { id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, randomizable: true },
    bypassParam(),
  ],
  width: 190,
  height: 130,
};

const compressor: ModuleDef = {
  type: 'compressor',
  name: 'Compressor',
  category: 'effect',
  description:
    'Dynamics compressor with soft knee, makeup gain and an optional sidechain input. ' +
    'Red bar shows live gain reduction.',
  ports: [
    audioIn(),
    { id: 'sc', label: 'Sidechain', type: 'audio', direction: 'in', description: 'Optional detector input; unwired = the main input drives compression.' },
    audioOutPort(),
  ],
  params: [
    { id: 'threshold', label: 'Thresh', min: -60, max: 0, default: -24, unit: 'dB', randomizable: true },
    { id: 'ratio', label: 'Ratio', min: 1, max: 20, default: 4, curve: 'exp', randomizable: true },
    { id: 'attack', label: 'Attack', min: 0.1, max: 100, default: 10, unit: 'ms', curve: 'exp', randomizable: true },
    { id: 'release', label: 'Release', min: 10, max: 1000, default: 150, unit: 'ms', curve: 'exp', randomizable: true },
    { id: 'knee', label: 'Knee', min: 0, max: 24, default: 6, unit: 'dB', randomizable: true },
    { id: 'makeup', label: 'Makeup', min: 0, max: 24, default: 0, unit: 'dB', randomizable: false },
    bypassParam(),
  ],
  width: 200,
  height: 210,
};

const limiterFx: ModuleDef = {
  type: 'limiter',
  name: 'Limiter',
  category: 'effect',
  description:
    'Brickwall limiter with 5 ms lookahead: ceiling, release. Red bar shows gain reduction. ' +
    '(True-peak detection waits for the C++ core.)',
  ports: [audioIn(), audioOutPort()],
  params: [
    { id: 'ceiling', label: 'Ceiling', min: -24, max: 0, default: -0.3, unit: 'dB', randomizable: false },
    { id: 'release', label: 'Release', min: 10, max: 500, default: 80, unit: 'ms', curve: 'exp', randomizable: true },
    bypassParam(),
  ],
  width: 190,
  height: 130,
};

export const MODULATOR_MODES = ['ring', 'AM'] as const;

const modulator: ModuleDef = {
  type: 'modulator',
  name: 'Modulator',
  category: 'effect',
  description:
    'Ring / amplitude modulation against an internal sine carrier, or wire any audio into Carrier.',
  ports: [
    audioIn(),
    { id: 'carrier', label: 'Carrier', type: 'audio', direction: 'in', description: 'Optional carrier; unwired = internal sine at Freq.' },
    audioOutPort(),
  ],
  params: [
    { id: 'mode', label: 'Mode', min: 0, max: MODULATOR_MODES.length - 1, default: 0, options: [...MODULATOR_MODES], randomizable: true },
    { id: 'freq', label: 'Freq', min: 20, max: 2000, default: 440, unit: 'Hz', curve: 'exp', randomizable: true },
    { id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, randomizable: true },
    bypassParam(),
  ],
  width: 190,
  height: 150,
};

export const REVERB_ALGOS = ['room', 'hall', 'plate'] as const;

const reverb: ModuleDef = {
  type: 'reverb',
  name: 'Reverb',
  category: 'effect',
  description:
    'Freeverb-style reverb: room/hall/plate algorithms, size, decay, pre-delay, damping, ' +
    'diffusion, low/high cut on the wet path, dry/wet.',
  ports: [audioIn(), audioOutPort()],
  params: [
    { id: 'algo', label: 'Algo', min: 0, max: REVERB_ALGOS.length - 1, default: 0, options: [...REVERB_ALGOS], randomizable: true },
    { id: 'size', label: 'Size', min: 0, max: 1, default: 0.5, randomizable: true },
    { id: 'decay', label: 'Decay', min: 0, max: 1, default: 0.5, randomizable: true },
    { id: 'predelay', label: 'Pre-delay', min: 0, max: 200, default: 0, unit: 'ms', randomizable: true },
    { id: 'damp', label: 'Damp', min: 0, max: 1, default: 0.5, randomizable: true },
    { id: 'diffusion', label: 'Diffusion', min: 0, max: 1, default: 0.5, randomizable: true },
    { id: 'lowcut', label: 'Low Cut', min: 20, max: 1000, default: 20, unit: 'Hz', curve: 'exp', randomizable: true },
    { id: 'highcut', label: 'High Cut', min: 1000, max: 16000, default: 16000, unit: 'Hz', curve: 'exp', randomizable: true },
    { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.3, randomizable: true },
    bypassParam(),
  ],
  width: 200,
  height: 250,
};

const distortion: ModuleDef = {
  type: 'distortion',
  name: 'Distortion',
  category: 'effect',
  description: 'Waveshaping distortion: algorithm, drive, tone filter, output trim, mix.',
  ports: [audioIn(), audioOutPort()],
  params: [
    { id: 'algo', label: 'Algo', min: 0, max: DIST_ALGOS.length - 1, default: 0, options: [...DIST_ALGOS], randomizable: true },
    { id: 'drive', label: 'Drive', min: 1, max: 30, default: 6, curve: 'exp', randomizable: true },
    { id: 'tone', label: 'Tone', min: 500, max: 12000, default: 5000, unit: 'Hz', curve: 'exp', randomizable: true },
    { id: 'trim', label: 'Trim', min: 0, max: 1, default: 0.7, randomizable: false },
    { id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, randomizable: true },
    bypassParam(),
  ],
  width: 190,
  height: 170,
};

const eq: ModuleDef = {
  type: 'eq',
  name: 'Simple EQ',
  category: 'effect',
  description: '3-band EQ: low shelf, mid peak, high shelf — gain and frequency each.',
  ports: [audioIn(), audioOutPort()],
  params: [
    { id: 'lowGain', label: 'Low', min: -18, max: 18, default: 0, unit: 'dB', randomizable: true },
    { id: 'lowFreq', label: 'Low Freq', min: 40, max: 500, default: 120, unit: 'Hz', curve: 'exp', randomizable: true },
    { id: 'midGain', label: 'Mid', min: -18, max: 18, default: 0, unit: 'dB', randomizable: true },
    { id: 'midFreq', label: 'Mid Freq', min: 200, max: 5000, default: 1000, unit: 'Hz', curve: 'exp', randomizable: true },
    { id: 'highGain', label: 'High', min: -18, max: 18, default: 0, unit: 'dB', randomizable: true },
    { id: 'highFreq', label: 'High Freq', min: 2000, max: 16000, default: 8000, unit: 'Hz', curve: 'exp', randomizable: true },
    bypassParam(),
  ],
  width: 200,
  height: 190,
};

const mixer: ModuleDef = {
  type: 'mixer',
  name: 'Mixer',
  category: 'io',
  description: '4-channel stereo mixer: per-channel level and pan, master level.',
  ports: [
    { id: 'in1', label: 'In 1', type: 'audio', direction: 'in', description: 'Channel 1 input.' },
    { id: 'in2', label: 'In 2', type: 'audio', direction: 'in', description: 'Channel 2 input.' },
    { id: 'in3', label: 'In 3', type: 'audio', direction: 'in', description: 'Channel 3 input.' },
    { id: 'in4', label: 'In 4', type: 'audio', direction: 'in', description: 'Channel 4 input.' },
    audioOutPort('Mixed stereo output.'),
  ],
  params: [
    { id: 'lvl1', label: 'Lvl 1', min: 0, max: 1, default: 0.8, randomizable: false },
    { id: 'pan1', label: 'Pan 1', min: -1, max: 1, default: 0, randomizable: true },
    { id: 'lvl2', label: 'Lvl 2', min: 0, max: 1, default: 0.8, randomizable: false },
    { id: 'pan2', label: 'Pan 2', min: -1, max: 1, default: 0, randomizable: true },
    { id: 'lvl3', label: 'Lvl 3', min: 0, max: 1, default: 0.8, randomizable: false },
    { id: 'pan3', label: 'Pan 3', min: -1, max: 1, default: 0, randomizable: true },
    { id: 'lvl4', label: 'Lvl 4', min: 0, max: 1, default: 0.8, randomizable: false },
    { id: 'pan4', label: 'Pan 4', min: -1, max: 1, default: 0, randomizable: true },
    { id: 'master', label: 'Master', min: 0, max: 1, default: 0.8, randomizable: false },
  ],
  width: 210,
  height: 230,
};

export const MODULE_DEFS: Map<string, ModuleDef> = new Map(
  [
    transport, sequencer, arp, composer, lfo, adsr, random, synth, sampler, drum, keyboard, midiIn, midiOut,
    delay, reverb, distortion, eq, peq, chorus, flanger, bitcrusher, compressor, mbcomp, limiterFx, modulator,
    mixer, recorder, audioOut, levels, visualizer,
  ].map((d) => [d.type, d]),
);
