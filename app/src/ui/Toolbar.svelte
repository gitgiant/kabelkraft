<script lang="ts">
  import { onMount } from 'svelte';
  import { appState } from '../state';

  let projectName = $state(appState.projectName);
  let tempo = $state(appState.transport.tempo);
  let playing = $state(appState.transport.playing);
  let audioOn = $state(false);
  let fileInput: HTMLInputElement;

  onMount(() => {
    const offT = appState.on('transportChanged', () => {
      tempo = appState.transport.tempo;
      playing = appState.transport.playing;
    });
    const offP = appState.on('projectLoaded', () => {
      projectName = appState.projectName;
    });
    const poll = setInterval(() => (audioOn = appState.engine.running), 500);
    return () => {
      offT();
      offP();
      clearInterval(poll);
    };
  });

  async function enableAudio() {
    await appState.ensureEngine();
    audioOn = appState.engine.running;
  }

  function saveProject() {
    appState.projectName = projectName || 'Untitled';
    const blob = new Blob([appState.serialize()], { type: 'application/json' });
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
</script>

<div class="toolbar">
  <span class="logo">KabelKraft</span>
  <input class="project-name" bind:value={projectName} title="Project name" />
  <button onclick={saveProject} title="Save project as .kkproj">Save</button>
  <button onclick={() => fileInput.click()} title="Load a .kkproj project">Load</button>
  <input bind:this={fileInput} type="file" accept=".kkproj,application/json" hidden onchange={loadProject} />

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
    background: #1f1f26;
    border-bottom: 1px solid #34343f;
    user-select: none;
  }
  .logo {
    font-weight: 700;
    letter-spacing: 0.5px;
    color: #ffb13d;
    margin-right: 8px;
  }
  .project-name {
    width: 160px;
  }
  .spacer {
    flex: 1;
  }
  .transport {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 6px;
    background: #26262e;
  }
  .transport.playing {
    outline: 1px solid #52e07a;
  }
  .transport label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: #9090a0;
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
