/**
 * Built-in module definitions — Phase 0 set (PRD §17):
 * Master Transport, Synth (classic), Keyboard, Audio Out, Levels.
 */

import type { ModuleDef } from './module';
import { defaultNote } from './composer';
import { ROOT_NAMES, SCALE_NAMES } from './scales';
import { initVisGraph } from '../visual/migrate';

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
  width: 220,
  height: 170,
};

export const SYNTH_MODES = ['classic', 'wavetable', 'fm'] as const;

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
  width: 240,
  height: 170,
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
  width: 240,
  height: 160,
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
    'Step sequencer synced to the Master Transport. Pitch grid: click a tile to set that ' +
    'step, click it again to clear, drag to paint; ▲▼ shift the octave window.',
  ports: [
    { id: 'notes', label: 'Notes', type: 'note', direction: 'out', description: 'Sequenced notes while the transport plays.' },
  ],
  params: [
    { id: 'division', label: 'Division', min: 0, max: 2, default: 2, options: ['1/4', '1/8', '1/16'], randomizable: false },
    { id: 'gate', label: 'Gate', min: 0.05, max: 1, default: 0.5, randomizable: true },
  ],
  width: 340,
  height: 260,
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
  width: 240,
  height: 170,
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
  width: 240,
  height: 150,
  defaultData: () => ({ deviceId: '', deviceName: 'first output' }),
};

function defaultComposerData(): Record<string, unknown> {
  // A two-bar phrase so the default clip makes sound at once.
  const notes = [57, 60, 64, 60, 57, 60, 65, 64].map((pitch, i) =>
    defaultNote(i, pitch, 0.75),
  );
  return { notes, length: 8 };
}

const composer: ModuleDef = {
  type: 'composer',
  name: 'Composer',
  category: 'data',
  description:
    'Piano-roll clip (PRD §8.3): free-time notes with per-note velocity, pan, release, mod X/Y ' +
    'and probability, looped against the Master Transport. Open the editor for the full roll ' +
    'with quantize/humanize tools and MIDI file import/export.',
  ports: [
    { id: 'notes', label: 'Notes', type: 'note', direction: 'out', description: 'Clip note stream while the transport plays.' },
  ],
  params: [],
  width: 320,
  height: 184,
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
  height: 200,
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
  width: 210,
  height: 170,
};

const visualizer: ModuleDef = {
  type: 'visualizer',
  name: 'Visualizer',
  category: 'visual',
  description:
    'Visual engine container (VISUALIZER_ENGINE_PLAN.md): holds a nested graph of visual ' +
    'nodes (spectrum, scope, particles…) fed by the audio/note/mod inputs. Starts as ' +
    'audio → Spectrum. ⛶ opens the big view (fullscreen-able).',
  ports: [
    { id: 'in', label: 'Audio', type: 'audio', direction: 'in', description: 'Audio to visualize; multiple wires are summed.' },
    { id: 'notes', label: 'Notes', type: 'note', direction: 'in', description: 'Note events spawn particles / flashes.' },
    { id: 'mod', label: 'Mod', type: 'control', direction: 'in', description: 'Modulates scene intensity (0–1).' },
    { id: 'text', label: 'Text', type: 'text', direction: 'in', description: 'Text stream for Text Layer nodes (lyrics, readouts); multiple wires merge.' },
    { id: 'vin', label: 'Vis In', type: 'visual', direction: 'in', description: 'Frame from another visualizer — appears inside as a Visual In node, for layering scenes.' },
    { id: 'vout', label: 'Vis Out', type: 'visual', direction: 'out', description: 'This visualizer’s rendered frame; chain it into another visualizer’s Vis In.' },
  ],
  params: [],
  customFace: true,
  defaultData: () => ({ graph: initVisGraph() }),
  width: 280,
  height: 280,
};

export const COLOR_MODES = ['rainbow', 'pulse', 'flash', 'random', 'spectrum', 'vu', 'breathe', 'strobe'] as const;
export const COLOR_SYNCS = ['off', '1/4', '1/2', '1 bar', '2 bars', '4 bars'] as const;

