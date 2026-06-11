<script lang="ts">
  import { onMount } from 'svelte';
  import { patchCanvas } from './canvas/PatchCanvas';
  import { appState } from './state';
  import AiImport from './ui/AiImport.svelte';
  import FaceEditor from './ui/FaceEditor.svelte';
  import ModulePalette from './ui/ModulePalette.svelte';
  import PianoRoll from './ui/PianoRoll.svelte';
  import RangeConfig from './ui/RangeConfig.svelte';
  import SampleEditor from './ui/SampleEditor.svelte';
  import SampleLibrary from './ui/SampleLibrary.svelte';
  import Toolbar from './ui/Toolbar.svelte';
  import Tutorial from './ui/Tutorial.svelte';
  import VisualizerOverlay from './ui/VisualizerOverlay.svelte';
  import { addPolySynth } from './ui/starters';

  let canvasContainer: HTMLDivElement;

  // Open composer panels (anchored over their modules); App owns mount/unmount.
  let composerIds = $state<string[]>([]);

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

  onMount(() => {
    void patchCanvas.mount(canvasContainer).then(() => addPolySynth());
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    const offComposer = appState.on('composerChanged', () => {
      composerIds = [...appState.composerOpen];
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      offComposer();
    };
  });
</script>

<div class="layout">
  <Toolbar />
  <div class="main">
    <ModulePalette />
    <div
      class="canvas-container"
      bind:this={canvasContainer}
      ondragover={(e) => e.preventDefault()}
      ondrop={(e) => {
        e.preventDefault();
        const type = e.dataTransfer?.getData('module-type');
        if (!type) return;
        const pos = patchCanvas.worldFromClient(e.clientX, e.clientY) ?? patchCanvas.viewCenter();
        const inst = appState.addModule(type, pos.x, pos.y);
        // A fresh Composer opens its anchored piano-roll panel.
        if (type === 'composer') appState.openComposer(inst.id);
      }}
    ></div>
    <SampleLibrary />
    <Tutorial />
  </div>
  <SampleEditor />
  {#each composerIds as id (id)}
    <PianoRoll moduleId={id} />
  {/each}
  <RangeConfig />
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
    touch-action: none; /* canvas owns all touch gestures (pinch-zoom, pan) */
  }
</style>
