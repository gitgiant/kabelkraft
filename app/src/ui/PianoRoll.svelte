<script lang="ts">
  import { onMount } from 'svelte';
  import { clipFromData, type ComposerNote } from '../core/composer';
  import { patchCanvas } from '../canvas/PatchCanvas';
  import { appState } from '../state';
  import PianoRollCore from './PianoRollCore.svelte';

  // Composer host for the piano-roll editor (PRD §8.3). Edits commit straight
  // to the module's data, so the engine stays live. The panel sits INSIDE the
  // module: it pins to the tile's face area each frame and CSS-scales with the
  // canvas zoom, so the module's own title bar, ports and resize handles stay
  // the controls — same as any group tile. The editor itself is host-agnostic
  // (PianoRollCore); the song playlist reuses it (SONG_PLAN.md phase 4).

  const { moduleId }: { moduleId: string } = $props();
  let title = $state('Composer');
  let core = $state<PianoRollCore>();

  // Module face rect in tile-local px — must match ModuleView's buildFace()
  // (x = 18, top = TITLE_H + 10, bottom inset 12).
  const MODULE_TITLE_H = 24;
  const INSET_X = 18;
  const INSET_T = MODULE_TITLE_H + 10;
  const INSET_B = 12;

  // Placement (viewport px) + canvas zoom scale, recomputed each frame.
  let panelLeft = $state(0);
  let panelTop = $state(0);
  let scale = $state(1);
  let onScreen = $state(true);
  let active = $state(true);

  // Logical panel size (pre-scale px) — derived from the module tile size;
  // resize the module to resize the editor.
  let panelW = $state(684);
  let panelH = $state(434);

  /** True while a commit of ours is in flight — skip the graphChanged echo. */
  let suppressSync = false;
  let raf = 0;

  onMount(() => {
    const mod = appState.graph.modules.get(moduleId);
    title = mod?.label ?? 'Composer';
    active = appState.composerActive === moduleId;
    const offActive = appState.on('composerChanged', () => {
      active = appState.composerActive === moduleId;
    });
    const offGraph = appState.on('graphChanged', () => {
      if (suppressSync) return;
      // Module deleted while open: fold the panel instead of editing a ghost.
      if (!appState.graph.modules.get(moduleId)) {
        appState.closeComposer(moduleId);
        return;
      }
      core?.refresh(true);
    });
    // Container-tile 🤖 button: open this roll's AI popup. The request may
    // predate this mount (button on a closed composer), so consume it both
    // on mount and on the event.
    const consumeAiRequest = () => {
      if (appState.composerAiRequest !== moduleId) return;
      appState.composerAiRequest = null;
      core?.openAi();
    };
    const offAi = appState.on('composerAiRequest', consumeAiRequest);
    consumeAiRequest();
    const tick = () => {
      reposition();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      offActive();
      offGraph();
      offAi();
      cancelAnimationFrame(raf);
    };
  });

  /** Pin the panel over the module's face area each frame, tracking zoom. */
  function reposition() {
    const r = patchCanvas.clientRectFor(moduleId);
    if (!r || !r.onScreen) {
      onScreen = false;
      return;
    }
    onScreen = true;
    scale = r.scale;
    panelW = r.width / r.scale - INSET_X * 2;
    panelH = r.height / r.scale - INSET_T - INSET_B;
    panelLeft = r.left + INSET_X * r.scale;
    panelTop = r.top + INSET_T * r.scale;
  }

  // -- host callbacks for the core editor -------------------------------------

  function getClip() {
    return clipFromData(appState.graph.modules.get(moduleId)?.data);
  }

  function onNotesChange(notes: ComposerNote[]) {
    suppressSync = true;
    appState.setModuleData(moduleId, 'notes', notes);
    suppressSync = false;
  }

  function onLengthChange(len: number) {
    suppressSync = true;
    appState.setModuleData(moduleId, 'length', len);
    suppressSync = false;
  }

  function onPreview(pitch: number | null) {
    if (pitch === null) appState.noteOff(moduleId, 'roll-preview');
    else appState.noteOn(moduleId, 'roll-preview', pitch, 0.8);
  }

  /** Playhead: the composer clip free-loops against the transport. */
  function playheadBeat(): number | null {
    if (!appState.transport.playing) return null;
    const len = getClip().length;
    return ((appState.transport.songPosition % len) + len) % len;
  }

  /** Drag the bottom-right grip to resize the underlying composer tile. */
  function onResizeGrip(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    appState.beginUndoable();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = panelW;
    const startH = panelH;
    const onMove = (ev: PointerEvent) => {
      const w = startW + (ev.clientX - startX) / scale + INSET_X * 2;
      const h = startH + (ev.clientY - startY) / scale + INSET_T + INSET_B;
      appState.setTileSize(moduleId, w, h);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }
</script>

<div
  class="piano-roll"
  class:active
  style="left:{panelLeft}px;top:{panelTop}px;width:{panelW}px;height:{panelH}px;transform:scale({scale});visibility:{onScreen ? 'visible' : 'hidden'}"
  onpointerdown={() => appState.raiseComposer(moduleId)}
>
  <PianoRollCore
    bind:this={core}
    {title}
    {active}
    {scale}
    {getClip}
    {onNotesChange}
    {onLengthChange}
    {onPreview}
    {onResizeGrip}
    {playheadBeat}
    aiTargetModuleId={moduleId}
    onClose={() => appState.closeComposer(moduleId)}
  />
</div>

<style>
  .piano-roll {
    position: fixed;
    z-index: 50;
    transform-origin: 0 0;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    padding: 8px;
    box-sizing: border-box;
    overflow: hidden;
  }
  .piano-roll.active {
    z-index: 51;
    border-color: var(--accent);
  }
</style>
