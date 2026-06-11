import { patchCanvas } from '../canvas/PatchCanvas';
import { appState } from '../state';
import { DRUM_BASE_NOTE, renderDefaultKit } from '../core/drumkit';

type FaceKnob = { id: string; kind: 'knob'; x: number; y: number; w: number; h: number; label: string; moduleId: string; paramId: string };
type FaceLabel = { id: string; kind: 'label'; x: number; y: number; w: number; h: number; text: string; size: number };

const knob = (id: string, x: number, y: number, label: string, moduleId: string, paramId: string): FaceKnob =>
  ({ id, kind: 'knob', x, y, w: 70, h: 86, label, moduleId, paramId });
const caption = (id: string, x: number, y: number, text: string): FaceLabel =>
  ({ id, kind: 'label', x, y, w: 120, h: 16, text, size: 12 });

// Bounding-box center of the poly-synth layout (used as origin for offset calc).
const POLY_CX = -15;
const POLY_CY = -225;

/** Add the Init Poly Synth starter patch, centered at (cx, cy) in world coords. */
export function addPolySynth(cx = POLY_CX, cy = POLY_CY): void {
  const dx = cx - POLY_CX;
  const dy = cy - POLY_CY;
  const at = (x: number, y: number): [number, number] => [x + dx, y + dy];

  const voice = appState.addModule('voice', ...at(-600, -220));
  const osc1 = appState.addModule('osc', ...at(-350, -360));
  const osc2 = appState.addModule('osc', ...at(-350, -110));
  const adsr = appState.addModule('adsr', ...at(-600, -60));
  const lfo = appState.addModule('lfo', ...at(-600, 110));
  const vcf = appState.addModule('vcf', ...at(-110, -280));
  const vca = appState.addModule('vca', ...at(170, -190));
  const delay = appState.addModule('delay', ...at(390, -250));
  const reverb = appState.addModule('reverb', ...at(640, -270));
  const audioOut = appState.addModule('audioOut', ...at(910, -190));

  osc1.label = 'Osc A';
  osc2.label = 'Osc B';
  adsr.label = 'Amp Env';
  delay.label = 'Echo';

  const wire = (fromId: string, fromPort: string, toId: string, toPort: string) =>
    appState.connect({ moduleId: fromId, portId: fromPort }, { moduleId: toId, portId: toPort });

  wire(voice.id, 'pitch', osc1.id, 'pitch');
  wire(voice.id, 'pitch', osc2.id, 'pitch');
  wire(voice.id, 'gate', adsr.id, 'gate');
  wire(osc1.id, 'out', vcf.id, 'in');
  wire(osc2.id, 'out', vcf.id, 'in');
  wire(lfo.id, 'out', vcf.id, 'mod');
  wire(vcf.id, 'out', vca.id, 'in');
  wire(adsr.id, 'out', vca.id, 'cv');
  wire(vca.id, 'out', delay.id, 'in');
  wire(delay.id, 'out', reverb.id, 'in');
  wire(reverb.id, 'out', audioOut.id, 'in');

  appState.setParam(osc2.id, 'fine', 7);
  appState.setParam(vcf.id, 'amt', 1.2);
  appState.setParam(lfo.id, 'rate', 0.4);

  const group = appState.graph.createGroup(
    'Poly Synth',
    [voice.id, osc1.id, osc2.id, adsr.id, lfo.id, vcf.id, vca.id, delay.id, reverb.id],
    [],
    cx - 100, cy + 45,
  );
  const knob = (id: string, x: number, y: number, label: string, moduleId: string, paramId: string) =>
    ({ id, kind: 'knob' as const, x, y, w: 70, h: 86, label, moduleId, paramId });
  const caption = (id: string, x: number, y: number, text: string) =>
    ({ id, kind: 'label' as const, x, y, w: 120, h: 16, text, size: 12 });
  appState.setGroupFace(group.id, {
    width: 580,
    height: 430,
    grid: 10,
    snap: true,
    elements: [
      caption('e1', 10, 10, 'VOICE'),
      caption('e2', 170, 10, 'OSC'),
      caption('e3', 330, 10, 'FILTER'),
      knob('e4', 10, 30, 'Voices', voice.id, 'voices'),
      knob('e5', 90, 30, 'Glide', voice.id, 'glide'),
      knob('e6', 170, 30, 'Wave', osc1.id, 'wave'),
      knob('e7', 250, 30, 'Detune', osc2.id, 'fine'),
      knob('e8', 330, 30, 'Cutoff', vcf.id, 'cutoff'),
      knob('e9', 410, 30, 'Q', vcf.id, 'res'),
      knob('e10', 490, 30, 'LFO Amt', vcf.id, 'amt'),
      caption('e11', 10, 130, 'AMP ENV'),
      caption('e12', 330, 130, 'LFO'),
      knob('e13', 10, 150, 'Attack', adsr.id, 'attack'),
      knob('e14', 90, 150, 'Decay', adsr.id, 'decay'),
      knob('e15', 170, 150, 'Sustain', adsr.id, 'sustain'),
      knob('e16', 250, 150, 'Release', adsr.id, 'release'),
      knob('e17', 330, 150, 'Rate', lfo.id, 'rate'),
      knob('e18', 410, 150, 'Depth', lfo.id, 'depth'),
      knob('e19', 490, 150, 'Level', vca.id, 'level'),
      caption('e20', 10, 250, 'ECHO'),
      caption('e21', 330, 250, 'REVERB'),
      knob('e22', 10, 270, 'Mix', delay.id, 'mix'),
      knob('e23', 90, 270, 'Time', delay.id, 'time'),
      knob('e24', 170, 270, 'Feedback', delay.id, 'feedback'),
      { id: 'e25', kind: 'button' as const, x: 250, y: 290, w: 70, h: 44, label: 'Bypass', moduleId: delay.id, paramId: 'bypass' },
      knob('e26', 330, 270, 'Mix', reverb.id, 'mix'),
      knob('e27', 410, 270, 'Size', reverb.id, 'size'),
      { id: 'e28', kind: 'button' as const, x: 490, y: 290, w: 70, h: 44, label: 'Bypass', moduleId: reverb.id, paramId: 'bypass' },
      { id: 'e29', kind: 'meter' as const, x: 10, y: 390, w: 320, h: 16, label: 'Out', moduleId: reverb.id },
    ],
  });
}