const colorgen: ModuleDef = {
  type: 'colorgen',
  name: 'Color Gen',
  category: 'visual',
  description:
    'Generates a live color from audio or a control signal — wire its Color output to a ' +
    'Knob/Slider/XY/Button color input (or bind face elements) so the UI moves with the music. ' +
    'Modes: rainbow (hue cycles), pulse (brightness follows level), flash (jumps to the flash ' +
    'color on hits), random (new color per hit/cycle), spectrum (hue = spectral centroid), ' +
    'vu (green→red by level), breathe (slow sine), strobe (hard blink). Click the swatches to ' +
    'pick base/flash colors.',
  ports: [
    { id: 'in', label: 'Audio', type: 'audio', direction: 'in', description: 'Audio to react to; multiple wires are summed.' },
    { id: 'mod', label: 'Mod', type: 'control', direction: 'in', description: 'Control input — drives level-reactive modes when no audio is wired.' },
    { id: 'out', label: 'Color', type: 'color', direction: 'out', description: 'Live RGB color; fan out to any number of color inputs.' },
  ],
  params: [
    { id: 'mode', label: 'Mode', min: 0, max: COLOR_MODES.length - 1, default: 0, options: [...COLOR_MODES], randomizable: true },
    { id: 'rate', label: 'Rate', min: 0.05, max: 8, default: 0.4, unit: 'Hz', curve: 'exp', randomizable: true },
    { id: 'sync', label: 'Sync', min: 0, max: COLOR_SYNCS.length - 1, default: 0, options: [...COLOR_SYNCS], randomizable: false },
    { id: 'hue', label: 'Hue', min: 0, max: 1, default: 0.6, randomizable: true },
    { id: 'sat', label: 'Sat', min: 0, max: 1, default: 0.85, randomizable: true },
    { id: 'hue2', label: 'Flash Hue', min: 0, max: 1, default: 0.02, randomizable: true },
    { id: 'depth', label: 'Depth', min: 0, max: 1, default: 1, randomizable: true },
  ],
  width: 260,
  height: 290,
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
    'Envelope as a control signal: gated by incoming notes or by a Gate control (e.g. from a ' +
    'Voice module — then the envelope runs per-voice). Modulates anything with a control input.',
  ports: [
    { id: 'notes', label: 'Notes', type: 'note', direction: 'in', description: 'Notes gate the envelope (note on = attack, note off = release).' },
    { id: 'gate', label: 'Gate', type: 'control', direction: 'in', description: 'Control gate (>0.5 = open). A polyphonic gate from a Voice module runs one envelope per voice.' },
    { id: 'out', label: 'Control', type: 'control', direction: 'out', description: 'Envelope value 0.0–1.0 (polyphonic when gated per-voice).' },
  ],
  params: [
    { id: 'attack', label: 'Attack', min: 0.001, max: 4, default: 0.05, unit: 's', curve: 'exp', randomizable: true },
    { id: 'decay', label: 'Decay', min: 0.001, max: 4, default: 0.2, unit: 's', curve: 'exp', randomizable: true },
    { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 0.6, randomizable: true },
    { id: 'release', label: 'Release', min: 0.001, max: 8, default: 0.3, unit: 's', curve: 'exp', randomizable: true },
  ],
  width: 240,
  height: 170,
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
  width: 240,
  height: 170,
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
  width: 250,
  height: 220,
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
  width: 440,
  height: 330,
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
  width: 240,
  height: 200,
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
  width: 240,
  height: 200,
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
  width: 240,
  height: 160,
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
  width: 260,
  height: 230,
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
  width: 230,
  height: 160,
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
  width: 240,
  height: 160,
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
  width: 290,
  height: 230,
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
  width: 240,
  height: 200,
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
  width: 290,
  height: 200,
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
  width: 280,
  height: 280,
};

// ---------------------------------------------------------------------------
// Synth components (build-your-own-synth chain; polyphonic via Voice lanes)
// ---------------------------------------------------------------------------

/** Pitch over control wires: value 0–1 maps linearly to MIDI note 0–127. */
export const PITCH_CONTROL_SCALE = 127;

