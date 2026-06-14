<script lang="ts">
  import { onMount } from 'svelte';
  import { patchCanvas } from '../canvas/PatchCanvas';
  import { appSettings, updateSettings } from '../core/settings';
  import { appState } from '../state';
  import { downloadProject } from './project-io';

  let projectName = $state(appState.projectName);
  let tempo = $state(appState.transport.tempo);
  let playing = $state(appState.transport.playing);
  let audioOn = $state(false);
  let muted = $state(false);
  let canUndo = $state(false);
  let canRedo = $state(false);
  let canGroup = $state(false);
  let canAutoWire = $state(false);
  let selectedGroup = $state<string | null>(null);
  let canShrink = $state(false);
  let fileInput: HTMLInputElement;
  let kkmodInput: HTMLInputElement;
  let showCacheDialog = $state(false);

  function clearCacheAndReload() {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).finally(() => {
      location.reload();
    });
  }

  function refreshEditState() {
    canUndo = appState.canUndo;
    canRedo = appState.canRedo;
    canGroup = appState.selectedModuleIds.size + appState.selectedGroupIds.size >= 2;
    const wireTargets = appState.autoWireTargets();
    canAutoWire = wireTargets.moduleIds.length + wireTargets.groupIds.length >= 2;
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
    const offN = appState.on('projectMetaChanged', () => {
      projectName = appState.projectName;
    });
    const offG = appState.on('graphChanged', refreshEditState);
    const offS = appState.on('selectionChanged', refreshEditState);
    const poll = setInterval(() => {
      audioOn = appState.engine.running;
      const a = appSettings().audio;
      muted = a.muted || a.masterGain === 0;
    }, 500);
    return () => {
      offM();
      window.removeEventListener('keydown', onLearnKey);
      offT();
      offP();
      offN();
      offG();
      offS();
      clearInterval(poll);
    };
  });

  async function enableAudio() {
    try {
      await appState.ensureEngine();
    } catch (err) {
      // Never fail silently — surface why the engine couldn't start
      // (insecure context, device trouble, worklet load failure…).
      alert(`Audio failed to start:\n${err instanceof Error ? err.message : String(err)}`);
    }
    audioOn = appState.engine.running;
  }

  function unmute() {
    updateSettings((s) => {
      s.audio.muted = false;
      if (s.audio.masterGain === 0) s.audio.masterGain = 1;
    });
    const a = appSettings().audio;
    appState.engine.setMasterGain(a.masterGain);
    muted = false;
  }

  function saveProject() {
    appState.projectName = projectName || 'Untitled';
    downloadProject();
  }

  async function loadProject(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const warnings = appState.loadProject(await file.text());
    if (warnings.length) alert(`Project loaded with warnings:\n${warnings.join('\n')}`);
    fileInput.value = '';
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

  // -- Drag-to-hide: grip under the toolbar slides it away -------------------

  let toolbarEl: HTMLDivElement;
  // null = open at natural (auto) height so flex-wrap reflow keeps working.
  let toolbarHeight = $state<number | null>(null);
  let tDragging = $state(false);
  let tDragStartY = 0;
  let tDragStartHeight = 0;
  let tDragMoved = false;
  let tOpenTimer: ReturnType<typeof setTimeout> | undefined;

  function openToolbar() {
    toolbarHeight = toolbarEl.scrollHeight;
    clearTimeout(tOpenTimer);
    tOpenTimer = setTimeout(() => (toolbarHeight = null), 180);
  }

  function onTGripDown(e: PointerEvent) {
    tDragging = true;
    tDragMoved = false;
    tDragStartY = e.clientY;
    tDragStartHeight = toolbarHeight ?? toolbarEl.scrollHeight;
    clearTimeout(tOpenTimer);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onTGripMove(e: PointerEvent) {
    if (!tDragging) return;
    const dy = e.clientY - tDragStartY;
    if (Math.abs(dy) > 3) tDragMoved = true;
    toolbarHeight = Math.max(0, Math.min(toolbarEl.scrollHeight, tDragStartHeight + dy));
  }

  function onTGripUp() {
    if (!tDragging) return;
    tDragging = false;
    const full = toolbarEl.scrollHeight;
    const h = toolbarHeight ?? full;
    if (!tDragMoved) {
      if (h > 0) toolbarHeight = 0;
      else openToolbar();
    } else if (h < full / 2) {
      toolbarHeight = 0;
    } else {
      openToolbar();
    }
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

<div
  class="toolbar-clip"
  class:dragging={tDragging}
  style={toolbarHeight === null ? '' : `height: ${toolbarHeight}px`}
>
<div class="toolbar" bind:this={toolbarEl}>
  <div class="tgroup">
    <span class="logo" ondblclick={() => showCacheDialog = true} title="Double-click to clear cache">KabelKraft</span>
    <input class="project-name" bind:value={projectName} title="Project name" />
    <button onclick={saveProject} title="Save project as .kkproj">Save</button>
    <button onclick={() => fileInput.click()} title="Load a .kkproj project">Load</button>
    <input bind:this={fileInput} type="file" accept=".kkproj,application/json" hidden onchange={loadProject} />
  </div>

  <span class="divider"></span>

  <div class="tgroup">
    <button disabled={!canUndo} onclick={() => appState.undo()} title="Undo (Cmd/Ctrl+Z)">↶</button>
    <button disabled={!canRedo} onclick={() => appState.redo()} title="Redo (Cmd/Ctrl+Shift+Z)">↷</button>
    <button disabled={!canGroup} onclick={() => appState.groupSelection()} title="Group selection (Cmd/Ctrl+G). Shift-click or shift-drag to multi-select.">
      Group
    </button>
    <button disabled={!selectedGroup} onclick={() => selectedGroup && appState.ungroup(selectedGroup)} title="Ungroup (Cmd/Ctrl+Shift+G)">
      Ungroup
    </button>
    <button class="arrange" onclick={() => patchCanvas.autoArrange()} title="Auto-arrange: lay modules out left-to-right by signal flow">
      ⇶ Arrange
    </button>
    <button
      class="auto-wire"
      disabled={!canAutoWire}
      onclick={() => appState.autoWireSelection()}
      title="Auto-wire: connect free outputs to matching free inputs, left to right. Wires the selection — or the whole patch when nothing is selected. Groups join in through their poles."
    >
      ⚡ Wire
    </button>
  </div>

  <span class="divider"></span>

  <div class="tgroup">
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
  </div>

  <div class="transport tgroup push" class:playing>
    <button onclick={() => appState.transportCommand('rewind')} title="Rewind (Home)">⏮</button>
    <button onclick={() => appState.transportCommand('play')} title="Play (Space)">▶</button>
    <button onclick={() => appState.transportCommand('pause')} title="Pause (Space)">⏸</button>
    <button onclick={() => appState.transportCommand('stop')} title="Stop (Enter)">⏹</button>
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

  <div class="tgroup push">
    {#if midiLearnArmed}
      <span class="midi-learn" title="Move a control on your MIDI device to map it. Esc cancels.">
        🎛 MIDI learn… (Esc)
      </span>
    {/if}

    <button
      class="ai-toggle"
      onclick={() => window.dispatchEvent(new CustomEvent('kk-ai-import'))}
      title="AI patches: generate in-app with Claude, OpenRouter, or any OpenAI-compatible endpoint — or copy the spec for any chatbot"
    >
      🤖 AI Patch
    </button>
    <button
      class="ai-project-toggle"
      onclick={() => window.dispatchEvent(new CustomEvent('kk-ai-project'))}
      title="AI project: generate a complete project — composers, synths, effects, mixer, output — with the music embedded"
    >
      🪄 AI Project
    </button>
    <button
      class="options-toggle"
      onclick={() => window.dispatchEvent(new CustomEvent('kk-options'))}
      title="Options: project, audio, MIDI, display, AI, autosave… (Cmd/Ctrl+,)"
    >
      ⚙
    </button>

    {#if !audioOn}
      <button class="enable-audio" onclick={enableAudio}>🔊 Enable Audio</button>
    {:else if muted}
      <button class="muted-warn" onclick={unmute}
        title="Output is muted in Options → Audio — click to unmute">
        🔇 Muted
      </button>
    {:else}
      <span class="audio-on" title="Audio engine running">🔊</span>
    {/if}
  </div>
</div>
</div>

{#if showCacheDialog}
  <div class="cache-dialog-backdrop" onclick={() => showCacheDialog = false}>
    <div class="cache-dialog" onclick={(e) => e.stopPropagation()}>
      <p>Clear browser cache and reload?</p>
      <div class="cache-dialog-buttons">
        <button onclick={clearCacheAndReload}>Clear & Restart</button>
        <button onclick={() => showCacheDialog = false}>Cancel</button>
      </div>
    </div>
  </div>
{/if}

<button
  class="toolbar-grip"
  title="Drag or click to hide/show the toolbar"
  aria-label="Hide or show toolbar"
  onpointerdown={onTGripDown}
  onpointermove={onTGripMove}
  onpointerup={onTGripUp}
  onpointercancel={onTGripUp}
>
  {toolbarHeight === 0 ? '▾' : '▴'}
</button>

<style>
  .toolbar-clip {
    overflow: hidden;
    flex-shrink: 0;
    transition: height 0.15s ease;
  }
  .toolbar-clip.dragging {
    transition: none;
  }
  .toolbar-grip {
    display: block;
    width: 100%;
    height: 12px;
    padding: 0;
    border: none;
    border-radius: 0;
    border-bottom: 1px solid var(--panel-border);
    background: var(--panel);
    color: var(--text-dim);
    font-size: 8px;
    line-height: 1;
    cursor: ns-resize;
    touch-action: none;
    user-select: none;
  }
  .toolbar-grip:hover {
    background: var(--control);
    color: var(--text);
  }
  /* Touch mode: make the hide/show grip a real thumb target. */
  :global(html.kk-touch) .toolbar-grip {
    height: 22px;
    font-size: 13px;
  }
  .toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 8px;
    padding: 6px 12px;
    background: var(--panel);
    border-bottom: 1px solid var(--panel-border);
    user-select: none;
  }
  /* Logical clusters wrap as units; never split a group across rows. */
  .tgroup {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  /* Push to the right edge on wide screens; collapses to a normal wrap
     when the toolbar runs out of horizontal room. */
  .push {
    margin-left: auto;
  }
  .logo {
    font-weight: 700;
    letter-spacing: 0.5px;
    color: var(--accent);
    margin-right: 8px;
  }
  .project-name {
    width: 160px;
    min-width: 90px;
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
  .muted-warn {
    background: #3a1414;
    border-color: #ff5a5a;
    color: #ff8a8a;
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
  .cache-dialog-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
  }
  .cache-dialog {
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    padding: 20px 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 260px;
  }
  .cache-dialog p {
    margin: 0;
    font-size: 14px;
  }
  .cache-dialog-buttons {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
</style>
