<script lang="ts">
  import { onMount } from 'svelte';
  import { patchCanvas } from './canvas/PatchCanvas';
  import { appState } from './state';
  import AiImport from './ui/AiImport.svelte';
  import FaceEditor from './ui/FaceEditor.svelte';
  import ModulePalette from './ui/ModulePalette.svelte';
  import SampleEditor from './ui/SampleEditor.svelte';
  import SampleLibrary from './ui/SampleLibrary.svelte';
  import Toolbar from './ui/Toolbar.svelte';
  import Tutorial from './ui/Tutorial.svelte';
  import VisualizerOverlay from './ui/VisualizerOverlay.svelte';

  let canvasContainer: HTMLDivElement;

  // QWERTY-as-piano (PRD §8.6): A-row plays, relative to each keyboard
  // module's octave param. C4 = 'a'.
  const QWERTY_SEMITONES: Record<string, number> = {
    a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
    k: 12, o: 13, l: 14,
  };

  function keyboardModules() {
    return [...appState.graph.modules.values()].filter((m) => m.type === 'keyboard');
  }

  function onKeyDown(e: KeyboardEvent) {
    const tag = (document.activeElement?.tagName ?? '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.repeat || e.metaKey || e.ctrlKey) return;
    const semi = QWERTY_SEMITONES[e.key.toLowerCase()];
    if (semi === undefined) return;
    for (const kb of keyboardModules()) {
      const pitch = 60 + semi + Math.round(kb.params.octave ?? 0) * 12;
      appState.noteOn(kb.id, `qwerty:${e.key.toLowerCase()}`, pitch);
    }
  }

  function onKeyUp(e: KeyboardEvent) {
    const semi = QWERTY_SEMITONES[e.key.toLowerCase()];
    if (semi === undefined) return;
    for (const kb of keyboardModules()) {
      appState.noteOff(kb.id, `qwerty:${e.key.toLowerCase()}`);
    }
  }

  function seedStarterPatch() {
    // "60 seconds to sound" (PRD vision): a synth built from the ground up
    // out of component modules — Voice (4 voices) → two detuned Oscillators
    // → Filter → Amp, with an ADSR on the amp, an LFO on the filter cutoff,
    // then Echo and Reverb. The whole chain lives in a "Poly Synth" group
    // whose face exposes the key knobs plus bypass buttons per effect.
    appState.addModule('transport', -150, -560);
    const sequencer = appState.addModule('sequencer', -940, -300);
    const keyboard = appState.addModule('keyboard', -900, -80);

    const voice = appState.addModule('voice', -600, -220);
    const osc1 = appState.addModule('osc', -350, -360);
    const osc2 = appState.addModule('osc', -350, -110);
    const adsr = appState.addModule('adsr', -600, -60);
    const lfo = appState.addModule('lfo', -600, 110);
    const vcf = appState.addModule('vcf', -110, -280);
    const vca = appState.addModule('vca', 170, -190);
    const delay = appState.addModule('delay', 390, -250);
    const reverb = appState.addModule('reverb', 640, -270);

    const audioOut = appState.addModule('audioOut', 910, -190);
    const levels = appState.addModule('levels', 910, -40);

    // Names the face binding labels pick up.
    osc1.label = 'Osc A';
    osc2.label = 'Osc B';
    adsr.label = 'Amp Env';
    delay.label = 'Echo';

    const wire = (fromId: string, fromPort: string, toId: string, toPort: string) =>
      appState.connect({ moduleId: fromId, portId: fromPort }, { moduleId: toId, portId: toPort });

    // Note sources into the 4-voice allocator.
    wire(sequencer.id, 'notes', voice.id, 'notes');
    wire(keyboard.id, 'notes', voice.id, 'notes');
    // Per-voice lanes through the component chain.
    wire(voice.id, 'pitch', osc1.id, 'pitch');
    wire(voice.id, 'pitch', osc2.id, 'pitch');
    wire(voice.id, 'gate', adsr.id, 'gate');
    wire(osc1.id, 'out', vcf.id, 'in');
    wire(osc2.id, 'out', vcf.id, 'in');
    wire(lfo.id, 'out', vcf.id, 'mod');
    wire(vcf.id, 'out', vca.id, 'in');
    wire(adsr.id, 'out', vca.id, 'cv');
    // FX tail and output.
    wire(vca.id, 'out', delay.id, 'in');
    wire(delay.id, 'out', reverb.id, 'in');
    wire(reverb.id, 'out', audioOut.id, 'in');
    wire(reverb.id, 'out', levels.id, 'in');

    // Detuned second osc and a slow filter wobble so the LFO is audible.
    appState.setParam(osc2.id, 'fine', 7);
    appState.setParam(vcf.id, 'amt', 1.2);
    appState.setParam(lfo.id, 'rate', 0.4);

    const group = appState.graph.createGroup(
      'Poly Synth',
      [voice.id, osc1.id, osc2.id, adsr.id, lfo.id, vcf.id, vca.id, delay.id, reverb.id],
      [],
      -100, -180,
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

  onMount(() => {
    void patchCanvas.mount(canvasContainer).then(() => seedStarterPatch());
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  });
</script>

<div class="layout">
  <Toolbar />
  <div class="main">
    <ModulePalette />
    <div class="canvas-container" bind:this={canvasContainer}></div>
    <SampleLibrary />
    <Tutorial />
  </div>
  <SampleEditor />
  <VisualizerOverlay />
  <AiImport />
  <FaceEditor />
</div>

<style>
  .layout {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .main {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .canvas-container {
    position: relative;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }
</style>
