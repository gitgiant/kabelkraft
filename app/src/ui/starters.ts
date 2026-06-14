import { patchCanvas } from '../canvas/PatchCanvas';
import { appState } from '../state';
import { DRUM_BASE_NOTE, renderDefaultKit } from '../core/drumkit';
import { OSC_WAVES, VCF_MODES } from '../core/registry';

type FaceKnob = { id: string; kind: 'knob'; x: number; y: number; w: number; h: number; label: string; moduleId: string; paramId: string };
type FaceLabel = { id: string; kind: 'label'; x: number; y: number; w: number; h: number; text: string; size: number };

const knob = (id: string, x: number, y: number, label: string, moduleId: string, paramId: string): FaceKnob =>
  ({ id, kind: 'knob', x, y, w: 70, h: 86, label, moduleId, paramId });
const caption = (id: string, x: number, y: number, text: string): FaceLabel =>
  ({ id, kind: 'label', x, y, w: 120, h: 16, text, size: 12 });

// Default world position for the boot-time starter (App.svelte calls bare).
const POLY_CX = -15;
const POLY_CY = -225;

/**
 * Init Poly Synth — nested-container showcase: the parent face hosts live
 * sub-panels (Oscillators / Envelopes / FX child groups), a composer clip
 * view, the filter's curve view, and an XY space pad (reverb × echo).
 */
