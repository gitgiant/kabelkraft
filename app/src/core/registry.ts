/**
 * Built-in module definitions — Phase 0 set (PRD §17):
 * Master Transport, Synth (classic), Keyboard, Audio Out, Levels.
 */

import type { ModuleDef, ParamSpec } from './module';
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
    { id: 'tint', label: 'Tint', type: 'visual', direction: 'in', description: 'Wire a visualizer frame — accent colors on this tile take its derived color.' },
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

export const AUDIO_IN_CHANNELS = ['stereo', 'left', 'right', 'mono sum'] as const;
/** Hardware channel pairs for multichannel interfaces (MiniFuse 4 etc.). */
export const CHANNEL_PAIRS = ['1-2', '3-4', '5-6', '7-8'] as const;

const audioInDef: ModuleDef = {
  type: 'audioIn',
  name: 'Audio In',
  category: 'io',
  description:
    'Live audio from a capture device (microphone / audio interface). Click the device row to ' +
    'pick an input; the browser asks for microphone permission on first use. Pair selects which ' +
    'hardware channel pair to capture (multichannel interfaces); Channels selects how that pair ' +
    'feeds the stereo output.',
  ports: [
    { id: 'out', label: 'Audio', type: 'audio', direction: 'out', description: 'Live input as a stereo stream.' },
  ],
  params: [
    { id: 'gain', label: 'Gain', min: 0, max: 4, default: 1, randomizable: false },
    { id: 'pair', label: 'Pair', min: 0, max: CHANNEL_PAIRS.length - 1, default: 0, options: [...CHANNEL_PAIRS], randomizable: false },
    { id: 'channels', label: 'Channels', min: 0, max: AUDIO_IN_CHANNELS.length - 1, default: 0, options: [...AUDIO_IN_CHANNELS], randomizable: false },
    { id: 'mute', label: 'Mute', min: 0, max: 1, default: 0, options: ['off', 'on'], randomizable: false },
  ],
  width: 240,
  height: 190,
  defaultData: () => ({ deviceId: '', deviceName: 'default input' }),
};

const audioOut: ModuleDef = {
  type: 'audioOut',
  name: 'Audio Out',
  category: 'io',
  description:
    'Routes audio to the output device. Brickwall safety limiter is ON by default (PRD §9.4). ' +
    'Pair picks the hardware output pair on multichannel interfaces (falls back to 1-2 when ' +
    'the device has fewer channels).',
  ports: [
    { id: 'in', label: 'Audio', type: 'audio', direction: 'in', description: 'Audio to play; multiple wires are summed.' },
  ],
  params: [
    { id: 'level', label: 'Level', min: 0, max: 1, default: 0.8, randomizable: false },
    { id: 'pair', label: 'Pair', min: 0, max: CHANNEL_PAIRS.length - 1, default: 0, options: [...CHANNEL_PAIRS], randomizable: false },
    { id: 'limiter', label: 'Limiter', min: 0, max: 1, default: 1, options: ['off', 'on'], randomizable: false },
    { id: 'ceiling', label: 'Ceiling', min: -24, max: 0, default: -0.3, unit: 'dB', randomizable: false },
    { id: 'release', label: 'Release', min: 1, max: 500, default: 80, unit: 'ms', randomizable: false },
  ],
  width: 230,
  height: 210,
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
    { id: 'tint', label: 'Tint', type: 'visual', direction: 'in', description: 'Wire a visualizer frame — accent colors on this tile take its derived color.' },
  ],
  params: [],
  customFace: true,
  defaultData: () => ({ graph: initVisGraph() }),
  width: 280,
  height: 280,
};

const bgVisual: ModuleDef = {
  type: 'bgvisual',
  name: 'Background',
  category: 'visual',
  description:
    'Background sink: paints a wired visualizer frame across the whole app window, ' +
    'behind the patch (the patch canvas goes transparent while it is on). Wire any ' +
    'visualizer’s Vis Out into Vis In — layer/chain scenes upstream first. Opacity ' +
    'fades it; turn On off to restore the normal canvas background.',
  ports: [
    { id: 'vin', label: 'Vis In', type: 'visual', direction: 'in', description: 'Visualizer frame to paint full-window behind the patch.' },
  ],
  params: [
    { id: 'enabled', label: 'On', min: 0, max: 1, default: 1, options: ['off', 'on'], randomizable: false },
    { id: 'opacity', label: 'Opacity', min: 0, max: 1, default: 1, randomizable: false },
  ],
  width: 200,
  height: 130,
};