const voice: ModuleDef = {
  type: 'voice',
  name: 'Voice',
  category: 'component',
  description:
    'Voice allocator: turns a note stream into per-voice Pitch/Gate/Velocity control lanes ' +
    '(pitch = MIDI/127). Downstream components (Osc, Filter, Amp, ADSR via Gate) process each ' +
    'voice separately; lanes collapse to a mix wherever a normal stereo input is reached.',
  ports: [
    { id: 'notes', label: 'Notes', type: 'note', direction: 'in', description: 'Polyphonic note stream to allocate across voices.' },
    { id: 'pitch', label: 'Pitch', type: 'control', direction: 'out', description: 'Per-voice pitch, MIDI/127 (0.0–1.0).' },
    { id: 'gate', label: 'Gate', type: 'control', direction: 'out', description: 'Per-voice gate: 1 while the note is held, else 0.' },
    { id: 'vel', label: 'Vel', type: 'control', direction: 'out', description: 'Per-voice velocity of the most recent note-on (0.0–1.0).' },
  ],
  params: [
    { id: 'voices', label: 'Voices', min: 1, max: 16, default: 4, randomizable: false },
    { id: 'glide', label: 'Glide', min: 0, max: 0.5, default: 0, unit: 's', randomizable: true },
  ],
  width: 200,
  height: 150,
};

export const OSC_WAVES = ['sine', 'triangle', 'square', 'sawtooth', 'noise'] as const;

const osc: ModuleDef = {
  type: 'osc',
  name: 'Oscillator',
  category: 'component',
  description:
    'Single oscillator voice component. Pitch input (MIDI/127) sets the frequency — wire a ' +
    'Voice module for polyphony or any control source for drones; unwired it plays C4. ' +
    'FM input phase-modulates from another audio signal.',
  ports: [
    { id: 'pitch', label: 'Pitch', type: 'control', direction: 'in', description: 'Pitch as MIDI/127. Polyphonic from a Voice module.' },
    { id: 'fm', label: 'FM', type: 'audio', direction: 'in', description: 'Phase modulation input; depth set by the FM parameter.' },
    audioOutPort('Oscillator output (per-voice lanes when the pitch input is polyphonic).'),
  ],
  params: [
    { id: 'wave', label: 'Wave', min: 0, max: OSC_WAVES.length - 1, default: 3, options: [...OSC_WAVES], randomizable: true },
    { id: 'octave', label: 'Octave', min: -3, max: 3, default: 0, randomizable: true },
    { id: 'semi', label: 'Semi', min: -12, max: 12, default: 0, unit: 'st', randomizable: true },
    { id: 'fine', label: 'Fine', min: -100, max: 100, default: 0, unit: 'ct', randomizable: true },
    { id: 'pwm', label: 'PWM', min: 0.05, max: 0.95, default: 0.5, randomizable: true },
    { id: 'fmAmt', label: 'FM Amt', min: 0, max: 1, default: 0, randomizable: true },
    { id: 'level', label: 'Level', min: 0, max: 1, default: 0.8, randomizable: false },
  ],
  width: 240,
  height: 230,
};

export const VCF_MODES = ['lowpass', 'highpass', 'bandpass', 'notch'] as const;

const smpl: ModuleDef = {
  type: 'smpl',
  name: 'Sample Voice',
  category: 'component',
  description:
    'Plays a loaded sample, pitched by incoming notes, with a built-in A/D/S/R amp envelope. ' +
    'Root maps the sample to the keyboard; one-shot or loop. Set Voices to 1 for mono. ' +
    'For drum kits: Trig Note fires the voice only on one note (a drum-map row), Fixed Pitch ' +
    'plays at root regardless of pitch, and Choke cuts other Sample Voices in the same group.',
  ports: [
    { id: 'notes', label: 'Notes', type: 'note', direction: 'in', description: 'Note input controlling sample playback.' },
    audioOutPort('Sample audio output (stereo).'),
  ],
  params: [
    { id: 'root', label: 'Root', min: 24, max: 96, default: 60, randomizable: false },
    { id: 'mode', label: 'Mode', min: 0, max: 1, default: 0, options: ['one-shot', 'loop'], randomizable: false },
    { id: 'voices', label: 'Voices', min: 1, max: 16, default: 8, randomizable: false },
    { id: 'attack', label: 'Attack', min: 0.001, max: 4, default: 0.005, unit: 's', curve: 'exp', randomizable: true },
    { id: 'decay', label: 'Decay', min: 0.001, max: 4, default: 0.1, unit: 's', curve: 'exp', randomizable: true },
    { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 1, randomizable: true },
    { id: 'release', label: 'Release', min: 0.001, max: 8, default: 0.2, unit: 's', curve: 'exp', randomizable: true },
    { id: 'level', label: 'Level', min: 0, max: 1, default: 0.8, randomizable: false },
    { id: 'pan', label: 'Pan', min: -1, max: 1, default: 0, randomizable: true },
    { id: 'trigNote', label: 'Trig Note', min: -1, max: 127, default: -1, randomizable: false },
    { id: 'fixedPitch', label: 'Fixed Pitch', min: 0, max: 1, default: 0, options: ['off', 'on'], randomizable: false },
    { id: 'chokeGroup', label: 'Choke', min: 0, max: 8, default: 0, randomizable: false },
  ],
  width: 250,
  height: 330,
  defaultData: () => ({ sampleName: '' }),
};

