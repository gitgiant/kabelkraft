<script lang="ts">
  import { onMount } from 'svelte';
  import { patchCanvas } from '../canvas/PatchCanvas';
  import { appState } from '../state';
  import { setTheme, theme } from '../theme';

  let projectName = $state(appState.projectName);
  let tempo = $state(appState.transport.tempo);
  let playing = $state(appState.transport.playing);
  let audioOn = $state(false);
  let canUndo = $state(false);
  let canRedo = $state(false);
  let canGroup = $state(false);
  let selectedGroup = $state<string | null>(null);
  let canShrink = $state(false);
  let fileInput: HTMLInputElement;
  let kkmodInput: HTMLInputElement;

  function refreshEditState() {
    canUndo = appState.canUndo;
    canRedo = appState.canRedo;
    canGroup = appState.selectedModuleIds.size + appState.selectedGroupIds.size >= 2;
    selectedGroup = [...appState.selectedGroupIds][0] ?? null;
    canShrink = appState.shrinkableGroupId() !== null;
  }

  let midiLearnArmed = $state(false);

  function onLearnKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && appState.midiLearn) appState.cancelMidiLearn();
  }

  onMount(() => {
    const offM = appState.on('midiChanged', () => {
      midiLearnArmed = appState.midiLearn !== null;
    });
    window.addEventListener('keydown', onLearnKey);
    const offT = appState.on('transportChanged', () => {
      tempo = appState.transport.tempo;
      playing = appState.transport.playing;
    });
    const offP = appState.on('projectLoaded', () => {
      projectName = appState.projectName;
    });
    const offG = appState.on('graphChanged', refreshEditState);
    const offS = appState.on('selectionChanged', refreshEditState);
    const poll = setInterval(() => (audioOn = appState.engine.running), 500);
    return () => {
      offM();
      window.removeEventListener('keydown', onLearnKey);
      offT();
      offP();
      offG();
      offS();
      clearInterval(poll);
    };
  });

  async function enableAudio() {
    await appState.ensureEngine();
    audioOn = appState.engine.running;
  }

  function saveProject() {
    appState.projectName = projectName || 'Untitled';
    const blob = new Blob([appState.serializeWithSamples()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${appState.projectName}.kkproj`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function loadProject(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const warnings = appState.loadProject(await file.text());
    if (warnings.length) alert(`Project loaded with warnings:\n${warnings.join('\n')}`);
    fileInput.value = '';
  }

  let themeName = $state(theme.name);

  function toggleTheme() {
    themeName = themeName === 'dark' ? 'light' : 'dark';
    setTheme(themeName);
  }

  // Tutorial may rearrange the patch — offer to save first.
  let tutorialPrompt = $state(false);

  function startTutorial() {
    tutorialPrompt = true;
  }

  function launchTutorial(saveFirst: boolean) {
    if (saveFirst) saveProject();
    tutorialPrompt = false;
    window.dispatchEvent(new CustomEvent('kk-start-tutorial'));
  }

  // -- Module faces (design framework over groups) --------------------------

  function newFace() {
    const c = patchCanvas.viewCenter();
    const id = appState.newFaceModule(c.x, c.y);
    appState.openFaceEditor(id);
  }

  function exportKkmod() {
    if (!selectedGroup) return;
    const group = appState.graph.groups.get(selectedGroup);
    if (!group) return;
    const blob = new Blob([appState.exportFaceGroup(selectedGroup)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${group.name}.kkmod`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function importKkmod(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const c = patchCanvas.viewCenter();
    const result = appState.importFaceGroup(await file.text(), c);
    if (!result.ok) alert(`Import failed:\n${result.errors.join('\n')}`);
    else if (result.warnings.length) alert(`Imported with warnings:\n${result.warnings.join('\n')}`);
    kkmodInput.value = '';
  }
</script>

<div class="toolbar">
  <span class="logo">KabelKraft</span>
  <input class="project-name" bind:value={projectName} title="Project name" />
  <button onclick={saveProject} title="Save project as .kkproj">Save</button>
  <button onclick={() => fileInput.click()} title="Load a .kkproj project">Load</button>
  <input bind:this={fileInput} type="file" accept=".kkproj,application/json" hidden onchange={loadProject} />

  <span class="divider"></span>

  <button disabled={!canUndo} onclick={() => appState.undo()} title="Undo (Cmd/Ctrl+Z)">↶</button>
  <button disabled={!canRedo} onclick={() => appState.redo()} title="Redo (Cmd/Ctrl+Shift+Z)">↷</button>
  <button disabled={!canGroup} onclick={() => appState.groupSelection()} title="Group selection (Cmd/Ctrl+G). Shift-click or shift-drag to multi-select.">
    Group
  </button>
  <button disabled={!selectedGroup} onclick={() => selectedGroup && appState.ungroup(selectedGroup)} title="Ungroup (Cmd/Ctrl+Shift+G)">
    Ungroup
  </button>

  <span class="divider"></span>

  <button class="new-face" onclick={newFace} title="New blank module face: design a control panel, then fill the group with modules">
    ✚ Face
  </button>
  <button
    class="edit-face"
    disabled={!selectedGroup}
    onclick={() => selectedGroup && appState.openFaceEditor(selectedGroup)}
    title="Design this group's module face: knobs, sliders, XY pads bound to inner params"
  >
    🎛 Edit Face
  </button>
  <button
    class="shrink"
    disabled={!canShrink}
    onclick={() => appState.shrinkSelection()}
    title="Pull the expanded group back into its module face"
  >
    ⤡ Shrink
  </button>
  <button class="export-kkmod" disabled={!selectedGroup} onclick={exportKkmod} title="Export the selected group (modules + wires + face) as a reusable .kkmod">
    ⬇ .kkmod
  </button>
  <button class="import-kkmod" onclick={() => kkmodInput.click()} title="Import a .kkmod custom module">⬆ .kkmod</button>
  <input bind:this={kkmodInput} type="file" accept=".kkmod,application/json" hidden onchange={importKkmod} />

  <span class="spacer"></span>

  <div class="transport" class:playing>
    <button onclick={() => appState.transportCommand('rewind')} title="Rewind">⏮</button>
    <button onclick={() => appState.transportCommand('play')} title="Play">▶</button>
    <button onclick={() => appState.transportCommand('pause')} title="Pause">⏸</button>
    <button onclick={() => appState.transportCommand('stop')} title="Stop">⏹</button>
    <label title="Master tempo (PRD: default 120 BPM)">
      <input
        type="number"
        min="20"
        max="300"
        value={Math.round(tempo)}
        onchange={(e) => appState.setTempo(Number(e.currentTarget.value))}
      />
      BPM
    </label>
  </div>

  <span class="spacer"></span>

  {#if midiLearnArmed}
    <span class="midi-learn" title="Move a control on your MIDI device to map it. Esc cancels.">
      🎛 MIDI learn… (Esc)
    </span>
  {/if}

  <button
    class="ai-toggle"
    onclick={() => window.dispatchEvent(new CustomEvent('kk-ai-import'))}
    title="AI patches: generate in-app with Claude or a local LLM, or copy the spec for any chatbot"
  >
    🤖 AI
  </button>
  <button
    class="library-toggle"
    onclick={() => window.dispatchEvent(new CustomEvent('kk-toggle-library'))}
    title="Sample Library: browse your own folders, audition, drag onto Sampler/Drum pads"
  >
    🗂 Samples
  </button>
  <button class="theme-toggle" onclick={toggleTheme} title="Toggle dark/light theme">
    {themeName === 'dark' ? '☀' : '🌙'}
  </button>
  <button onclick={startTutorial} title="Start the tutorial">?</button>

  {#if !audioOn}
    <button class="enable-audio" onclick={enableAudio}>🔊 Enable Audio</button>
  {:else}
    <span class="audio-on" title="Audio engine running">🔊</span>
  {/if}
</div>

{#if tutorialPrompt}
  <div class="tutorial-backdrop">
    <div class="tutorial-dialog" role="dialog" aria-label="Start tutorial">
      <p>Start the tutorial? You can save your project first.</p>
      <div class="tutorial-actions">
        <button class="save-start" onclick={() => launchTutorial(true)}>💾 Save & start</button>
        <button class="just-start" onclick={() => launchTutorial(false)}>Start without saving</button>
        <button class="cancel-tutorial" onclick={() => (tutorialPrompt = false)}>Cancel</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--panel);
    border-bottom: 1px solid var(--panel-border);
    user-select: none;
  }
  .logo {
    font-weight: 700;
    letter-spacing: 0.5px;
    color: var(--accent);
    margin-right: 8px;
  }
  .project-name {
    width: 160px;
  }
  .spacer {
    flex: 1;
  }
  .divider {
    width: 1px;
    height: 20px;
    background: var(--panel-border);
    margin: 0 4px;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .transport {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 6px;
    background: var(--control);
  }
  .transport.playing {
    outline: 1px solid #52e07a;
  }
  .transport label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .transport input[type='number'] {
    width: 56px;
  }
  .enable-audio {
    background: #ffb13d;
    color: #1a1a20;
    font-weight: 600;
  }
  .midi-learn {
    font-size: 12px;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 2px 8px;
    animation: pulse 1s infinite alternate;
  }
  @keyframes pulse {
    from { opacity: 1; }
    to { opacity: 0.5; }
  }
  .audio-on {
    padding: 0 6px;
  }
  .tutorial-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 70;
  }
  .tutorial-dialog {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    padding: 18px 22px;
    max-width: 360px;
  }
  .tutorial-dialog p {
    margin: 0 0 14px;
    font-size: 13px;
    color: var(--text);
  }
  .tutorial-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .save-start {
    background: var(--accent);
    color: #1a1a20;
    font-weight: 600;
  }
</style>
