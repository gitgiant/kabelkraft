<script lang="ts">
  import { onMount } from 'svelte';
  import { patchCanvas } from './canvas/PatchCanvas';
  import { appState } from './state';
  import { appSettings, onSettingsChange, type AppSettings } from './core/settings';
  import { clearAutosave, readAutosave, writeAutosave } from './core/autosave';
  import AiImport from './ui/AiImport.svelte';
  import OptionsDialog from './ui/OptionsDialog.svelte';
  import FaceEditor from './ui/FaceEditor.svelte';
  import ModulePalette from './ui/ModulePalette.svelte';
  import PianoRoll from './ui/PianoRoll.svelte';
  import RangeConfig from './ui/RangeConfig.svelte';
  import SampleEditor from './ui/SampleEditor.svelte';
  import SampleLibrary from './ui/SampleLibrary.svelte';
  import Toolbar from './ui/Toolbar.svelte';
  import Tutorial from './ui/Tutorial.svelte';
  import VisEditor from './ui/VisEditor.svelte';
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
    if (!appSettings().general.qwertyPiano) return;
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

  // -- Settings-driven chrome (Options dialog writes, this applies) ----------

  function applyChrome(s: AppSettings) {
    // Non-standard but supported by every current engine; scales chrome and
    // canvas alike, and pointer coordinates stay consistent.
    (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom =
      s.display.uiScale === 1 ? '' : String(s.display.uiScale);
    appState.midi.disabledInputs = new Set(s.midi.disabledInputs);
  }

  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (appSettings().general.confirmLeave) e.preventDefault();
  }

  // -- Autosave (Options → General): debounced full-project snapshot ---------

  let restoreOffer = $state<{ savedAt: number; projectName: string } | null>(null);
  let restoreJson: string | null = null;

  function restoreSession(apply: boolean) {
    if (apply && restoreJson) {
      const warnings = appState.loadProject(restoreJson);
      if (warnings.length) alert(`Session restored with warnings:\n${warnings.join('\n')}`);
    } else {
      void clearAutosave();
    }
    restoreOffer = null;
    restoreJson = null;
  }

  onMount(() => {
    const s = appSettings();
    applyChrome(s);
    const offSettings = onSettingsChange(applyChrome);
    window.addEventListener('beforeunload', onBeforeUnload);

    void patchCanvas.mount(canvasContainer).then(() => {
      addPolySynth();
      // A fresh session starts at the configured default tempo.
      if (s.general.defaultTempo !== appState.transport.tempo) {
        appState.setTempo(s.general.defaultTempo);
      }
    });

    // Offer to restore the last autosaved session (newer work may be lost).
    void readAutosave().then((rec) => {
      if (rec && appSettings().general.autosave) {
        restoreOffer = { savedAt: rec.savedAt, projectName: rec.projectName };
        restoreJson = rec.json;
      }
    });

    let dirty = false;
    let lastSave = Date.now();
    const markDirty = () => (dirty = true);
    const offDirty = (['graphChanged', 'paramChanged', 'sampleLoaded', 'projectMetaChanged'] as const)
      .map((ev) => appState.on(ev, markDirty));
    const saver = setInterval(() => {
      const g = appSettings().general;
      if (!g.autosave || !dirty) return;
      if (Date.now() - lastSave < g.autosaveInterval * 1000) return;
      dirty = false;
      lastSave = Date.now();
      void writeAutosave({
        json: appState.serializeWithSamples(),
        savedAt: lastSave,
        projectName: appState.projectName,
      }).catch(() => undefined);
    }, 1000);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    const offComposer = appState.on('composerChanged', () => {
      composerIds = [...appState.composerOpen];
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('beforeunload', onBeforeUnload);
      offComposer();
      offSettings();
      for (const off of offDirty) off();
      clearInterval(saver);
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
  <VisEditor />
  <VisualizerOverlay />
  <AiImport />
  <FaceEditor />
  <OptionsDialog />
</div>

{#if restoreOffer}
  <div class="restore-backdrop">
    <div class="restore-dialog" role="dialog" aria-label="Restore session">
      <p>
        Restore the autosaved session <strong>{restoreOffer.projectName}</strong>
        from {new Date(restoreOffer.savedAt).toLocaleString()}?
      </p>
      <div class="restore-actions">
        <button class="restore-yes" onclick={() => restoreSession(true)}>↩ Restore</button>
        <button class="restore-no" onclick={() => restoreSession(false)}>Discard</button>
      </div>
    </div>
  </div>
{/if}

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
  .restore-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 95;
  }
  .restore-dialog {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    padding: 18px 22px;
    max-width: 420px;
  }
  .restore-dialog p {
    margin: 0 0 14px;
    font-size: 13px;
    color: var(--text);
  }
  .restore-actions {
    display: flex;
    gap: 8px;
  }
  .restore-yes {
    background: var(--accent);
    color: #1a1a20;
    font-weight: 600;
  }
</style>