const wtosc: ModuleDef = {
  type: 'wtosc',
  name: 'Wavetable Osc',
  category: 'component',
  description:
    'Wavetable oscillator component. Pitch input (MIDI/127) sets the frequency; Position scans ' +
    'through the loaded table (2048-frame split), and Pos Mod modulates it. Load a sample as the ' +
    'table, or use the built-in 4-frame default (sine/tri/saw/square). FM input phase-modulates.',
  ports: [
    { id: 'pitch', label: 'Pitch', type: 'control', direction: 'in', description: 'Pitch as MIDI/127. Polyphonic from a Voice module.' },
    { id: 'posMod', label: 'Pos Mod', type: 'control', direction: 'in', description: 'Wavetable position modulation.' },
    { id: 'fm', label: 'FM', type: 'audio', direction: 'in', description: 'Phase modulation input; depth set by the FM parameter.' },
    audioOutPort('Wavetable oscillator output (per-voice lanes when the pitch input is polyphonic).'),
  ],
  params: [
    { id: 'wtPos', label: 'Position', min: 0, max: 1, default: 0, randomizable: true },
    { id: 'octave', label: 'Octave', min: -3, max: 3, default: 0, randomizable: true },
    { id: 'semi', label: 'Semi', min: -12, max: 12, default: 0, unit: 'st', randomizable: true },
    { id: 'fine', label: 'Fine', min: -100, max: 100, default: 0, unit: 'ct', randomizable: true },
    { id: 'fmAmt', label: 'FM Amt', min: 0, max: 1, default: 0, randomizable: true },
    { id: 'level', label: 'Level', min: 0, max: 1, default: 0.8, randomizable: false },
  ],
  width: 240,
  height: 230,
  defaultData: () => ({ sampleName: '' }),
};

const vcf: ModuleDef = {
  type: 'vcf',
  name: 'Filter',
  category: 'component',
  description:
    'Multimode filter (state-variable): cutoff and Q knobs, live response curve (drag the dot: ' +
    'cutoff/Q). The Mod input shifts the cutoff by up to ±6 octaves (Amt) — wire an ADSR or LFO. ' +
    'Processes per-voice lanes from upstream components.',
  ports: [
    audioIn('Audio to filter (keeps per-voice lanes).'),
    { id: 'mod', label: 'Mod', type: 'control', direction: 'in', description: 'Cutoff modulation, scaled by Amt (octaves). Polyphonic-aware.' },
    audioOutPort('Filtered audio.'),
  ],
  params: [
    { id: 'mode', label: 'Mode', min: 0, max: VCF_MODES.length - 1, default: 0, options: [...VCF_MODES], randomizable: true },
    { id: 'cutoff', label: 'Cutoff', min: 40, max: 18000, default: 1200, unit: 'Hz', curve: 'exp', randomizable: true },
    { id: 'res', label: 'Q', min: 0, max: 0.95, default: 0.2, randomizable: true },
    { id: 'amt', label: 'Amt', min: -6, max: 6, default: 0, unit: 'oct', randomizable: true },
  ],
  width: 230,
  height: 290,
  customFace: true,
};

const vca: ModuleDef = {
  type: 'vca',
  name: 'Amp',
  category: 'component',
  description:
    'Voltage-controlled amplifier: audio × CV × level. Wire an ADSR (gated per-voice) into CV ' +
    'for envelopes; unwired CV passes audio at the Level setting.',
  ports: [
    audioIn('Audio to attenuate (keeps per-voice lanes).'),
    { id: 'cv', label: 'CV', type: 'control', direction: 'in', description: 'Gain control 0.0–1.0, per-voice when polyphonic.' },
    audioOutPort('Attenuated audio.'),
  ],
  params: [
    { id: 'level', label: 'Level', min: 0, max: 1, default: 1, randomizable: false },
  ],
  width: 190,
  height: 140,
};