export function addPolySynth(cx = POLY_CX, cy = POLY_CY): void {
  const at = (x: number, y: number): [number, number] => [cx + x, cy + y];

  const composer = appState.addModule('composer', ...at(-980, -320));
  const voice = appState.addModule('voice', ...at(-640, -280));
  const osc1 = appState.addModule('osc', ...at(-360, -500));
  const osc2 = appState.addModule('osc', ...at(-360, -250));
  const osc3 = appState.addModule('osc', ...at(-360, 0));
  const osc4 = appState.addModule('osc', ...at(-360, 250));
  const adsrA = appState.addModule('envelope', ...at(-640, -60));
  const adsrF = appState.addModule('envelope', ...at(-640, 140));
  const vcf = appState.addModule('vcf', ...at(-80, -360));
  const vca = appState.addModule('vca', ...at(190, -220));
  const delay = appState.addModule('delay', ...at(430, -320));
  const reverb = appState.addModule('reverb', ...at(700, -340));
  const audioOut = appState.ensureAudioOut(...at(990, -220));

  osc1.label = 'Osc A';
  osc2.label = 'Osc B';
  osc3.label = 'Osc C';
  osc4.label = 'Osc D';
  adsrA.label = 'Amp Env';
  adsrF.label = 'Filter Env';
  delay.label = 'Echo';

  const wire = (fromId: string, fromPort: string, toId: string, toPort: string) =>
    appState.connect({ moduleId: fromId, portId: fromPort }, { moduleId: toId, portId: toPort });

  wire(composer.id, 'notes', voice.id, 'notes');
  for (const osc of [osc1, osc2, osc3, osc4]) {
    wire(voice.id, 'pitch', osc.id, 'pitch');
    wire(osc.id, 'out', vcf.id, 'in');
  }
  wire(voice.id, 'gate', adsrA.id, 'gate');
  wire(voice.id, 'gate', adsrF.id, 'gate');
  wire(adsrF.id, 'out', vcf.id, 'mod');
  wire(vcf.id, 'out', vca.id, 'in');
  wire(adsrA.id, 'out', vca.id, 'cv');
  wire(vca.id, 'out', delay.id, 'in');
  wire(delay.id, 'out', reverb.id, 'in');
  wire(reverb.id, 'out', audioOut.id, 'in');

  // A fat stack: spread detune, sub octave, filter envelope bite.
  appState.setParam(osc2.id, 'fine', 6);
  appState.setParam(osc3.id, 'fine', -6);
  appState.setParam(osc4.id, 'octave', -1);
  appState.setParam(osc4.id, 'level', 0.6);
  appState.setParam(vcf.id, 'cutoff', 900);
  appState.setParam(vcf.id, 'amt', 2.5);
  appState.setParam(adsrF.id, 'decay', 0.35);
  appState.setParam(adsrF.id, 'sustain', 0.25);
  appState.setParam(delay.id, 'mix', 0.2);
  appState.setParam(reverb.id, 'mix', 0.25);

  // -- child groups, each with its own designed face (parent embeds them) ----

  const oscGroup = appState.graph.createGroup(
    'Oscillators', [osc1.id, osc2.id, osc3.id, osc4.id], [], ...at(-360, -120),
  );
  const oscNames = ['OSC A', 'OSC B', 'OSC C', 'OSC D'];
  const oscParams: Array<[string, string]> = [
    ['Wave', 'wave'], ['Octave', 'octave'], ['Semi', 'semi'], ['Fine', 'fine'],
    ['PWM', 'pwm'], ['Sub', 'subLevel'], ['Level', 'level'],
  ];
  appState.setGroupFace(oscGroup.id, {
    width: 580,
    height: 460,
    grid: 10,
    snap: true,
    elements: [osc1, osc2, osc3, osc4].flatMap((osc, r) => [
      caption(`o${r}`, 10, 10 + r * 110, oscNames[r]),
      ...oscParams.map(([label, paramId], i) =>
        knob(`o${r}k${i}`, 10 + i * 80, 28 + r * 110, label, osc.id, paramId)),
    ]),
  });

  const envGroup = appState.graph.createGroup(
    'Envelopes', [adsrA.id, adsrF.id], [], ...at(-640, 40),
  );
  appState.setGroupFace(envGroup.id, {
    width: 340,
    height: 240,
    grid: 10,
    snap: true,
    elements: [
      caption('ea', 10, 10, 'AMP ENV'),
      knob('ea1', 10, 28, 'Attack', adsrA.id, 'attack'),
      knob('ea2', 90, 28, 'Decay', adsrA.id, 'decay'),
      knob('ea3', 170, 28, 'Sustain', adsrA.id, 'sustain'),
      knob('ea4', 250, 28, 'Release', adsrA.id, 'release'),
      caption('ef', 10, 130, 'FILTER ENV'),
      knob('ef1', 10, 148, 'Attack', adsrF.id, 'attack'),
      knob('ef2', 90, 148, 'Decay', adsrF.id, 'decay'),
      knob('ef3', 170, 148, 'Sustain', adsrF.id, 'sustain'),
      knob('ef4', 250, 148, 'Release', adsrF.id, 'release'),
    ],
  });

  const fxGroup = appState.graph.createGroup(
    'FX', [delay.id, reverb.id], [], ...at(560, -120),
  );
  appState.setGroupFace(fxGroup.id, {
    width: 340,
    height: 240,
    grid: 10,
    snap: true,
    elements: [
      caption('fd', 10, 10, 'ECHO'),
      knob('fd1', 10, 28, 'Mix', delay.id, 'mix'),
      knob('fd2', 90, 28, 'Time', delay.id, 'time'),
      knob('fd3', 170, 28, 'Feedback', delay.id, 'feedback'),
      knob('fd4', 250, 28, 'Tone', delay.id, 'tone'),
      caption('fr', 10, 130, 'REVERB'),
      knob('fr1', 10, 148, 'Mix', reverb.id, 'mix'),
      knob('fr2', 90, 148, 'Size', reverb.id, 'size'),
      knob('fr3', 170, 148, 'Decay', reverb.id, 'decay'),
      knob('fr4', 250, 148, 'Damp', reverb.id, 'damp'),
    ],
  });

  // -- parent group: face embeds the sub-panels + composer/filter views ------

  const group = appState.graph.createGroup(
    'Poly Synth',
    [composer.id, voice.id, vcf.id, vca.id],
    [oscGroup.id, envGroup.id, fxGroup.id],
    cx - 100, cy + 45,
  );
  const view = (
    id: string, x: number, y: number, w: number, h: number, label: string,
    target: { moduleId?: string; groupId?: string },
  ) => ({ id, kind: 'view' as const, x, y, w, h, label, ...target });
  appState.setGroupFace(group.id, {
    width: 660,
    height: 600,
    grid: 10,
    snap: true,
    elements: [
      view('v1', 10, 30, 300, 150, 'Clip', { moduleId: composer.id }),
      view('v2', 330, 30, 150, 170, 'Filter', { moduleId: vcf.id }),
      {
        id: 'xy1', kind: 'xy' as const, x: 500, y: 30, w: 150, h: 166,
        label: 'Space (Rev × Echo)',
        moduleId: reverb.id, paramId: 'mix',
        moduleId2: delay.id, paramId2: 'mix',
      },
      view('v3', 10, 210, 320, 254, 'Oscillators', { groupId: oscGroup.id }),
      view('v4', 350, 210, 150, 106, 'Envelopes', { groupId: envGroup.id }),
      view('v5', 510, 210, 140, 99, 'FX', { groupId: fxGroup.id }),
      knob('k1', 10, 490, 'Voices', voice.id, 'voices'),
      knob('k2', 90, 490, 'Glide', voice.id, 'glide'),
      knob('k3', 170, 490, 'Level', vca.id, 'level'),
      { id: 'm1', kind: 'meter' as const, x: 270, y: 520, w: 380, h: 16, label: 'Out', moduleId: reverb.id },
    ],
  });
}

