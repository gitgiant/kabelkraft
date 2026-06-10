<script lang="ts">
  import { onMount } from 'svelte';
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
  let fileInput: HTMLInputElement;

  function refreshEditState() {
    canUndo = appState.canUndo;
    canRedo = appState.canRedo;
    canGroup = appState.selectedModuleIds.size + appState.selectedGroupIds.size >= 2;
    selectedGroup = [...appState.selectedGroupIds][0] ?? null;
  }

  onMount(() => {
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

  function startTutorial() {
    window.dispatchEvent(new CustomEvent('kk-start-tutorial'));
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
  .audio-on {
    padding: 0 6px;
  }
</style>