// ---------------------------------------------------------------------------
// Controller modules (PRD §8.6) — values are params so undo/AI/save just work
// ---------------------------------------------------------------------------

const knob: ModuleDef = {
  type: 'knob',
  name: 'Knob',
  category: 'controller',
  description:
    'A knob on the canvas (PRD §8.6): drag vertically to turn, double-click resets to the ' +
    'default, shift-double-click types a value, ⚙ configures min/max/default (display only). ' +
    'Wire its Control output anywhere a control input exists.',
  ports: [
    { id: 'out', label: 'Control', type: 'control', direction: 'out', description: 'Knob value 0.0–1.0.' },
    { id: 'color', label: 'Color', type: 'color', direction: 'in', description: 'Live tint from a Color Gen — the knob lights up with it.' },
  ],
  params: [
    { id: 'value', label: 'Value', min: 0, max: 1, default: 0.5, randomizable: true },
  ],
  width: 130,
  height: 150,
  customFace: true,
};

export const SLIDER_ORIENTS = ['vertical', 'horizontal'] as const;

const slider: ModuleDef = {
  type: 'slider',
  name: 'Slider',
  category: 'controller',
  description:
    'A fader on the canvas (PRD §8.6), vertical or horizontal. Double-click resets to the ' +
    'default, shift-double-click types a value, ⚙ configures min/max/default (display only).',
  ports: [
    { id: 'out', label: 'Control', type: 'control', direction: 'out', description: 'Slider value 0.0–1.0.' },
    { id: 'color', label: 'Color', type: 'color', direction: 'in', description: 'Live tint from a Color Gen — the fader lights up with it.' },
  ],
  params: [
    { id: 'value', label: 'Value', min: 0, max: 1, default: 0.5, randomizable: true },
    { id: 'orient', label: 'Orient', min: 0, max: SLIDER_ORIENTS.length - 1, default: 0, options: [...SLIDER_ORIENTS], randomizable: false },
  ],
  width: 130,
  height: 250,
  customFace: true,
};

export const XY_SPRINGS = ['off', 'on'] as const;

const xy: ModuleDef = {
  type: 'xy',
  name: 'XY Pad',
  category: 'controller',
  description:
    'Two controls in one gesture (PRD §8.6): drag the puck, X and Y are separate Control ' +
    'outputs. Spring mode snaps the puck back to center on release.',
  ports: [
    { id: 'x', label: 'X', type: 'control', direction: 'out', description: 'Horizontal puck position 0.0–1.0.' },
    { id: 'y', label: 'Y', type: 'control', direction: 'out', description: 'Vertical puck position 0.0–1.0 (up = 1).' },
    { id: 'color', label: 'Color', type: 'color', direction: 'in', description: 'Live tint from a Color Gen — the puck lights up with it.' },
  ],
  params: [
    { id: 'x', label: 'X', min: 0, max: 1, default: 0.5, randomizable: true },
    { id: 'y', label: 'Y', min: 0, max: 1, default: 0.5, randomizable: true },
    { id: 'spring', label: 'Spring', min: 0, max: 1, default: 0, options: [...XY_SPRINGS], randomizable: false },
  ],
  width: 190,
  height: 250,
  customFace: true,
};

export const BUTTON_MODES = ['momentary', 'toggle'] as const;

const button: ModuleDef = {
  type: 'button',
  name: 'Button',
  category: 'controller',
  description:
    'Momentary or latching button (PRD §8.6). Control output is 1 while pressed/latched, else 0 ' +
    '— gate an ADSR, mute a mixer channel, trigger a Sample & Hold.',
  ports: [
    { id: 'out', label: 'Control', type: 'control', direction: 'out', description: 'Button state: 0 or 1.' },
    { id: 'color', label: 'Color', type: 'color', direction: 'in', description: 'Live tint from a Color Gen — the button lights up with it.' },
  ],
  params: [
    { id: 'value', label: 'State', min: 0, max: 1, default: 0, options: ['off', 'on'], randomizable: false },
    { id: 'mode', label: 'Mode', min: 0, max: BUTTON_MODES.length - 1, default: 0, options: [...BUTTON_MODES], randomizable: false },
  ],
  width: 140,
  height: 170,
  customFace: true,
};

// ---------------------------------------------------------------------------
// Control utilities
// ---------------------------------------------------------------------------