/** Mono Synth: 1-voice subtractive lead/bass built from components + face. */
export function addMonoSynth(cx: number, cy: number): void {
  const at = (x: number, y: number): [number, number] => [cx + x, cy + y];

  const voice = appState.addModule('voice', ...at(-560, -120));
  const osc1 = appState.addModule('osc', ...at(-320, -240));
  const osc2 = appState.addModule('osc', ...at(-320, -10));
  const adsrA = appState.addModule('envelope', ...at(-560, 90));
  const adsrF = appState.addModule('envelope', ...at(-560, 290));
  const lfo = appState.addModule('lfo', ...at(-560, 480));
  const vcf = appState.addModule('vcf', ...at(-60, -150));
  const vca = appState.addModule('vca', ...at(220, -60));
  const audioOut = appState.ensureAudioOut(...at(480, -60));

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
  const audioOut = appState.ensureAudioOut(...at(220, -60));

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
  const audioOut = appState.ensureAudioOut(...at(960, -40));

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

/**
 * Drum Synth: seven drum voices synthesized live from components — sine bodies
 * plus a shared noise oscillator through per-voice filters — instead of the
 * Drum Kit's baked samples, so the panel knobs shape the sound in real time.
 * Components have no per-note splitter (smpl's Trig Note is sample-only), so
 * each voice is fired by its own sequencer trigger row; a preset beat means
 * pressing Play grooves immediately.
 *
 * Percussion envelopes: sustain 1 with the sequencer gate at minimum, so the
 * Envelope snaps open and Release is the drum's single decay control.
 */
export function addDrumSynth(cx: number, cy: number): void {
  const at = (x: number, y: number): [number, number] => [cx + x, cy + y];
  const wire = (fromId: string, fromPort: string, toId: string, toPort: string) =>
    appState.connect({ moduleId: fromId, portId: fromPort }, { moduleId: toId, portId: toPort });

  const rowY = (row: number) => -1050 + row * 300;

  const env = (label: string, x: number, y: number, release: number, attack = 0.001) => {
    const e = appState.addModule('envelope', ...at(x, y));
    e.label = label;
    appState.setParam(e.id, 'attack', attack);
    appState.setParam(e.id, 'decay', 0.01);
    appState.setParam(e.id, 'sustain', 1);
    appState.setParam(e.id, 'release', release);
    return e;
  };

  /** One trigger row: a sequencer with the given 16th-steps on, gating `amp`. */
  const trigRow = (label: string, row: number, steps: number[], release: number, attack = 0.001) => {
    const seq = appState.addModule('sequencer', ...at(-1620, rowY(row)));
    seq.label = label;
    appState.setParam(seq.id, 'gate', 0.05);
    appState.setModuleData(
      seq.id,
      'steps',
      Array.from({ length: 16 }, (_, s) => ({ on: steps.includes(s), pitch: 60 })),
    );
    const amp = env(`${label} Env`, -1240, rowY(row), release, attack);
    wire(seq.id, 'notes', amp.id, 'notes');
    return { seq, amp };
  };

  const voiceVca = (x: number, y: number, ampId: string, level: number) => {
    const v = appState.addModule('vca', ...at(x, y));
    appState.setParam(v.id, 'level', level);
    wire(ampId, 'out', v.id, 'cv');
    return v;
  };

  // -- kick: sine with a cmath-scaled pitch-sweep envelope --------------------
  const kick = trigRow('Kick', 0, [0, 8], 0.45);
  const kickPitchEnv = env('Kick Pitch', -1240, rowY(0) + 190, 0.07);
  wire(kick.seq.id, 'notes', kickPitchEnv.id, 'notes');
  const kickMath = appState.addModule('cmath', ...at(-960, rowY(0) + 190));
  kickMath.label = 'Kick Sweep';
  appState.setParam(kickMath.id, 'gainA', 0.2); // sweep depth, semitones/127
  appState.setParam(kickMath.id, 'offset', 0.23); // body pitch ≈ 44 Hz
  wire(kickPitchEnv.id, 'out', kickMath.id, 'a');
  const kickOsc = appState.addModule('osc', ...at(-960, rowY(0)));
  kickOsc.label = 'Kick Osc';
  appState.setParam(kickOsc.id, 'wave', 0); // sine
  wire(kickMath.id, 'out', kickOsc.id, 'pitch');
  const kickVca = voiceVca(-680, rowY(0), kick.amp.id, 0.9);
  wire(kickOsc.id, 'out', kickVca.id, 'in');

  // -- shared noise source for snare rattle, clap and hats --------------------
  const noise = appState.addModule('osc', ...at(-1240, rowY(0) - 220));
  noise.label = 'Noise';
  appState.setParam(noise.id, 'wave', OSC_WAVES.indexOf('noise'));

  // -- snare: sine tone + highpassed noise, each with its own envelope --------
  const snare = trigRow('Snare', 1, [4, 12], 0.16); // amp = noise (rattle) env
  const snareToneEnv = env('Snare Tone Env', -1240, rowY(1) + 190, 0.09);
  wire(snare.seq.id, 'notes', snareToneEnv.id, 'notes');
  const snareOsc = appState.addModule('osc', ...at(-960, rowY(1)));
  snareOsc.label = 'Snare Osc';
  appState.setParam(snareOsc.id, 'wave', 0);
  appState.setParam(snareOsc.id, 'semi', -6); // ≈ 185 Hz drum body
  const snareToneVca = voiceVca(-680, rowY(1), snareToneEnv.id, 0.75);
  wire(snareOsc.id, 'out', snareToneVca.id, 'in');
  const snareVcf = appState.addModule('vcf', ...at(-960, rowY(1) + 190));
  snareVcf.label = 'Snare Noise';
  appState.setParam(snareVcf.id, 'mode', VCF_MODES.indexOf('highpass'));
  appState.setParam(snareVcf.id, 'cutoff', 1800);
  wire(noise.id, 'out', snareVcf.id, 'in');
  const snareNoiseVca = voiceVca(-680, rowY(1) + 190, snare.amp.id, 0.7);
  wire(snareVcf.id, 'out', snareNoiseVca.id, 'in');

  // -- clap: bandpassed noise with a softened attack (must still complete
  // within the ~6 ms sequencer gate, or the release starts from half level)
  const clap = trigRow('Clap', 2, [12], 0.18, 0.005);
  const clapVcf = appState.addModule('vcf', ...at(-960, rowY(2)));
  clapVcf.label = 'Clap Tone';
  appState.setParam(clapVcf.id, 'mode', VCF_MODES.indexOf('bandpass'));
  appState.setParam(clapVcf.id, 'cutoff', 1100);
  appState.setParam(clapVcf.id, 'res', 0.5);
  wire(noise.id, 'out', clapVcf.id, 'in');
  const clapVca = voiceVca(-680, rowY(2), clap.amp.id, 0.75);
  wire(clapVcf.id, 'out', clapVca.id, 'in');

  // -- hats: one highpass over the noise, short and long envelopes ------------
  const ch = trigRow('CH', 3, [0, 2, 4, 6, 8, 10, 12], 0.05);
  const oh = trigRow('OH', 4, [14], 0.4);
  const hatVcf = appState.addModule('vcf', ...at(-960, rowY(3)));
  hatVcf.label = 'Hat Tone';
  appState.setParam(hatVcf.id, 'mode', VCF_MODES.indexOf('highpass'));
  appState.setParam(hatVcf.id, 'cutoff', 7500);
  wire(noise.id, 'out', hatVcf.id, 'in');
  const chVca = voiceVca(-680, rowY(3), ch.amp.id, 0.45);
  const ohVca = voiceVca(-680, rowY(4), oh.amp.id, 0.45);
  wire(hatVcf.id, 'out', chVca.id, 'in');
  wire(hatVcf.id, 'out', ohVca.id, 'in');

  // -- toms: tuned sines, empty rows ready for fills ---------------------------
  const tomL = trigRow('Tom L', 5, [], 0.3);
  const tomH = trigRow('Tom H', 6, [], 0.24);
  const tomLOsc = appState.addModule('osc', ...at(-960, rowY(5)));
  tomLOsc.label = 'Tom L Osc';
  appState.setParam(tomLOsc.id, 'wave', 0);
  appState.setParam(tomLOsc.id, 'octave', -1);
  appState.setParam(tomLOsc.id, 'semi', -5); // ≈ 98 Hz
  const tomHOsc = appState.addModule('osc', ...at(-960, rowY(6)));
  tomHOsc.label = 'Tom H Osc';
  appState.setParam(tomHOsc.id, 'wave', 0);
  appState.setParam(tomHOsc.id, 'octave', -1);
  appState.setParam(tomHOsc.id, 'semi', 2); // ≈ 147 Hz
  const tomLVca = voiceVca(-680, rowY(5), tomL.amp.id, 0.7);
  const tomHVca = voiceVca(-680, rowY(6), tomH.amp.id, 0.7);
  wire(tomLOsc.id, 'out', tomLVca.id, 'in');
  wire(tomHOsc.id, 'out', tomHVca.id, 'in');

  // -- sum: kick / snare+clap / hats / toms on the four mixer channels --------
  const mixer = appState.addModule('mixer', ...at(-380, rowY(1)));
  const audioOut = appState.ensureAudioOut(...at(40, rowY(2)));
  wire(kickVca.id, 'out', mixer.id, 'in1');
  for (const v of [snareToneVca, snareNoiseVca, clapVca]) wire(v.id, 'out', mixer.id, 'in2');
  for (const v of [chVca, ohVca]) wire(v.id, 'out', mixer.id, 'in3');
  for (const v of [tomLVca, tomHVca]) wire(v.id, 'out', mixer.id, 'in4');
  wire(mixer.id, 'out', audioOut.id, 'in');

  // -- 808-style panel: per-drum sound shaping + the pattern rows -------------
  const group = appState.graph.createGroup(
    'Drum Synth',
    [
      kick.seq.id, kick.amp.id, kickPitchEnv.id, kickMath.id, kickOsc.id, kickVca.id,
      noise.id,
      snare.seq.id, snare.amp.id, snareToneEnv.id, snareOsc.id, snareToneVca.id, snareVcf.id, snareNoiseVca.id,
      clap.seq.id, clap.amp.id, clapVcf.id, clapVca.id,
      ch.seq.id, ch.amp.id, oh.seq.id, oh.amp.id, hatVcf.id, chVca.id, ohVca.id,
      tomL.seq.id, tomL.amp.id, tomLOsc.id, tomLVca.id,
      tomH.seq.id, tomH.amp.id, tomHOsc.id, tomHVca.id,
      mixer.id,
    ],
    [],
    cx - 100, cy + 45,
  );
  const view = (id: string, x: number, y: number, label: string, moduleId: string) =>
    ({ id, kind: 'view' as const, x, y, w: 320, h: 104, label, moduleId });
  appState.setGroupFace(group.id, {
    width: 660,
    height: 830,
    grid: 10,
    snap: true,
    elements: [
      caption('c1', 10, 10, 'KICK'),
      knob('k1', 10, 28, 'Tune', kickMath.id, 'offset'),
      knob('k2', 90, 28, 'Punch', kickMath.id, 'gainA'),
      knob('k3', 170, 28, 'Decay', kick.amp.id, 'release'),
      knob('k4', 250, 28, 'Level', kickVca.id, 'level'),
      caption('c2', 340, 10, 'SNARE'),
      knob('s1', 340, 28, 'Tone', snareOsc.id, 'semi'),
      knob('s2', 420, 28, 'Snap', snareNoiseVca.id, 'level'),
      knob('s3', 500, 28, 'Decay', snare.amp.id, 'release'),
      knob('s4', 580, 28, 'Level', snareToneVca.id, 'level'),
      caption('c3', 10, 124, 'CLAP'),
      knob('p1', 10, 142, 'Tone', clapVcf.id, 'cutoff'),
      knob('p2', 90, 142, 'Decay', clap.amp.id, 'release'),
      knob('p3', 170, 142, 'Level', clapVca.id, 'level'),
      caption('c4', 260, 124, 'HATS'),
      knob('h1', 260, 142, 'Tone', hatVcf.id, 'cutoff'),
      knob('h2', 340, 142, 'CH Dec', ch.amp.id, 'release'),
      knob('h3', 420, 142, 'OH Dec', oh.amp.id, 'release'),
      knob('h4', 500, 142, 'CH Lvl', chVca.id, 'level'),
      knob('h5', 580, 142, 'OH Lvl', ohVca.id, 'level'),
      caption('c5', 10, 238, 'TOMS'),
      knob('t1', 10, 256, 'Tune L', tomLOsc.id, 'semi'),
      knob('t2', 90, 256, 'Decay L', tomL.amp.id, 'release'),
      knob('t3', 170, 256, 'Lvl L', tomLVca.id, 'level'),
      knob('t4', 250, 256, 'Tune H', tomHOsc.id, 'semi'),
      knob('t5', 330, 256, 'Decay H', tomH.amp.id, 'release'),
      knob('t6', 410, 256, 'Lvl H', tomHVca.id, 'level'),
      caption('c6', 10, 352, 'PATTERNS — click tiles to edit the beat'),
      view('v1', 10, 370, 'Kick', kick.seq.id),
      view('v2', 340, 370, 'Snare', snare.seq.id),
      view('v3', 10, 484, 'Clap', clap.seq.id),
      view('v4', 340, 484, 'CH', ch.seq.id),
      view('v5', 10, 598, 'OH', oh.seq.id),
      view('v6', 340, 598, 'Tom L', tomL.seq.id),
      view('v7', 10, 712, 'Tom H', tomH.seq.id),
      { id: 'm1', kind: 'meter' as const, x: 340, y: 760, w: 310, h: 16, label: 'Out', moduleId: mixer.id },
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
    description: '4-osc stack with nested face panels: Oscillators/Envelopes/FX sub-panels, composer clip, filter curve, space XY — press play',
    add: () => {
      const c = patchCanvas.viewCenter();
      addPolySynth(c.x, c.y);
    },
  },
  {
    name: 'Mono Synth',
    description: '1-voice lead/bass: Voice → 2 Osc → Filter → Amp, two Envelopes, LFO — wire a note source',
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
  {
    name: 'Drum Synth',
    description: '7 drum voices synthesized live (sine bodies + filtered noise), a trigger row each, 808-style panel — press play',
    add: () => {
      const c = patchCanvas.viewCenter();
      addDrumSynth(c.x, c.y);
    },
  },
];
