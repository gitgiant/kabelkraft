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
    { id: 'pitchMod', label: 'Pitch Mod', type: 'control', direction: 'in', description: 'Pitch modulation input (vibrato); range set by PM Amt.' },
    { id: 'out', label: 'Audio', type: 'audio', direction: 'out', description: 'Synthesized audio output (stereo).' },
  ],
  params: [
    { id: 'waveform', label: 'Wave', min: 0, max: WAVEFORMS.length - 1, default: 3, options: [...WAVEFORMS], randomizable: true },
    { id: 'octave', label: 'Octave', min: -3, max: 3, default: 0, randomizable: true },
    { id: 'attack', label: 'Attack', min: 0.001, max: 4, default: 0.01, unit: 's', curve: 'exp', randomizable: true },
    { id: 'decay', label: 'Decay', min: 0.001, max: 4, default: 0.15, unit: 's', curve: 'exp', randomizable: true },
    { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 0.7, randomizable: true },
    { id: 'release', label: 'Release', min: 0.001, max: 8, default: 0.3, unit: 's', curve: 'exp', randomizable: true },
    { id: 'pmAmt', label: 'PM Amt', min: 0, max: 12, default: 2, unit: 'semitones', randomizable: true },
    { id: 'level', label: 'Level', min: 0, max: 1, default: 0.8, randomizable: false },
  ],
  width: 220,
  height: 200,
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

const delay: ModuleDef = {
  type: 'delay',
  name: 'Delay',
  category: 'effect',
  description: 'Echo effect: delay time, feedback, dry/wet mix.',
  ports: [audioIn(), audioOutPort()],
  params: [
    { id: 'time', label: 'Time', min: 1, max: 1500, default: 350, unit: 'ms', curve: 'exp', randomizable: true },
    { id: 'feedback', label: 'Feedback', min: 0, max: 0.95, default: 0.4, randomizable: true },
    { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.35, randomizable: true },
  ],
  width: 190,
  height: 110,
};

const reverb: ModuleDef = {
  type: 'reverb',
  name: 'Reverb',
  category: 'effect',
  description: 'Room reverb (Freeverb-style): size, damping, dry/wet mix.',
  ports: [audioIn(), audioOutPort()],
  params: [
    { id: 'size', label: 'Size', min: 0, max: 1, default: 0.5, randomizable: true },
    { id: 'damp', label: 'Damp', min: 0, max: 1, default: 0.5, randomizable: true },
    { id: 'mix', label: 'Mix', min: 0, max: 1, default: 0.3, randomizable: true },
  ],
  width: 190,
  height: 110,
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
  ],
  width: 190,
  height: 150,
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
  ],
  width: 200,
  height: 170,
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
    transport, sequencer, lfo, adsr, random, synth, sampler, keyboard,
    delay, reverb, distortion, eq,
    mixer, recorder, audioOut, levels,
  ].map((d) => [d.type, d]),
);
