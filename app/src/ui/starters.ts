import { patchCanvas } from '../canvas/PatchCanvas';
import { appState } from '../state';

// Bounding-box center of the poly-synth layout (used as origin for offset calc).
const POLY_CX = -15;
const POLY_CY = -225;

/** Add the Init Poly Synth starter patch, centered at (cx, cy) in world coords. */
export function addPolySynth(cx = POLY_CX, cy = POLY_CY): void {
  const dx = cx - POLY_CX;
  const dy = cy - POLY_CY;
  const at = (x: number, y: number): [number, number] => [x + dx, y + dy];

  appState.addModule('transport', ...at(-150, -560));
  const sequencer = appState.addModule('sequencer', ...at(-940, -300));
  const keyboard = appState.addModule('keyboard', ...at(-900, -80));

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
  const levels = appState.addModule('levels', ...at(910, -40));

  osc1.label = 'Osc A';
  osc2.label = 'Osc B';
  adsr.label = 'Amp Env';
  delay.label = 'Echo';

  const wire = (fromId: string, fromPort: string, toId: string, toPort: string) =>
    appState.connect({ moduleId: fromId, portId: fromPort }, { moduleId: toId, portId: toPort });

  wire(sequencer.id, 'notes', voice.id, 'notes');
  wire(keyboard.id, 'notes', voice.id, 'notes');
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
  wire(reverb.id, 'out', levels.id, 'in');

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

export interface StarterPatch {
  name: string;
  description: string;
  add: () => void;
}

export const STARTERS: StarterPatch[] = [
  {
    name: 'Init Poly Synth',
    description: 'Voice → 2 Osc → Filter → Amp + ADSR, LFO, Echo, Reverb, Sequencer, Keyboard',
    add: () => {
      const c = patchCanvas.viewCenter();
      addPolySynth(c.x, c.y);
    },
  },
];
