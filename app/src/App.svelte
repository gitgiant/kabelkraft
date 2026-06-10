<script lang="ts">
  import { onMount } from 'svelte';
  import { patchCanvas } from './canvas/PatchCanvas';
  import { appState } from './state';
  import ModulePalette from './ui/ModulePalette.svelte';
  import Toolbar from './ui/Toolbar.svelte';

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
    // "60 seconds to sound" (PRD vision): a wired, playable starter patch.
    appState.addModule('transport', -120, -220);
    const keyboard = appState.addModule('keyboard', -480, 0);
    const synth = appState.addModule('synth', -120, -10);
    const audioOut = appState.addModule('audioOut', 220, 0);
    const levels = appState.addModule('levels', 220, 160);
    appState.connect(
      { moduleId: keyboard.id, portId: 'notes' },
      { moduleId: synth.id, portId: 'notes' },
    );
    appState.connect(
      { moduleId: synth.id, portId: 'out' },
      { moduleId: audioOut.id, portId: 'in' },
    );
    appState.connect(
      { moduleId: synth.id, portId: 'out' },
      { moduleId: levels.id, portId: 'in' },
    );
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
  </div>
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