const quantizer: ModuleDef = {
  type: 'quantizer',
  name: 'Quantizer',
  category: 'data',
  description:
    'Snaps a pitch control (MIDI/127) to the nearest note of a scale — turns an LFO or Random ' +
    'into melody when wired to an Oscillator pitch input.',
  ports: [
    { id: 'in', label: 'In', type: 'control', direction: 'in', description: 'Pitch control to quantize (MIDI/127).' },
    { id: 'out', label: 'Out', type: 'control', direction: 'out', description: 'Quantized pitch control.' },
  ],
  params: [
    { id: 'scale', label: 'Scale', min: 0, max: SCALE_NAMES.length - 1, default: 1, options: [...SCALE_NAMES], randomizable: true },
    { id: 'root', label: 'Root', min: 0, max: ROOT_NAMES.length - 1, default: 0, options: [...ROOT_NAMES], randomizable: true },
  ],
  width: 200,
  height: 150,
};

const sah: ModuleDef = {
  type: 'sah',
  name: 'Sample & Hold',
  category: 'data',
  description:
    'Captures the input control on each rising edge of the Trig input (>0.5) and holds it — ' +
    'classic stepped modulation from an LFO square or a Button.',
  ports: [
    { id: 'in', label: 'In', type: 'control', direction: 'in', description: 'Control to sample.' },
    { id: 'trig', label: 'Trig', type: 'control', direction: 'in', description: 'Rising edge above 0.5 captures the input.' },
    { id: 'out', label: 'Out', type: 'control', direction: 'out', description: 'Held control value.' },
  ],
  params: [],
  width: 170,
  height: 100,
};

const slew: ModuleDef = {
  type: 'slew',
  name: 'Slew',
  category: 'data',
  description:
    'Limits how fast a control signal may rise or fall (full range per Rise/Fall seconds) — ' +
    'smooths steps from a Sample & Hold or sequencer-style sources, portamento for pitch controls.',
  ports: [
    { id: 'in', label: 'In', type: 'control', direction: 'in', description: 'Control to smooth.' },
    { id: 'out', label: 'Out', type: 'control', direction: 'out', description: 'Slew-limited control.' },
  ],
  params: [
    { id: 'rise', label: 'Rise', min: 0, max: 2, default: 0.1, unit: 's', curve: 'exp', randomizable: true },
    { id: 'fall', label: 'Fall', min: 0, max: 2, default: 0.1, unit: 's', curve: 'exp', randomizable: true },
  ],
  width: 200,
  height: 150,
};

export const CMATH_MODES = ['a+b', 'a×b', 'min', 'max'] as const;

const cmath: ModuleDef = {
  type: 'cmath',
  name: 'Control Math',
  category: 'data',
  description:
    'Combines two control signals: attenuvert each input (±1), add an offset, pick the blend ' +
    'mode. The glue for modulation routing (e.g. LFO depth controlled by a Knob).',
  ports: [
    { id: 'a', label: 'A', type: 'control', direction: 'in', description: 'Control input A.' },
    { id: 'b', label: 'B', type: 'control', direction: 'in', description: 'Control input B.' },
    { id: 'out', label: 'Out', type: 'control', direction: 'out', description: 'Combined control, clamped 0.0–1.0.' },
  ],
  params: [
    { id: 'mode', label: 'Mode', min: 0, max: CMATH_MODES.length - 1, default: 0, options: [...CMATH_MODES], randomizable: true },
    { id: 'gainA', label: 'Gain A', min: -1, max: 1, default: 1, randomizable: true },
    { id: 'gainB', label: 'Gain B', min: -1, max: 1, default: 1, randomizable: true },
    { id: 'offset', label: 'Offset', min: -1, max: 1, default: 0, randomizable: true },
  ],
  width: 240,
  height: 170,
};

export const MODMATRIX_SIZE = 4;