/** Mono Synth: 1-voice subtractive lead/bass built from components + face. */
export function addMonoSynth(cx: number, cy: number): void {
  const at = (x: number, y: number): [number, number] => [cx + x, cy + y];

  const voice = appState.addModule('voice', ...at(-560, -120));
  const osc1 = appState.addModule('osc', ...at(-320, -240));
  const osc2 = appState.addModule('osc', ...at(-320, -10));
  const adsrA = appState.addModule('adsr', ...at(-560, 90));
  const adsrF = appState.addModule('adsr', ...at(-560, 290));
  const lfo = appState.addModule('lfo', ...at(-560, 480));
  const vcf = appState.addModule('vcf', ...at(-60, -150));
  const vca = appState.addModule('vca', ...at(220, -60));
  const audioOut = appState.addModule('audioOut', ...at(480, -60));

  osc1.label = 'Osc A';
  osc2.label = 'Osc B';
  adsrA.label = 'Amp Env';
  adsrF.label = 'Filter Env';

  const wire = (fromId: string, fromPort: string, toId: string, toPort: string) =>
    appState.connect({ moduleId: fromId, portId: fromPort }, { moduleId: toId, portId: toPort });

  wire(voice.id, 'pitch', osc1.id, 'pitch');
  wire(voice.id, 'pitch', osc2.id, 'pitch');
  wire(voice.id, 'gate', adsrA.id, 'gate');
  wire(voice.id, 'gate', adsrF.id, 'gate');
  wire(osc1.id, 'out', vcf.id, 'in');
  wire(osc2.id, 'out', vcf.id, 'in');
  wire(adsrF.id, 'out', vcf.id, 'mod');
  wire(vcf.id, 'out', vca.id, 'in');
  wire(adsrA.id, 'out', vca.id, 'cv');
  wire(vca.id, 'out', audioOut.id, 'in');

  appState.setParam(voice.id, 'voices', 1);
  appState.setParam(voice.id, 'glide', 0.06);
  appState.setParam(osc2.id, 'fine', 8);
  appState.setParam(vcf.id, 'cutoff', 1400);
  appState.setParam(vcf.id, 'amt', 0.8);
  appState.setParam(adsrF.id, 'decay', 0.4);
  appState.setParam(adsrF.id, 'sustain', 0.3);

  const group = appState.graph.createGroup(
    'Mono Synth',
    [voice.id, osc1.id, osc2.id, adsrA.id, adsrF.id, lfo.id, vcf.id, vca.id],
    [],
    cx - 100, cy + 45,
  );
  appState.setGroupFace(group.id, {
    width: 580,
    height: 350,
    grid: 10,
    snap: true,
    elements: [
      caption('e1', 10, 10, 'OSC'),
      caption('e2', 250, 10, 'FILTER'),
      knob('e3', 10, 30, 'Wave A', osc1.id, 'wave'),
      knob('e4', 90, 30, 'Wave B', osc2.id, 'wave'),
      knob('e5', 170, 30, 'Detune', osc2.id, 'fine'),
      knob('e6', 250, 30, 'Cutoff', vcf.id, 'cutoff'),
      knob('e7', 330, 30, 'Q', vcf.id, 'res'),
      knob('e8', 410, 30, 'Env Amt', vcf.id, 'amt'),
      knob('e9', 490, 30, 'Glide', voice.id, 'glide'),
      caption('e10', 10, 130, 'AMP ENV'),
      caption('e11', 330, 130, 'FILTER ENV'),
      knob('e12', 10, 150, 'Attack', adsrA.id, 'attack'),
      knob('e13', 90, 150, 'Decay', adsrA.id, 'decay'),
      knob('e14', 170, 150, 'Sustain', adsrA.id, 'sustain'),
      knob('e15', 250, 150, 'Release', adsrA.id, 'release'),
      knob('e16', 330, 150, 'Attack', adsrF.id, 'attack'),
      knob('e17', 410, 150, 'Decay', adsrF.id, 'decay'),
      knob('e18', 490, 150, 'Release', adsrF.id, 'release'),
      caption('e19', 10, 250, 'LFO'),
      knob('e20', 10, 270, 'Rate', lfo.id, 'rate'),
      knob('e21', 90, 270, 'Depth', lfo.id, 'depth'),
      knob('e22', 170, 270, 'Level', vca.id, 'level'),
      { id: 'e23', kind: 'meter' as const, x: 250, y: 300, w: 320, h: 16, label: 'Out', moduleId: vca.id },
    ],
  });
}