// TODO(intelligence): placeholder module — the face shows one AI prompt
// window per wired input type, but nothing is generated yet. Planned: each
// prompt drives an input-aware AI flow (audio → analysis/description, notes →
// MIDI generation, text → lyrics/visual prompts, visual → scene edits…) via
// the shared buildAiContext() pipeline, plus matching output ports.
const intelligence: ModuleDef = {
  type: 'intelligence',
  name: 'Intelligence',
  category: 'data',
  description:
    'AI hub — wire any signal in and a matching AI prompt window appears inside. ' +
    'Placeholder: prompts are mocked, generation is not implemented yet.',
  ports: [
    { id: 'in', label: 'Audio', type: 'audio', direction: 'in', description: 'Audio for AI analysis prompts; multiple wires are summed.' },
    { id: 'notes', label: 'Notes', type: 'note', direction: 'in', description: 'Note events for AI melody/harmony prompts.' },
    { id: 'mod', label: 'Mod', type: 'control', direction: 'in', description: 'Control signal for AI modulation prompts.' },
    { id: 'trig', label: 'Trig', type: 'trigger', direction: 'in', description: 'Trigger pulses for AI event prompts.' },
    { id: 'clock', label: 'Clock', type: 'transport', direction: 'in', description: 'Transport clock for AI timing-aware prompts.' },
    { id: 'text', label: 'Text', type: 'text', direction: 'in', description: 'Text stream (lyrics, speech) for AI text prompts.' },
    { id: 'vin', label: 'Visual', type: 'visual', direction: 'in', description: 'Rendered frame for AI visual prompts.' },
  ],
  params: [],
  customFace: true,
  width: 280,
  height: 240,
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

export const ENV_MODES = ['gated', 'one-shot', 'loop'] as const;

const envelope: ModuleDef = {
  type: 'envelope',
  name: 'Envelope',
  category: 'data',
  description:
    'A DAHDSR envelope as a control signal: gated by incoming notes or by a Gate control (e.g. ' +
    'from a Voice module — then the envelope runs per-voice). Per-stage curve, velocity ' +
    'sensitivity, depth/invert/bipolar output, and gated / one-shot / loop modes. Modulates ' +
    'anything with a control input.',
  ports: [
    { id: 'notes', label: 'Notes', type: 'note', direction: 'in', description: 'Notes gate the envelope (note on = attack, note off = release).' },
    { id: 'gate', label: 'Gate', type: 'control', direction: 'in', description: 'Control gate (>0.5 = open). A polyphonic gate from a Voice module runs one envelope per voice.' },
    { id: 'vel', label: 'Vel', type: 'control', direction: 'in', description: 'Per-voice velocity (0–1), e.g. from a Voice module. Scales the peak via the Vel amount.' },
    { id: 'out', label: 'Control', type: 'control', direction: 'out', description: 'Envelope value (polyphonic when gated per-voice). 0–1, or ±depth when bipolar.' },
  ],
  params: [
    { id: 'delay', label: 'Delay', min: 0, max: 2, default: 0, unit: 's', curve: 'exp', randomizable: true },
    { id: 'attack', label: 'Attack', min: 0.001, max: 4, default: 0.05, unit: 's', curve: 'exp', randomizable: true },
    { id: 'hold', label: 'Hold', min: 0, max: 2, default: 0, unit: 's', curve: 'exp', randomizable: true },
    { id: 'decay', label: 'Decay', min: 0.001, max: 4, default: 0.2, unit: 's', curve: 'exp', randomizable: true },
    { id: 'sustain', label: 'Sustain', min: 0, max: 1, default: 0.6, randomizable: true },
    { id: 'release', label: 'Release', min: 0.001, max: 8, default: 0.3, unit: 's', curve: 'exp', randomizable: true },
    { id: 'atkCurve', label: 'Atk Crv', min: -1, max: 1, default: 0, randomizable: true },
    { id: 'decCurve', label: 'Dec Crv', min: -1, max: 1, default: -0.4, randomizable: true },
    { id: 'relCurve', label: 'Rel Crv', min: -1, max: 1, default: -0.4, randomizable: true },
    { id: 'velAmt', label: 'Vel', min: 0, max: 1, default: 0, randomizable: true },
    { id: 'depth', label: 'Depth', min: 0, max: 1, default: 1, randomizable: true },
    { id: 'mode', label: 'Mode', min: 0, max: ENV_MODES.length - 1, default: 0, options: [...ENV_MODES], randomizable: false },
    { id: 'bipolar', label: 'Bipolar', min: 0, max: 1, default: 0, options: ['off', 'on'], randomizable: false },
    { id: 'invert', label: 'Invert', min: 0, max: 1, default: 0, options: ['off', 'on'], randomizable: false },
  ],
  width: 320,
  height: 300,
  customFace: true,
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

const ducker: ModuleDef = {
  type: 'ducker',
  name: 'Ducker',
  category: 'effect',
  description:
    'Sidechain ducker: a key signal pushes the main input down. Wire a kick to Key for the ' +
    'classic pump (Key wins); or drive Trig with an LFO/sequencer for tempo-synced ducking. ' +
    'Red bar shows live gain reduction.',
  ports: [
    audioIn(),
    { id: 'key', label: 'Key', type: 'audio', direction: 'in', description: 'Audio detector; its level ducks the main input. Takes priority over Trig.' },
    { id: 'trig', label: 'Trig', type: 'control', direction: 'in', description: 'Control driver (LFO/seq/envelope); used when Key is unwired.' },
    audioOutPort(),
  ],
  params: [
    { id: 'amount', label: 'Amount', min: 0, max: 1, default: 0.7, randomizable: true },
    { id: 'attack', label: 'Attack', min: 0.1, max: 100, default: 5, unit: 'ms', curve: 'exp', randomizable: true },
    { id: 'release', label: 'Release', min: 10, max: 1000, default: 120, unit: 'ms', curve: 'exp', randomizable: true },
    { id: 'detect', label: 'Detect', min: 0, max: 1, default: 0, randomizable: false },
    { id: 'sense', label: 'Sense', min: -12, max: 24, default: 0, unit: 'dB', randomizable: false },
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

/** Strip params for one mixer channel (5 = the master bus strip). */
function mixerStripParams(ch: number): ParamSpec[] {
  const n = ch === 5 ? 'M' : String(ch);
  return [
    { id: `eqHi${ch}`, label: `Hi ${n}`, min: -60, max: 6, default: 0, unit: 'dB', randomizable: true },
    { id: `eqMid${ch}`, label: `Mid ${n}`, min: -60, max: 6, default: 0, unit: 'dB', randomizable: true },
    { id: `eqLo${ch}`, label: `Low ${n}`, min: -60, max: 6, default: 0, unit: 'dB', randomizable: true },
    { id: `filt${ch}`, label: `Flt ${n}`, min: -1, max: 1, default: 0, randomizable: true },
    { id: `send${ch}`, label: `Snd ${n}`, min: 0, max: 1, default: 0, randomizable: false },
    { id: `lvl${ch}`, label: ch === 5 ? 'Master' : `Lvl ${n}`, min: 0, max: 1, default: 0.8, randomizable: false },
    { id: `pan${ch}`, label: `Pan ${n}`, min: -1, max: 1, default: 0, randomizable: true },
  ];
}

const mixer: ModuleDef = {
  type: 'mixer',
  name: 'Mixer',
  category: 'io',
  description:
    'DJ-style 4-channel stereo mixer + master strip: per-strip kill EQ (Hi/Mid/Low, -60..+6 dB), ' +
    'one-knob LP/HP filter (left = lowpass sweep, right = highpass, center = off), post-fader FX ' +
    'send (its send pole appears once the knob is up or wired), level fader with meter, and pan. ' +
    'Channel meters read pre-fader; the master meter reads the final output.',
  customFace: true,
  ports: [
    { id: 'in1', label: 'In 1', type: 'audio', direction: 'in', description: 'Channel 1 input.' },
    { id: 'in2', label: 'In 2', type: 'audio', direction: 'in', description: 'Channel 2 input.' },
    { id: 'in3', label: 'In 3', type: 'audio', direction: 'in', description: 'Channel 3 input.' },
    { id: 'in4', label: 'In 4', type: 'audio', direction: 'in', description: 'Channel 4 input.' },
    audioOutPort('Mixed stereo output (post-master strip).'),
    { id: 'send1', label: 'Send 1', type: 'audio', direction: 'out', description: 'Channel 1 FX send (post-fader, pre-pan). Appears when the send knob is up.' },
    { id: 'send2', label: 'Send 2', type: 'audio', direction: 'out', description: 'Channel 2 FX send (post-fader, pre-pan). Appears when the send knob is up.' },
    { id: 'send3', label: 'Send 3', type: 'audio', direction: 'out', description: 'Channel 3 FX send (post-fader, pre-pan). Appears when the send knob is up.' },
    { id: 'send4', label: 'Send 4', type: 'audio', direction: 'out', description: 'Channel 4 FX send (post-fader, pre-pan). Appears when the send knob is up.' },
    { id: 'send5', label: 'Send M', type: 'audio', direction: 'out', description: 'Master FX send (post-master-fader, pre-pan). Appears when the send knob is up.' },
  ],
  params: [1, 2, 3, 4, 5].flatMap(mixerStripParams),
  width: 340,
  height: 560,
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
    '(pitch = MIDI/127). Downstream components (Osc, Filter, Amp, Envelope via Gate) process each ' +
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
    'Pulse width is modulatable (PWM Mod); a built-in sub oscillator adds weight. ' +
    'For frequency modulation use the FM Osc component.',
  ports: [
    { id: 'pitch', label: 'Pitch', type: 'control', direction: 'in', description: 'Pitch as MIDI/127. Polyphonic from a Voice module.' },
    { id: 'pwmMod', label: 'PWM Mod', type: 'control', direction: 'in', description: 'Pulse-width modulation, added to the PWM parameter. Wire an LFO/Envelope.' },
    audioOutPort('Oscillator output (per-voice lanes when the pitch input is polyphonic).'),
  ],
  params: [
    { id: 'wave', label: 'Wave', min: 0, max: OSC_WAVES.length - 1, default: 3, options: [...OSC_WAVES], randomizable: true },
    { id: 'octave', label: 'Octave', min: -3, max: 3, default: 0, randomizable: true },
    { id: 'semi', label: 'Semi', min: -12, max: 12, default: 0, unit: 'st', randomizable: true },
    { id: 'fine', label: 'Fine', min: -100, max: 100, default: 0, unit: 'ct', randomizable: true },
    { id: 'pwm', label: 'PWM', min: 0.05, max: 0.95, default: 0.5, randomizable: true },
    { id: 'subLevel', label: 'Sub', min: 0, max: 1, default: 0, randomizable: true },
    { id: 'subOct', label: 'Sub Oct', min: 0, max: 1, default: 0, options: ['-1', '-2'], randomizable: false },
    { id: 'subWave', label: 'Sub Wave', min: 0, max: 1, default: 0, options: ['sine', 'square'], randomizable: false },
    { id: 'level', label: 'Level', min: 0, max: 1, default: 0.8, randomizable: false },
  ],
  width: 240,
  height: 230,
};

export const FM_CARRIER_WAVES = ['sine', 'triangle', 'square', 'sawtooth'] as const;

const fmosc: ModuleDef = {
  type: 'fmosc',
  name: 'FM Osc',
  category: 'component',
  description:
    'Two-operator FM cell: a built-in sine modulator phase-modulates the carrier. ' +
    'Pitch input (MIDI/127) sets the frequency; Coarse/Detune set the modulator ratio, ' +
    'Index the depth (wire an envelope to Idx Mod for evolving brightness), Feedback adds ' +
    'grit (sine→saw→noise). The FM input feeds the modulator — chain FM Osc → FM Osc.fm ' +
    'for deeper serial operator towers.',
  ports: [
    { id: 'pitch', label: 'Pitch', type: 'control', direction: 'in', description: 'Pitch as MIDI/127. Polyphonic from a Voice module.' },
    { id: 'fm', label: 'FM', type: 'audio', direction: 'in', description: 'External phase modulation into the modulator; depth set by FM Amt.' },
    { id: 'idxMod', label: 'Idx Mod', type: 'control', direction: 'in', description: 'Modulation index, added to the Index parameter. Wire an Envelope/LFO.' },
    audioOutPort('Carrier output (per-voice lanes when the pitch input is polyphonic).'),
  ],
  params: [
    { id: 'coarse', label: 'Coarse', min: 0.5, max: 16, default: 1, randomizable: true },
    { id: 'detune', label: 'Detune', min: -1, max: 1, default: 0, randomizable: true },
    { id: 'index', label: 'Index', min: 0, max: 10, default: 1, randomizable: true },
    { id: 'feedback', label: 'Feedback', min: 0, max: 1, default: 0, randomizable: true },
    { id: 'cwave', label: 'Carrier', min: 0, max: FM_CARRIER_WAVES.length - 1, default: 0, options: [...FM_CARRIER_WAVES], randomizable: true },
    { id: 'octave', label: 'Octave', min: -3, max: 3, default: 0, randomizable: true },
    { id: 'semi', label: 'Semi', min: -12, max: 12, default: 0, unit: 'st', randomizable: true },
    { id: 'fine', label: 'Fine', min: -100, max: 100, default: 0, unit: 'ct', randomizable: true },
    { id: 'fmAmt', label: 'FM Amt', min: 0, max: 1, default: 0, randomizable: true },
    { id: 'level', label: 'Level', min: 0, max: 1, default: 0.8, randomizable: false },
  ],
  width: 240,
  height: 250,
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
    'through the loaded table (2048-frame split), and Pos Mod modulates it. Loads TWO tables (A/B) — ' +
    'Morph crossfades between them (wire Morph Mod for movement). Built-in 8-frame harmonic-sweep ' +
    'default when nothing is loaded. FM input phase-modulates; a sub oscillator adds weight.',
  ports: [
    { id: 'pitch', label: 'Pitch', type: 'control', direction: 'in', description: 'Pitch as MIDI/127. Polyphonic from a Voice module.' },
    { id: 'posMod', label: 'Pos Mod', type: 'control', direction: 'in', description: 'Wavetable position modulation.' },
    { id: 'morphMod', label: 'Morph Mod', type: 'control', direction: 'in', description: 'A↔B morph modulation, added to the Morph parameter.' },
    { id: 'fm', label: 'FM', type: 'audio', direction: 'in', description: 'Phase modulation input; depth set by the FM parameter.' },
    audioOutPort('Wavetable oscillator output (per-voice lanes when the pitch input is polyphonic).'),
  ],
  params: [
    { id: 'wtPos', label: 'Position', min: 0, max: 1, default: 0, randomizable: true },
    { id: 'morph', label: 'Morph', min: 0, max: 1, default: 0, randomizable: true },
    { id: 'octave', label: 'Octave', min: -3, max: 3, default: 0, randomizable: true },
    { id: 'semi', label: 'Semi', min: -12, max: 12, default: 0, unit: 'st', randomizable: true },
    { id: 'fine', label: 'Fine', min: -100, max: 100, default: 0, unit: 'ct', randomizable: true },
    { id: 'fmAmt', label: 'FM Amt', min: 0, max: 1, default: 0, randomizable: true },
    { id: 'subLevel', label: 'Sub', min: 0, max: 1, default: 0, randomizable: true },
    { id: 'subOct', label: 'Sub Oct', min: 0, max: 1, default: 0, options: ['-1', '-2'], randomizable: false },
    { id: 'subWave', label: 'Sub Wave', min: 0, max: 1, default: 0, options: ['sine', 'square'], randomizable: false },
    { id: 'level', label: 'Level', min: 0, max: 1, default: 0.8, randomizable: false },
  ],
  width: 260,
  height: 360,
  defaultData: () => ({ sampleName: '', sampleNameA: '', sampleNameB: '' }),
};

const pluck: ModuleDef = {
  type: 'pluck',
  name: 'Pluck',
  category: 'component',
  description:
    'Karplus-Strong / waveguide string. The Gate input fires a one-shot exciter (per voice) ' +
    'that rings and decays — wire a Voice for poly plucks (Pitch + Gate). Tone sets the ' +
    'excitation character (round noise → bright pick), Pos is the pluck position (bright/nasal ' +
    'near the bridge → hollow in the middle), Decay is the ring time, Damp the brightness ' +
    'falloff, Stretch adds inharmonic/metallic dispersion. Unwired Gate auto-plucks.',
  ports: [
    { id: 'pitch', label: 'Pitch', type: 'control', direction: 'in', description: 'Pitch as MIDI/127. Polyphonic from a Voice module.' },
    { id: 'gate', label: 'Gate', type: 'control', direction: 'in', description: 'Rising edge fires the exciter (per voice). Wire a Voice Gate.' },
    audioOutPort('Plucked string output (per-voice lanes when the pitch input is polyphonic).'),
  ],
  params: [
    { id: 'tone', label: 'Tone', min: 0, max: 1, default: 0.5, randomizable: true },
    { id: 'pos', label: 'Pos', min: 0, max: 0.95, default: 0.2, randomizable: true },
    { id: 'decay', label: 'Decay', min: 0.05, max: 12, default: 2.5, unit: 's', curve: 'exp', randomizable: true },
    { id: 'damp', label: 'Damp', min: 0, max: 1, default: 0.3, randomizable: true },
    { id: 'stretch', label: 'Stretch', min: 0, max: 1, default: 0, randomizable: true },
    { id: 'octave', label: 'Octave', min: -3, max: 3, default: 0, randomizable: true },
    { id: 'semi', label: 'Semi', min: -12, max: 12, default: 0, unit: 'st', randomizable: true },
    { id: 'fine', label: 'Fine', min: -100, max: 100, default: 0, unit: 'ct', randomizable: true },
    { id: 'level', label: 'Level', min: 0, max: 1, default: 0.8, randomizable: false },
  ],
  width: 250,
  height: 320,
  twoColumn: true,
};

const resonator: ModuleDef = {
  type: 'resonator',
  name: 'Resonator',
  category: 'component',
  description:
    'Generic tuned waveguide — resonates whatever audio is wired in. Pitch input transposes the ' +
    'tuning (unwired = the Octave/Semi/Fine base, so it works as a fixed-tuned comb). Decay is ' +
    'the feedback (ring length), Damp the brightness, Stretch the inharmonic dispersion, Mix the ' +
    'dry/wet. Excite it with noise→Amp for bowed/struck strings, or feed a drum loop for a comb.',
  ports: [
    audioIn('Excitation audio to resonate (keeps per-voice lanes).'),
    { id: 'pitch', label: 'Pitch', type: 'control', direction: 'in', description: 'Pitch as MIDI/127; transposes the resonance. Unwired = base tuning.' },
    audioOutPort('Resonated audio.'),
  ],
  params: [
    { id: 'decay', label: 'Decay', min: 0, max: 0.9995, default: 0.97, randomizable: true },
    { id: 'damp', label: 'Damp', min: 0, max: 1, default: 0.3, randomizable: true },
    { id: 'stretch', label: 'Stretch', min: 0, max: 1, default: 0, randomizable: true },
    { id: 'octave', label: 'Octave', min: -3, max: 3, default: 0, randomizable: true },
    { id: 'semi', label: 'Semi', min: -12, max: 12, default: 0, unit: 'st', randomizable: true },
    { id: 'fine', label: 'Fine', min: -100, max: 100, default: 0, unit: 'ct', randomizable: true },
    { id: 'mix', label: 'Mix', min: 0, max: 1, default: 1, randomizable: true },
  ],
  width: 240,
  height: 300,
  twoColumn: true,
};

const addosc: ModuleDef = {
  type: 'addosc',
  name: 'Additive Osc',
  category: 'component',
  description:
    'Additive oscillator: a procedural bank of sine partials (no aliasing). Partials sets the ' +
    'count, Tilt the spectral slope (brightness, dB/oct), Odd the odd/even balance ' +
    '(saw↔square↔clarinet), Inharm stretches the partial frequencies (bell/metal). Wire an ' +
    'LFO/Envelope to Tilt Mod for spectral motion. Partials above Nyquist are dropped.',
  ports: [
    { id: 'pitch', label: 'Pitch', type: 'control', direction: 'in', description: 'Pitch as MIDI/127. Polyphonic from a Voice module.' },
    { id: 'tiltMod', label: 'Tilt Mod', type: 'control', direction: 'in', description: 'Spectral tilt modulation (brightness), added to the Tilt parameter.' },
    audioOutPort('Additive output (per-voice lanes when the pitch input is polyphonic).'),
  ],
  params: [
    { id: 'partials', label: 'Partials', min: 1, max: 64, default: 16, randomizable: true },
    { id: 'tilt', label: 'Tilt', min: -24, max: 6, default: -6, unit: 'dB/oct', randomizable: true },
    { id: 'odd', label: 'Odd/Even', min: 0, max: 1, default: 0.5, randomizable: true },
    { id: 'inharm', label: 'Inharm', min: 0, max: 1, default: 0, randomizable: true },
    { id: 'octave', label: 'Octave', min: -3, max: 3, default: 0, randomizable: true },
    { id: 'semi', label: 'Semi', min: -12, max: 12, default: 0, unit: 'st', randomizable: true },
    { id: 'fine', label: 'Fine', min: -100, max: 100, default: 0, unit: 'ct', randomizable: true },
    { id: 'level', label: 'Level', min: 0, max: 1, default: 0.8, randomizable: false },
  ],
  width: 250,
  height: 310,
  twoColumn: true,
};

const granular: ModuleDef = {
  type: 'granular',
  name: 'Granular',
  category: 'component',
  description:
    'Granular cloud. Source = a loaded sample or the live audio input (circular buffer; Freeze ' +
    'holds the captured slice). One paraphonic grain stream — grains are transposed per held note ' +
    '(Notes in), or drone at Root when nothing is held. Pos scans the buffer, Size sets grain ' +
    'length, Density the overlap, Spray/Jitter randomize position/pitch, Spread the stereo width.',
  ports: [
    { id: 'notes', label: 'Notes', type: 'note', direction: 'in', description: 'Held notes transpose the grains (paraphonic).' },
    audioIn('Live source audio (when Source = live).'),
    { id: 'posMod', label: 'Pos Mod', type: 'control', direction: 'in', description: 'Scan-position modulation, added to Pos.' },
    audioOutPort('Granular output (stereo).'),
  ],
  params: [
    { id: 'source', label: 'Source', min: 0, max: 1, default: 0, options: ['sample', 'live'], randomizable: false },
    { id: 'freeze', label: 'Freeze', min: 0, max: 1, default: 0, options: ['off', 'on'], randomizable: false },
    { id: 'pos', label: 'Pos', min: 0, max: 1, default: 0, randomizable: true },
    { id: 'size', label: 'Size', min: 5, max: 500, default: 80, unit: 'ms', curve: 'exp', randomizable: true },
    { id: 'density', label: 'Density', min: 1, max: 8, default: 4, randomizable: true },
    { id: 'spray', label: 'Spray', min: 0, max: 1, default: 0.1, randomizable: true },
    { id: 'jitter', label: 'Jitter', min: 0, max: 1, default: 0, randomizable: true },
    { id: 'spread', label: 'Spread', min: 0, max: 1, default: 0.3, randomizable: true },
    { id: 'shape', label: 'Shape', min: 0, max: 2, default: 0, options: ['hann', 'tukey', 'tri'], randomizable: true },
    { id: 'root', label: 'Root', min: 24, max: 96, default: 60, randomizable: false },
    { id: 'level', label: 'Level', min: 0, max: 1, default: 0.8, randomizable: false },
  ],
  width: 260,
  height: 360,
  twoColumn: true,
  defaultData: () => ({ sampleName: '' }),
};

const vcf: ModuleDef = {
  type: 'vcf',
  name: 'Filter',
  category: 'component',
  description:
    'Multimode filter (state-variable): cutoff and Q knobs, live response curve (drag the dot: ' +
    'cutoff/Q). The Mod input shifts the cutoff by up to ±6 octaves (Amt) — wire an Envelope or LFO. ' +
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
    'Voltage-controlled amplifier: audio × CV × level. Wire an Envelope (gated per-voice) into CV ' +
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
    '— gate an Envelope, mute a mixer channel, trigger a Sample & Hold.',
  ports: [
    { id: 'out', label: 'Control', type: 'control', direction: 'out', description: 'Button state: 0 or 1.' },
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

const lyrics: ModuleDef = {
  type: 'lyrics',
  name: 'Lyrics',
  category: 'data',
  description:
    'Timed lyric sheet — generate lines from a prompt with AI (gets the song BPM + time signature), ' +
    'or write them by hand. Each line emits on the Text out as the transport reaches its beat, so ' +
    'lyrics play back in sync like a song. Wire Text into a Visualizer for karaoke.',
  ports: [
    { id: 'out', label: 'Text', type: 'text', direction: 'out', description: 'The current lyric line, emitted as the song reaches it.' },
  ],
  params: [],
  width: 250,
  height: 150,
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
    transport, sequencer, arp, composer, notethru, lfo, envelope, random, keyboard, midiIn, midiOut,
    voice, osc, fmosc, wtosc, smpl, pluck, resonator, addosc, granular, vcf, vca, knob, slider, xy, button, quantizer, sah, slew, cmath, modmatrix,
    delay, reverb, distortion, eq, peq, chorus, flanger, bitcrusher, compressor, ducker, mbcomp, limiterFx, modulator,
    mixer, recorder, audioInDef, audioOut, levels, visualizer,
    stt, transporttext, textinput, lyrics, notenames, intelligence, bgVisual,
  ].map((d) => [d.type, d]),
);