const modmatrix: ModuleDef = {
  type: 'modmatrix',
  name: 'Mod Matrix',
  category: 'data',
  description:
    '4×4 modulation matrix: routes every control input to every control output with a ' +
    'bipolar depth per crossing (drag a cell up/down, double-click to zero). One module ' +
    'replaces a web of Control Math blocks.',
  ports: [
    ...Array.from({ length: MODMATRIX_SIZE }, (_, i) => ({
      id: `in${i + 1}`,
      label: `In ${i + 1}`,
      type: 'control' as const,
      direction: 'in' as const,
      description: `Control input ${i + 1} (matrix row).`,
    })),
    ...Array.from({ length: MODMATRIX_SIZE }, (_, j) => ({
      id: `out${j + 1}`,
      label: `Out ${j + 1}`,
      type: 'control' as const,
      direction: 'out' as const,
      description: `Control output ${j + 1}: sum of inputs × their column depths, clamped 0.0–1.0.`,
    })),
  ],
  params: Array.from({ length: MODMATRIX_SIZE * MODMATRIX_SIZE }, (_, k) => {
    const i = Math.floor(k / MODMATRIX_SIZE) + 1; // input (row)
    const j = (k % MODMATRIX_SIZE) + 1; // output (column)
    return {
      id: `m${i}${j}`,
      label: `${i}→${j}`,
      min: -1,
      max: 1,
      default: 0,
      randomizable: false,
    };
  }),
  width: 280,
  height: 220,
};

const notethru: ModuleDef = {
  type: 'notethru',
  name: 'Note Thru',
  category: 'component',
  description:
    'Note relay: passes its note input straight through to every wire on its output. ' +
    'Use it to fan one note source out to many voices (e.g. a drum kit) from a single ' +
    'group note-in pole.',
  ports: [
    { id: 'notes', label: 'Notes', type: 'note', direction: 'in', description: 'Note stream in.' },
    { id: 'out', label: 'Notes', type: 'note', direction: 'out', description: 'Same note stream, relayed to all connected targets.' },
  ],
  params: [],
  width: 150,
  height: 90,
};

// -- text producers (VISUALIZER_ENGINE_PLAN.md Phase 3) -----------------------

export const TRANSPORT_TEXT_FORMATS = ['bar.beat', 'time', 'bpm'] as const;

const stt: ModuleDef = {
  type: 'stt',
  name: 'Speech to Text',
  category: 'data',
  description:
    'Streams microphone speech as live text (Web Speech API; asks for mic permission). ' +
    'Interim words appear while you talk — wire Text into a Visualizer for karaoke-style ' +
    'lyrics. Click the face to start/stop listening. Availability varies by browser.',
  ports: [
    { id: 'out', label: 'Text', type: 'text', direction: 'out', description: 'Recognized speech; interim + final lines.' },
  ],
  params: [],
  width: 250,
  height: 150,
};

const transporttext: ModuleDef = {
  type: 'transporttext',
  name: 'Transport Text',
  category: 'data',
  description:
    'Emits the song position as text — bar.beat, elapsed time or BPM — for on-screen readouts.',
  ports: [
    { id: 'out', label: 'Text', type: 'text', direction: 'out', description: 'Formatted transport readout, updates while playing.' },
  ],
  params: [
    { id: 'format', label: 'Format', min: 0, max: TRANSPORT_TEXT_FORMATS.length - 1, default: 0, options: [...TRANSPORT_TEXT_FORMATS], randomizable: false },
  ],
  width: 230,
  height: 150,
};

const textinput: ModuleDef = {
  type: 'textinput',
  name: 'Text Input',
  category: 'data',
  description:
    'Manual text source — click the face and type a line to send it (lyrics pushing, captions, labels).',
  ports: [
    { id: 'out', label: 'Text', type: 'text', direction: 'out', description: 'The typed line, emitted when entered.' },
  ],
  params: [],
  width: 240,
  height: 140,
};

const notenames: ModuleDef = {
  type: 'notenames',
  name: 'Note Names',
  category: 'data',
  description: 'Turns incoming notes into text ("C#4") — fun with arps and sequencers.',
  ports: [
    { id: 'notes', label: 'Notes', type: 'note', direction: 'in', description: 'Notes to name.' },
    { id: 'out', label: 'Text', type: 'text', direction: 'out', description: 'Name of each played note.' },
  ],
  params: [],
  width: 220,
  height: 140,
};

export const MODULE_DEFS: Map<string, ModuleDef> = new Map(
  [
    transport, sequencer, arp, composer, notethru, lfo, adsr, random, keyboard, midiIn, midiOut,
    voice, osc, wtosc, smpl, vcf, vca, knob, slider, xy, button, quantizer, sah, slew, cmath, modmatrix,
    delay, reverb, distortion, eq, peq, chorus, flanger, bitcrusher, compressor, mbcomp, limiterFx, modulator,
    mixer, recorder, audioOut, levels, visualizer, colorgen,
    stt, transporttext, textinput, notenames,
  ].map((d) => [d.type, d]),
);