/** Sampler: a single Sample Voice + keyboard + face. Expand to load a sample. */
export function addSampler(cx: number, cy: number): void {
  const at = (x: number, y: number): [number, number] => [cx + x, cy + y];

  const smpl = appState.addModule('smpl', ...at(-120, -100));
  const audioOut = appState.addModule('audioOut', ...at(220, -60));

  const wire = (fromId: string, fromPort: string, toId: string, toPort: string) =>
    appState.connect({ moduleId: fromId, portId: fromPort }, { moduleId: toId, portId: toPort });

  wire(smpl.id, 'out', audioOut.id, 'in');

  const group = appState.graph.createGroup('Sampler', [smpl.id], [], cx - 100, cy + 45);
  appState.setGroupFace(group.id, {
    width: 340,
    height: 230,
    grid: 10,
    snap: true,
    elements: [
      caption('e1', 10, 10, 'SAMPLE VOICE — expand the group to load a file'),
      knob('e2', 10, 40, 'Root', smpl.id, 'root'),
      knob('e3', 90, 40, 'Mode', smpl.id, 'mode'),
      knob('e4', 170, 40, 'Voices', smpl.id, 'voices'),
      knob('e5', 250, 40, 'Level', smpl.id, 'level'),
      knob('e6', 10, 130, 'Attack', smpl.id, 'attack'),
      knob('e7', 90, 130, 'Decay', smpl.id, 'decay'),
      knob('e8', 170, 130, 'Sustain', smpl.id, 'sustain'),
      knob('e9', 250, 130, 'Release', smpl.id, 'release'),
    ],
  });
}

/**
 * Drum Kit: a Note Thru fans one note input out to 16 Sample Voices (drum map),
 * whose outputs sum through a Mixer to one audio out. Silent until a note source
 * (keyboard, composer, sequencer) is wired to the group's note pole.
 */
export function addDrumKit(cx: number, cy: number): void {
  const at = (x: number, y: number): [number, number] => [cx + x, cy + y];

  const notethru = appState.addModule('notethru', ...at(-720, -80));
  const mixer = appState.addModule('mixer', ...at(640, -40));
  const audioOut = appState.addModule('audioOut', ...at(960, -40));

  const wire = (fromId: string, fromPort: string, toId: string, toPort: string) =>
    appState.connect({ moduleId: fromId, portId: fromPort }, { moduleId: toId, portId: toPort });

  const kit = renderDefaultKit();
  const smplIds: string[] = [];
  for (let i = 0; i < 16; i++) {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const s = appState.addModule('smpl', ...at(-380 + col * 250, -120 + row * 140));
    s.label = kit[i]?.name ?? `Pad ${i + 1}`;
    smplIds.push(s.id);
    appState.setParam(s.id, 'voices', 1);
    appState.setParam(s.id, 'fixedPitch', 1);
    appState.setParam(s.id, 'trigNote', DRUM_BASE_NOTE + i);
    if (i === 4 || i === 5) appState.setParam(s.id, 'chokeGroup', 1); // CH/OH cut each other
    wire(notethru.id, 'out', s.id, 'notes');
    wire(s.id, 'out', mixer.id, `in${(i % 4) + 1}`); // 4 voices sum per channel
  }
  wire(mixer.id, 'out', audioOut.id, 'in');

  // Preload the built-in synthesized kit (pads 1–8) after the worklet knows them.
  kit.forEach((sample, i) => {
    if (sample) appState.setSample(smplIds[i], sample);
  });

  const group = appState.graph.createGroup('Drum Kit', [notethru.id, ...smplIds, mixer.id], [], cx - 100, cy + 45);
  const elements: Array<FaceKnob | FaceLabel | { id: string; kind: 'meter'; x: number; y: number; w: number; h: number; label: string; moduleId: string }> = [
    caption('c0', 10, 10, 'DRUM KIT — wire a keyboard or composer to the note pole'),
  ];
  for (let i = 0; i < 16; i++) {
    const col = i % 8;
    const r = Math.floor(i / 8);
    elements.push(knob(`k${i}`, 10 + col * 72, 36 + r * 96, kit[i]?.name ?? `${i + 1}`, smplIds[i], 'level'));
  }
  elements.push({ id: 'm', kind: 'meter', x: 10, y: 240, w: 560, h: 16, label: 'Out', moduleId: mixer.id });
  appState.setGroupFace(group.id, { width: 590, height: 280, grid: 10, snap: true, elements });
}

export interface StarterPatch {
  name: string;
  description: string;
  add: () => void;
}

export const STARTERS: StarterPatch[] = [
  {
    name: 'Init Poly Synth',
    description: 'Voice → 2 Osc → Filter → Amp + ADSR, LFO, Echo, Reverb — wire a note source to play',
    add: () => {
      const c = patchCanvas.viewCenter();
      addPolySynth(c.x, c.y);
    },
  },
  {
    name: 'Mono Synth',
    description: '1-voice lead/bass: Voice → 2 Osc → Filter → Amp, two ADSRs, LFO — wire a note source',
    add: () => {
      const c = patchCanvas.viewCenter();
      addMonoSynth(c.x, c.y);
    },
  },
  {
    name: 'Sampler',
    description: 'Single Sample Voice — wire a note source; expand to load any audio file',
    add: () => {
      const c = patchCanvas.viewCenter();
      addSampler(c.x, c.y);
    },
  },
  {
    name: 'Drum Kit',
    description: '16 Sample Voices (Note Thru → Mixer), built-in synth kit — wire a note source',
    add: () => {
      const c = patchCanvas.viewCenter();
      addDrumKit(c.x, c.y);
    },
  },
];
