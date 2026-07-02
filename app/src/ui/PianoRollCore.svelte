<script module lang="ts">
  import type { ComposerNote as _CN } from '../core/composer';
  // Shared across all open editors so a riff can be copied between clips —
  // composer to composer, and later composer to song clip.
  let clipboard: _CN[] = [];
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import {
    defaultNote,
    humanizeNotes,
    quantizeNotes,
    randomizeNotes,
    sortNotes,
    COMPOSER_MAX_LENGTH,
    COMPOSER_MIN_NOTE_LEN,
    type ComposerNote,
  } from '../core/composer';
  import type { ComposerClip } from '../core/composer';
  import { buildAiContext, buildMidiTargetContext, withContext } from '../core/aicontext';
  import { aiInputEnabled } from '../core/aiflavors';
  import { existingNotesPrompt, generateMidiSpecPack, parseKkMidi } from '../core/aimidi';
  import {
    generateMidiClip,
    loadSettings,
    providerLabel,
    providerReady,
    type AiSettings,
  } from '../core/aiprovider';
  import { parseSmf, writeSmf, type SmfFile } from '../core/smf';
  import { appState } from '../state';
  import { onSettingsChange } from '../core/settings';
  import { theme, cssHex, isLightTheme } from '../theme';

  // Theme-aware canvas colors (read at draw time — drawAll runs every frame).
  const gbg = () => cssHex(theme.graphBg);
  /** Grid lines / overlays: light foreground on dark themes, dark on light. */
  const fg = (a: number) => (isLightTheme() ? `rgba(40,40,52,${a})` : `rgba(255,255,255,${a})`);

  // PRD §8.3 reworked: full piano-roll editor for any { notes, length } clip.
  // Keys on the left, zoomable free-time note grid, per-note parameter lane,
  // cut/copy/paste/undo/redo, quantize/humanize/randomize, MIDI file I/O.
  // Edits commit straight through the host callbacks, so the engine stays
  // live. The host owns placement/size — this component fills its container.
  // Hosts: PianoRoll.svelte (pinned over a composer tile), the song playlist
  // clip editor (SONG_PLAN.md phase 4).

  const {
    title = 'Composer',
    /** Only the active (topmost) editor responds to global shortcuts. */
    active = true,
    /** Host CSS scale — client px → logical px for pan/scrollbar drags. */
    scale = 1,
    /** Pull the current clip from the host (open, undo/redo, external change). */
    getClip,
    /** Write the note list back (host suppresses its own change echo). */
    onNotesChange,
    /** Write the loop length back. */
    onLengthChange,
    onClose,
    /** Preview a pitch through the host's instrument; null = note off. */
    onPreview,
    /** Bottom-right grip drag — grip hidden when the host doesn't resize. */
    onResizeGrip = undefined,
    /** Beat to draw the playhead at, null = hidden. Read every frame. */
    playheadBeat,
    /** Module whose downstream instrument flavors the AI context (optional). */
    aiTargetModuleId = undefined,
  }: {
    title?: string;
    active?: boolean;
    scale?: number;
    getClip: () => ComposerClip;
    onNotesChange: (notes: ComposerNote[]) => void;
    onLengthChange: (len: number) => void;
    onClose: () => void;
    onPreview: (pitch: number | null) => void;
    onResizeGrip?: (e: PointerEvent) => void;
    playheadBeat: () => number | null;
    aiTargetModuleId?: string;
  } = $props();

  // View: zoom in px/beat and px/semitone, scroll in px.
  let zoomX = $state(56);
  let rowH = $state(13);
  let scrollX = $state(0);
  let scrollY = $state((127 - 72) * 13); // C5 near the top by default

  const KEYS_W = 56;
  const LANE_H = 84;
  const BLACK = new Set([1, 3, 6, 8, 10]);

  let notes: ComposerNote[] = [];
  let clipLength = $state(16);
  let selected = new Set<ComposerNote>();
  let lastNoteLen = 1;

  let snap = $state('1/16');
  const SNAP_BEATS: Record<string, number> = {
    off: 0, '1/1': 4, '1/2': 2, '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/32': 0.125,
    '1/8T': 1 / 3, '1/16T': 1 / 6,
  };

  let laneParam = $state<'vel' | 'pan' | 'release' | 'modX' | 'modY' | 'prob'>('vel');
  const LANE_LABELS = {
    vel: 'Velocity', pan: 'Pan', release: 'Release', modX: 'Mod X', modY: 'Mod Y', prob: 'Probability',
  } as const;

  let gridEl: HTMLCanvasElement | undefined = $state();
  let keysEl: HTMLCanvasElement | undefined = $state();
  let laneEl: HTMLCanvasElement | undefined = $state();

  // Quantize popup state.
  let quantOpen = $state(false);
  let quantGrid = $state('1/16');
  let quantStrength = $state(100);
  let quantStarts = $state(true);
  let quantLengths = $state(false);

  // MIDI import popup state.
  let importOpen = $state(false);
  let importFile: SmfFile | null = $state(null);
  let importTracks = $state<boolean[]>([]);
  let importChannels = $state<Record<number, boolean>>({});
  let importReplace = $state(true);
  let importSetLength = $state(true);

  let raf = 0;

  onMount(() => {
    refresh(true);
    // Backend is configured in Options → AI; pick changes up live.
    const offSettings = onSettingsChange(() => (aiSettings = loadSettings()));
    const tick = () => {
      drawAll();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      offSettings();
      cancelAnimationFrame(raf);
    };
  });

  /** Re-pull the clip from the host (open, undo/redo, external change). */
  export function refresh(clearSelection: boolean): void {
    const clip = getClip();
    notes = clip.notes;
    clipLength = clip.length;
    if (clearSelection) selected = new Set();
  }

  /** Write the local note list back to the host (engine updates live). */
  function commit() {
    onNotesChange(sortNotes(notes));
  }

  function commitLength(len: number) {
    clipLength = Math.min(COMPOSER_MAX_LENGTH, Math.max(1, Math.round(len * 4) / 4));
    appState.beginUndoable();
    onLengthChange(clipLength);
  }

  // -- coordinate helpers -----------------------------------------------------

  const beatToX = (b: number) => b * zoomX - scrollX;
  const xToBeat = (x: number) => (x + scrollX) / zoomX;
  const pitchToY = (p: number) => (127 - p) * rowH - scrollY;
  const yToPitch = (y: number) => 127 - Math.floor((y + scrollY) / rowH);

  function snapBeat(b: number): number {
    const g = SNAP_BEATS[snap];
    return g > 0 ? Math.round(b / g) * g : b;
  }

  function snapFloor(b: number): number {
    const g = SNAP_BEATS[snap];
    return g > 0 ? Math.floor(b / g) * g : b;
  }

  // Measured .body box (logical px, pre-transform) — keeps the canvas
  // attribute size equal to its CSS size so rendering stays crisp and
  // pointer mapping stays 1:1 at zoom 1.
  let bodyW = $state(600);
  let bodyH = $state(250);

  function gridSize(): { w: number; h: number } {
    return { w: Math.max(50, bodyW - KEYS_W - 2), h: Math.max(50, bodyH) };
  }

  function noteAt(x: number, y: number): ComposerNote | null {
    const beat = xToBeat(x);
    const pitch = yToPitch(y);
    // Topmost = last drawn; search backwards for natural stacking.
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (n.pitch === pitch && beat >= n.start && beat <= n.start + n.length) return n;
    }
    return null;
  }

  // -- drawing ------------------------------------------------------------------

  function drawAll() {
    drawKeys();
    drawGrid();
    drawLane();
  }

  function drawKeys() {
    if (!keysEl) return;
    const { h } = gridSize();
    const ctx = keysEl.getContext('2d')!;
    ctx.fillStyle = gbg();
    ctx.fillRect(0, 0, KEYS_W, h);
    const first = Math.max(0, yToPitch(h));
    const last = Math.min(127, yToPitch(0));
    for (let p = first; p <= last; p++) {
      const y = pitchToY(p);
      const black = BLACK.has(p % 12);
      ctx.fillStyle = black ? '#1a1a22' : '#e8e8ee';
      ctx.fillRect(0, y + 0.5, KEYS_W - 1, rowH - 1);
      if (p % 12 === 0) {
        ctx.fillStyle = black ? '#888' : '#444';
        ctx.font = '9px sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(`C${Math.floor(p / 12) - 1}`, KEYS_W - 22, y + rowH / 2 + 0.5);
      }
    }
    ctx.strokeStyle = '#2a2a33';
    ctx.strokeRect(0.5, 0.5, KEYS_W - 1, h - 1);
  }

  function drawGrid() {
    if (!gridEl) return;
    const { w, h } = gridSize();
    const ctx = gridEl.getContext('2d')!;
    ctx.fillStyle = gbg();
    ctx.fillRect(0, 0, w, h);

    // Row shading for black keys, octave separators.
    const first = Math.max(0, yToPitch(h));
    const last = Math.min(127, yToPitch(0));
    for (let p = first; p <= last; p++) {
      const y = pitchToY(p);
      if (BLACK.has(p % 12)) {
        ctx.fillStyle = fg(0.04);
        ctx.fillRect(0, y, w, rowH);
      }
      if (p % 12 === 11) {
        ctx.fillStyle = fg(0.12);
        ctx.fillRect(0, y - 0.5, w, 1);
      }
    }

    // Vertical lines: snap grid (faint), beats, bars (4 beats).
    const g = SNAP_BEATS[snap];
    const firstBeat = Math.max(0, Math.floor(xToBeat(0)));
    const lastBeat = Math.ceil(xToBeat(w));
    if (g > 0 && g * zoomX > 5) {
      ctx.fillStyle = fg(0.06);
      for (let b = Math.floor(firstBeat / g) * g; b <= lastBeat; b += g) {
        ctx.fillRect(beatToX(b), 0, 1, h);
      }
    }
    for (let b = firstBeat; b <= lastBeat; b++) {
      ctx.fillStyle = b % 4 === 0 ? fg(0.22) : fg(0.1);
      ctx.fillRect(beatToX(b), 0, 1, h);
    }

    // Beyond the loop end: dim the dead zone.
    const endX = beatToX(clipLength);
    if (endX < w) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(Math.max(0, endX), 0, w, h);
      ctx.fillStyle = 'rgba(255,177,61,0.7)';
      ctx.fillRect(endX, 0, 2, h);
    }

    // Notes.
    for (const n of notes) {
      const x = beatToX(n.start);
      const y = pitchToY(n.pitch);
      const nw = Math.max(3, n.length * zoomX - 1);
      if (x + nw < 0 || x > w || y + rowH < 0 || y > h) continue;
      const sel = selected.has(n);
      ctx.fillStyle = sel
        ? `rgba(255, 209, 102, ${0.55 + 0.45 * n.vel})`
        : `rgba(61, 217, 255, ${0.35 + 0.6 * n.vel})`;
      ctx.fillRect(x, y + 1, nw, rowH - 2);
      if (n.prob < 1) {
        // Probability notes render hollow-ish: punch out the middle.
        ctx.clearRect(x + 2, y + 3, Math.max(0, nw - 4) * (1 - n.prob), Math.max(0, rowH - 6));
      }
      ctx.strokeStyle = sel ? '#fff' : 'rgba(0,0,0,0.5)';
      ctx.strokeRect(x + 0.5, y + 1.5, nw - 1, rowH - 3);
    }

    // Marquee.
    if (marquee) {
      ctx.strokeStyle = fg(0.8);
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(
        Math.min(marquee.x0, marquee.x1) + 0.5,
        Math.min(marquee.y0, marquee.y1) + 0.5,
        Math.abs(marquee.x1 - marquee.x0),
        Math.abs(marquee.y1 - marquee.y0),
      );
      ctx.setLineDash([]);
    }

    // Playhead while the host says we're audible.
    const ph = playheadBeat();
    if (ph !== null) {
      const px = beatToX(ph);
      if (px >= 0 && px <= w) {
        ctx.fillStyle = fg(0.85);
        ctx.fillRect(px, 0, 1.5, h);
      }
    }
  }

  function drawLane() {
    if (!laneEl) return;
    const { w } = gridSize();
    const ctx = laneEl.getContext('2d')!;
    ctx.fillStyle = gbg();
    ctx.fillRect(0, 0, w, LANE_H);
    const bipolar = laneParam === 'pan';
    const zeroY = bipolar ? LANE_H / 2 : LANE_H - 2;
    ctx.fillStyle = fg(0.18);
    ctx.fillRect(0, zeroY, w, 1);
    for (const n of notes) {
      const x = beatToX(n.start);
      if (x < -4 || x > w) continue;
      const v = n[laneParam];
      const sel = selected.has(n);
      ctx.fillStyle = sel ? 'rgba(255, 209, 102, 0.9)' : 'rgba(61, 217, 255, 0.7)';
      const bw = Math.max(3, Math.min(8, n.length * zoomX - 1));
      if (bipolar) {
        const vh = (v / 2) * (LANE_H - 8);
        ctx.fillRect(x, vh >= 0 ? zeroY - vh : zeroY, bw, Math.max(1.5, Math.abs(vh)));
      } else {
        const vh = Math.max(1.5, v * (LANE_H - 8));
        ctx.fillRect(x, zeroY - vh, bw, vh);
      }
    }
  }

  // -- grid interactions ----------------------------------------------------

  type DragMode =
    | { kind: 'move'; startBeat: number; startPitch: number; orig: Map<ComposerNote, { start: number; pitch: number }> }
    | { kind: 'resize'; orig: Map<ComposerNote, number> ; anchorBeat: number }
    | { kind: 'marquee' }
    | { kind: 'pan'; startX: number; startY: number; sx: number; sy: number }
    | null;
  let drag: DragMode = null;
  let marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;

  /** Client → canvas-logical px (the panel may be CSS-scaled by the host). */
  function gridPos(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = gridEl!.getBoundingClientRect();
    const k = r.width > 0 ? gridEl!.width / r.width : 1;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  }

  function onGridDown(e: PointerEvent) {
    gridEl!.setPointerCapture(e.pointerId);
    const { x, y } = gridPos(e);

    if (e.button === 1) {
      // Middle mouse: pan the view.
      e.preventDefault();
      drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, sx: scrollX, sy: scrollY };
      return;
    }
    if (e.button === 2) {
      // Right click: delete the note under the cursor.
      const n = noteAt(x, y);
      if (n) {
        appState.beginUndoable();
        notes = notes.filter((m) => m !== n);
        selected.delete(n);
        commit();
      }
      return;
    }
    if (e.button !== 0) return;

    if (e.ctrlKey || e.metaKey) {
      marquee = { x0: x, y0: y, x1: x, y1: y };
      drag = { kind: 'marquee' };
      return;
    }

    const hit = noteAt(x, y);
    if (hit) {
      const nearRight = x > beatToX(hit.start + hit.length) - 6;
      if (e.shiftKey) {
        if (selected.has(hit)) selected.delete(hit);
        else selected.add(hit);
        return;
      }
      if (!selected.has(hit)) selected = new Set([hit]);
      appState.beginUndoable();
      if (nearRight) {
        const orig = new Map<ComposerNote, number>();
        for (const n of selected) orig.set(n, n.length);
        drag = { kind: 'resize', orig, anchorBeat: xToBeat(x) };
      } else {
        const orig = new Map<ComposerNote, { start: number; pitch: number }>();
        for (const n of selected) orig.set(n, { start: n.start, pitch: n.pitch });
        drag = { kind: 'move', startBeat: xToBeat(x), startPitch: yToPitch(y), orig };
      }
      return;
    }

    // Empty space: draw a new note (snap honored; snap off = free time).
    const start = Math.max(0, snapFloor(xToBeat(x)));
    const pitch = Math.min(127, Math.max(0, yToPitch(y)));
    const note = defaultNote(start, pitch, lastNoteLen);
    appState.beginUndoable();
    notes = [...notes, note];
    selected = new Set([note]);
    commit();
    const orig = new Map<ComposerNote, { start: number; pitch: number }>();
    orig.set(note, { start: note.start, pitch: note.pitch });
    drag = { kind: 'move', startBeat: xToBeat(x), startPitch: pitch, orig };
  }

  function onGridMove(e: PointerEvent) {
    if (!drag) return;
    const { x, y } = gridPos(e);

    if (drag.kind === 'pan') {
      scrollX = Math.max(0, drag.sx - (e.clientX - drag.startX) / scale);
      scrollY = clampScrollY(drag.sy - (e.clientY - drag.startY) / scale);
      return;
    }
    if (drag.kind === 'marquee') {
      marquee!.x1 = x;
      marquee!.y1 = y;
      const b0 = xToBeat(Math.min(marquee!.x0, marquee!.x1));
      const b1 = xToBeat(Math.max(marquee!.x0, marquee!.x1));
      const p0 = yToPitch(Math.max(marquee!.y0, marquee!.y1));
      const p1 = yToPitch(Math.min(marquee!.y0, marquee!.y1));
      selected = new Set(
        notes.filter((n) => n.start + n.length > b0 && n.start < b1 && n.pitch >= p0 && n.pitch <= p1),
      );
      return;
    }
    if (drag.kind === 'move') {
      const rawDb = xToBeat(x) - drag.startBeat;
      const dp = yToPitch(y) - drag.startPitch;
      for (const [n, o] of drag.orig) {
        const moved = o.start + rawDb;
        n.start = Math.max(0, SNAP_BEATS[snap] > 0 ? snapBeat(moved) : moved);
        n.pitch = Math.min(127, Math.max(0, o.pitch + dp));
      }
      commit();
      return;
    }
    if (drag.kind === 'resize') {
      const db = xToBeat(x) - drag.anchorBeat;
      for (const [n, len] of drag.orig) {
        const raw = len + db;
        const snapped = SNAP_BEATS[snap] > 0 ? Math.max(SNAP_BEATS[snap], snapBeat(raw)) : raw;
        n.length = Math.max(COMPOSER_MIN_NOTE_LEN, snapped);
      }
      commit();
    }
  }

  function onGridUp() {
    if (drag?.kind === 'move' || drag?.kind === 'resize') {
      const one = [...selected][0];
      if (drag.kind === 'resize' && one) lastNoteLen = one.length;
      commit();
    }
    marquee = null;
    drag = null;
  }

  function clampScrollY(v: number): number {
    const { h } = gridSize();
    return Math.min(Math.max(0, 128 * rowH - h), Math.max(0, v));
  }

  /** Horizontal scroll range: the clip's full width minus the visible grid. */
  function clampScrollX(v: number): number {
    const { w } = gridSize();
    return Math.min(Math.max(0, clipLength * zoomX - w), Math.max(0, v));
  }

  function onGridWheel(e: WheelEvent) {
    e.preventDefault();
    const { x, y } = gridPos(e);
    if (e.ctrlKey || e.metaKey) {
      // Ctrl + wheel: zoom the X axis around the cursor.
      const beat = xToBeat(x);
      zoomX = Math.min(480, Math.max(8, zoomX * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      scrollX = clampScrollX(beat * zoomX - x);
    } else if (e.altKey) {
      const pitchAnchor = (y + scrollY) / rowH;
      rowH = Math.min(28, Math.max(6, rowH * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      scrollY = clampScrollY(pitchAnchor * rowH - y);
    } else if (e.shiftKey) {
      // Shift + wheel: force horizontal (mouse-wheel users).
      scrollX = clampScrollX(scrollX + (e.deltaY + e.deltaX));
    } else {
      // Trackpad two-finger gestures arrive as deltaX/deltaY — scroll both axes.
      scrollY = clampScrollY(scrollY + e.deltaY);
      if (e.deltaX) scrollX = clampScrollX(scrollX + e.deltaX);
    }
  }

  // -- scrollbars + corner resize grip ---------------------------------------

  /** Thumb geometry for an overlay scrollbar (all logical, pre-scale px). */
  function barGeom(content: number, view: number, scroll: number) {
    const track = Math.max(0, view);
    if (content <= view + 0.5) return { show: false, size: track, pos: 0, track };
    const size = Math.max(24, (view / content) * track);
    const range = content - view;
    const pos = range > 0 ? (scroll / range) * (track - size) : 0;
    return { show: true, size, pos, track };
  }

  const vBar = $derived(barGeom(128 * rowH, Math.max(50, bodyH), scrollY));
  const hBar = $derived(barGeom(clipLength * zoomX, Math.max(50, bodyW - KEYS_W - 2), scrollX));

  /** Drag a scrollbar thumb; maps track px (descaled) back to scroll px. */
  function dragBar(e: PointerEvent, axis: 'x' | 'y') {
    e.preventDefault();
    e.stopPropagation();
    const startClient = axis === 'x' ? e.clientX : e.clientY;
    const startScroll = axis === 'x' ? scrollX : scrollY;
    const bar = axis === 'x' ? hBar : vBar;
    const content = axis === 'x' ? clipLength * zoomX : 128 * rowH;
    const view = bar.track;
    const range = content - view;
    const travel = bar.track - bar.size;
    const onMove = (ev: PointerEvent) => {
      const d = ((axis === 'x' ? ev.clientX : ev.clientY) - startClient) / scale;
      const next = travel > 0 ? startScroll + (d / travel) * range : startScroll;
      if (axis === 'x') scrollX = clampScrollX(next);
      else scrollY = clampScrollY(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // -- keys column: click to preview ----------------------------------------

  let previewPitch = -1;

  function onKeysDown(e: PointerEvent) {
    keysEl!.setPointerCapture(e.pointerId);
    const r = keysEl!.getBoundingClientRect();
    const k = r.height > 0 ? keysEl!.height / r.height : 1;
    previewPitch = Math.min(127, Math.max(0, yToPitch((e.clientY - r.top) * k)));
    onPreview(previewPitch);
  }

  function onKeysUp() {
    if (previewPitch >= 0) onPreview(null);
    previewPitch = -1;
  }

  // -- lane interactions -------------------------------------------------------

  let laneDragging = false;

  function onLaneDown(e: PointerEvent) {
    laneEl!.setPointerCapture(e.pointerId);
    appState.beginUndoable();
    laneDragging = true;
    onLaneMove(e);
  }

  function onLaneMove(e: PointerEvent) {
    if (!laneDragging) return;
    const r = laneEl!.getBoundingClientRect();
    const k = r.width > 0 ? laneEl!.width / r.width : 1;
    const x = (e.clientX - r.left) * k;
    const y = Math.min(LANE_H, Math.max(0, (e.clientY - r.top) * k));
    const bipolar = laneParam === 'pan';
    const v = bipolar
      ? Math.min(1, Math.max(-1, ((LANE_H / 2 - y) / (LANE_H / 2 - 4))))
      : Math.min(1, Math.max(0, (LANE_H - 2 - y) / (LANE_H - 8)));
    const beat = xToBeat(x);
    // Paint the nearest note column under the cursor (selected ones only,
    // when a selection exists).
    const pool = selected.size ? [...selected] : notes;
    let best: ComposerNote | null = null;
    for (const n of pool) {
      if (beat >= n.start - 0.1 && beat <= n.start + Math.max(n.length, 0.2)) {
        if (!best || Math.abs(n.start - beat) < Math.abs(best.start - beat)) best = n;
      }
    }
    if (best) {
      best[laneParam] = laneParam === 'pan' ? v : Math.max(0, v);
      commit();
    }
  }

  function onLaneUp() {
    laneDragging = false;
  }

  // -- edit ops ---------------------------------------------------------------

  function pool(): ComposerNote[] {
    return selected.size ? [...selected] : notes;
  }

  function doCopy() {
    clipboard = pool().map((n) => ({ ...n }));
  }

  function doCut() {
    doCopy();
    const cut = new Set(pool());
    appState.beginUndoable();
    notes = notes.filter((n) => !cut.has(n));
    selected = new Set();
    commit();
  }

  function doPaste() {
    if (!clipboard.length) return;
    appState.beginUndoable();
    const pasted = clipboard.map((n) => ({ ...n }));
    notes = [...notes, ...pasted];
    selected = new Set(pasted);
    commit();
  }

  function doDelete() {
    if (!selected.size) return;
    appState.beginUndoable();
    notes = notes.filter((n) => !selected.has(n));
    selected = new Set();
    commit();
  }

  /** Replace the edited pool with transformed copies. */
  function applyTool(fn: (input: ComposerNote[]) => ComposerNote[]) {
    const input = pool();
    const inputSet = new Set(input);
    appState.beginUndoable();
    const out = fn(input);
    notes = [...notes.filter((n) => !inputSet.has(n)), ...out];
    selected = selected.size ? new Set(out) : new Set();
    commit();
  }

  function doQuantize() {
    applyTool((input) =>
      quantizeNotes(input, {
        grid: SNAP_BEATS[quantGrid] || 0.25,
        strength: quantStrength / 100,
        starts: quantStarts,
        lengths: quantLengths,
      }),
    );
    quantOpen = false;
  }

  function doHumanize() {
    applyTool((input) => humanizeNotes(input));
  }

  function doRandomize() {
    applyTool((input) => randomizeNotes(input));
  }

  function selectAll() {
    selected = new Set(notes);
  }

  // -- MIDI file I/O ------------------------------------------------------------

  function saveMidi() {
    const bytes = writeSmf(notes, clipLength, appState.transport.tempo);
    const blob = new Blob([bytes as BlobPart], { type: 'audio/midi' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${title.replace(/[^\w-]+/g, '_').toLowerCase() || 'composer'}.mid`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function pickMidi(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      importFile = parseSmf(await file.arrayBuffer());
    } catch (err) {
      alert(`Could not read MIDI file: ${err instanceof Error ? err.message : err}`);
      return;
    }
    importTracks = importFile.tracks.map((t) => t.noteCount > 0);
    const channels: Record<number, boolean> = {};
    for (const t of importFile.tracks) for (const ch of t.channels) channels[ch] = true;
    importChannels = channels;
    importReplace = true;
    importSetLength = true;
    importOpen = true;
  }

  function doImport() {
    if (!importFile) return;
    // Drop notes past the longest possible loop — they could never play and
    // would otherwise sit inert (or worse, confuse edits) past the dead zone.
    const picked = importFile.notes.filter(
      (n) => importTracks[n.track] && importChannels[n.channel] && n.start < COMPOSER_MAX_LENGTH,
    );
    appState.beginUndoable();
    const incoming = picked.map((n) => ({ ...n }) as ComposerNote);
    notes = importReplace ? incoming : [...notes, ...incoming];
    if (importSetLength && importFile.lengthBeats > 0) {
      clipLength = Math.min(
        COMPOSER_MAX_LENGTH,
        Math.max(4, Math.ceil(importFile.lengthBeats / 4) * 4),
      );
      onLengthChange(clipLength);
    }
    selected = new Set();
    commit();
    importOpen = false;
    importFile = null;
  }

  // -- AI MIDI generation (mirrors the AI Patch dialog; shares its backend) ----

  let aiOpen = $state(false);
  let aiText = $state('');
  let aiPrompt = $state('');
  let aiErrors = $state<string[]>([]);
  let aiWarnings = $state<string[]>([]);
  let aiSettings = $state<AiSettings>(loadSettings());
  let aiGenerating = $state(false);
  let aiGenStatus = $state('');
  let aiCopied = $state(false);
  let aiReplace = $state(true);
  let aiIncludeNotes = $state(false);
  let aiSuccess = $state('');

  /** User prompt, optionally carrying the current clip's notes for variation. */
  function aiUserPrompt(): string {
    const base = aiPrompt.trim();
    if (!aiIncludeNotes || notes.length === 0) return base;
    const ex = existingNotesPrompt({ notes, length: clipLength });
    return base ? `${base}\n\n${ex}` : ex;
  }

  /** Optional MIDI context (transport + downstream target), gated by AI-input prefs. */
  function aiMidiContext(): string {
    const parts: string[] = [];
    if (aiInputEnabled('midi', 'canvas')) parts.push(buildAiContext(appState.graph));
    if (aiInputEnabled('midi', 'transport')) {
      parts.push(
        `Transport: ${appState.transport.tempo} BPM, ` +
          `${appState.transport.timeSignature.num}/${appState.transport.timeSignature.denom}; ` +
          `this clip is ${clipLength} beats long.`,
      );
    }
    if (aiTargetModuleId && aiInputEnabled('midi', 'targetInstrument')) {
      const t = buildMidiTargetContext(appState.graph, aiTargetModuleId);
      if (t) parts.push(t);
    }
    return parts.join('\n');
  }

  export function openAi(): void {
    aiSettings = loadSettings(); // pick up changes made in the AI Patch dialog
    aiIncludeNotes = aiInputEnabled('midi', 'existingNotes') && notes.length > 0;
    aiErrors = [];
    aiWarnings = [];
    aiSuccess = '';
    aiOpen = true;
  }

  async function aiCopySpec() {
    await navigator.clipboard.writeText(
      generateMidiSpecPack(withContext(aiMidiContext(), aiUserPrompt())),
    );
    aiCopied = true;
    setTimeout(() => (aiCopied = false), 2000);
  }

  /** Validated clip → host data (one undo step), then close. */
  function aiApply(clip: ComposerClip, name?: string) {
    appState.beginUndoable();
    const incoming = clip.notes.map((n) => ({ ...n }));
    if (aiReplace) {
      notes = incoming;
      clipLength = clip.length;
    } else {
      notes = [...notes, ...incoming];
      clipLength = Math.max(clipLength, clip.length);
    }
    onLengthChange(clipLength);
    selected = new Set();
    commit();
    aiSuccess = `✓ Imported ${incoming.length} notes${name ? ` — “${name}”` : ''}.`;
    aiText = '';
    setTimeout(() => {
      aiOpen = false;
      aiSuccess = '';
    }, 900);
  }

  function aiImport() {
    const result = parseKkMidi(aiText);
    aiErrors = result.errors;
    aiWarnings = result.warnings;
    if (result.ok && result.clip) aiApply(result.clip, result.name);
  }

  async function aiGenerate() {
    const prompt = aiPrompt.trim();
    if (!prompt || aiGenerating) return;
    aiGenerating = true;
    aiGenStatus = '';
    aiErrors = [];
    aiWarnings = [];
    aiSuccess = '';
    try {
      const result = await generateMidiClip(withContext(aiMidiContext(), aiUserPrompt()), aiSettings, 3, (s) => (aiGenStatus = s));
      aiText = result.text;
      const parsed = parseKkMidi(result.text);
      aiErrors = parsed.errors;
      aiWarnings = parsed.warnings;
      if (parsed.ok && parsed.clip) aiApply(parsed.clip, parsed.name);
    } catch (e) {
      aiErrors = [(e as Error).message];
    } finally {
      aiGenerating = false;
      aiGenStatus = '';
    }
  }

  // -- keyboard shortcuts -----------------------------------------------------

  function onKeyDown(e: KeyboardEvent) {
    // Only the active (topmost) editor responds to global shortcuts.
    if (!active) return;
    const tag = (document.activeElement?.tagName ?? '').toLowerCase();
    if (tag === 'input' || tag === 'select') return;
    if (quantOpen || importOpen || aiOpen) {
      if (e.key === 'Escape') {
        quantOpen = false;
        importOpen = false;
        aiOpen = false;
      }
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') onClose();
    else if (e.key === 'Delete' || e.key === 'Backspace') doDelete();
    else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectAll();
    } else if (mod && e.key.toLowerCase() === 'c') doCopy();
    else if (mod && e.key.toLowerCase() === 'x') doCut();
    else if (mod && e.key.toLowerCase() === 'v') doPaste();
    else if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      appState.undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      appState.redo();
    }
  }

</script>

<svelte:window onkeydown={onKeyDown} />

<div class="roll-core">
      <div class="toolbar-row">
        <label title="Loop length in beats (4 per bar)">
          Length
          <input
            type="number"
            min="1"
            max={COMPOSER_MAX_LENGTH}
            step="1"
            value={clipLength}
            onchange={(e) => commitLength(Number((e.target as HTMLInputElement).value))}
          />
        </label>
        <label title="Drawing/moving snap; Off = free (unquantized) notes">
          Snap
          <select bind:value={snap}>
            {#each Object.keys(SNAP_BEATS) as s (s)}<option value={s}>{s}</option>{/each}
          </select>
        </label>
        <span class="divider"></span>
        <button class="ai-btn" onclick={openAi} title="Generate a clip with AI (prompt → MIDI JSON), or paste MIDI JSON from any chatbot">✨ AI MIDI</button>
        <label class="file-btn" title="Load notes from a .mid file (channel options follow)">
          Load MIDI
          <input type="file" accept=".mid,.midi,audio/midi" onchange={pickMidi} />
        </label>
        <button onclick={saveMidi} title="Download the clip as a standard MIDI file">Save MIDI</button>
        <span class="spacer"></span>
        <span class="count">{notes.length} notes{selected.size ? ` · ${selected.size} selected` : ''}</span>
        <button onclick={onClose} title="Close the editor (Esc)">⤡</button>
      </div>

      <div class="toolbar-row">
        <button onclick={doCut} disabled={!selected.size} title="Cut selection (Ctrl+X)">Cut</button>
        <button onclick={doCopy} disabled={!selected.size} title="Copy selection (Ctrl+C)">Copy</button>
        <button onclick={doPaste} disabled={!clipboard.length} title="Paste in place (Ctrl+V)">Paste</button>
        <span class="divider"></span>
        <button onclick={() => appState.undo()} title="Undo (Ctrl+Z)">↶</button>
        <button onclick={() => appState.redo()} title="Redo (Ctrl+Y)">↷</button>
        <span class="divider"></span>
        <button onclick={() => (quantOpen = true)} title="Snap notes to a grid (with options)">Quantize…</button>
        <button onclick={doHumanize} title="Small random timing/velocity drift — applies to selection or all">Humanize</button>
        <button onclick={doRandomize} title="Scramble pitches and velocities — selection or all">Randomize</button>
      </div>

      <div class="body" bind:clientWidth={bodyW} bind:clientHeight={bodyH}>
        <canvas
          bind:this={keysEl}
          width={KEYS_W}
          height={gridSize().h}
          onpointerdown={onKeysDown}
          onpointerup={onKeysUp}
          onpointercancel={onKeysUp}
          title="Click a key to preview the pitch through the wired synth"
        ></canvas>
        <canvas
          bind:this={gridEl}
          class="grid"
          width={gridSize().w}
          height={gridSize().h}
          onpointerdown={onGridDown}
          onpointermove={onGridMove}
          onpointerup={onGridUp}
          onpointercancel={onGridUp}
          onwheel={onGridWheel}
          oncontextmenu={(e) => e.preventDefault()}
          title="draw: click · delete: right-click · select: ctrl-drag / shift-click · pan: middle-drag · zoom: ctrl-wheel (alt = rows)"
        ></canvas>
        {#if vBar.show}
          <div class="scrollbar v" title="Scroll pitches">
            <div
              class="thumb"
              style="top:{vBar.pos}px;height:{vBar.size}px"
              onpointerdown={(e) => dragBar(e, 'y')}
            ></div>
          </div>
        {/if}
        {#if hBar.show}
          <div class="scrollbar h" style="left:{KEYS_W + 2}px" title="Scroll time">
            <div
              class="thumb"
              style="left:{hBar.pos}px;width:{hBar.size}px"
              onpointerdown={(e) => dragBar(e, 'x')}
            ></div>
          </div>
        {/if}
      </div>

      <div class="lane-row">
        <select bind:value={laneParam} title="Per-note parameter shown in the lane below">
          {#each Object.entries(LANE_LABELS) as [id, label] (id)}<option value={id}>{label}</option>{/each}
        </select>
        <canvas
          bind:this={laneEl}
          width={gridSize().w}
          height={LANE_H}
          onpointerdown={onLaneDown}
          onpointermove={onLaneMove}
          onpointerup={onLaneUp}
          onpointercancel={onLaneUp}
          title="Drag to paint the selected per-note parameter"
        ></canvas>
      </div>

      {#if onResizeGrip}
        <div
          class="resize-grip"
          title="Drag to resize the editor"
          onpointerdown={onResizeGrip}
        ></div>
      {/if}
    </div>

    {#if quantOpen}
      <div class="popup-backdrop">
        <div class="popup">
          <div class="popup-title">Quantize {selected.size ? `${selected.size} selected notes` : 'all notes'}</div>
          <label>
            Grid
            <select bind:value={quantGrid}>
              {#each Object.keys(SNAP_BEATS).filter((s) => s !== 'off') as s (s)}<option value={s}>{s}</option>{/each}
            </select>
          </label>
          <label>
            Strength
            <input type="range" min="10" max="100" step="5" bind:value={quantStrength} />
            {quantStrength}%
          </label>
          <label><input type="checkbox" bind:checked={quantStarts} /> Note starts</label>
          <label><input type="checkbox" bind:checked={quantLengths} /> Note lengths</label>
          <div class="popup-actions">
            <button class="primary" onclick={doQuantize}>Apply</button>
            <button onclick={() => (quantOpen = false)}>Cancel</button>
          </div>
        </div>
      </div>
    {/if}

    {#if aiOpen}
      <div class="popup-backdrop">
        <div class="popup ai-midi" role="dialog" aria-label="AI MIDI">
          <div class="popup-title ai-title-row">
            <span>AI MIDI — {title}</span>
            <span class="provider-tag" title="Active AI backend (configure with Setup)">{providerLabel(aiSettings)}</span>
            <span class="ai-spacer"></span>
            <button
              onclick={() => window.dispatchEvent(new CustomEvent('kk-options', { detail: { tab: 'ai' } }))}
              title="Configure an AI backend in Options"
            >⚙ Setup</button>
            <button onclick={() => (aiOpen = false)} title="Close (Esc)">✕</button>
          </div>

          <p class="ai-help">
            {#if providerReady(aiSettings)}
              Describe the riff/beat you want and click <strong>Generate</strong> — it's validated and lands in this clip.
            {:else}
              1. Describe the clip, copy, and paste it into any chatbot.<br />
              2. Paste the JSON it answers with below and hit Import.
            {/if}
          </p>

          <div class="ai-prompt-row">
            <input
              type="text"
              bind:value={aiPrompt}
              placeholder="e.g. a moody 8-bar minor-key arpeggio with ghost notes"
              spellcheck="false"
              onkeydown={(e) => { if (e.key === 'Enter' && providerReady(aiSettings)) aiGenerate(); }}
            />
            {#if providerReady(aiSettings)}
              <button class="primary" onclick={aiGenerate} disabled={aiGenerating || aiPrompt.trim().length === 0}>
                {aiGenerating ? '… ' + aiGenStatus : '✨ Generate'}
              </button>
            {:else}
              <button onclick={aiCopySpec} title="Copies the MIDI spec followed by USER PROMPT: your text">
                {aiCopied ? '✓ Copied!' : '📋 Copy Spec + Prompt'}
              </button>
            {/if}
          </div>

          <textarea
            bind:value={aiText}
            placeholder={'{ "kind": "kkmidi", "length": 16, "notes": [...] }  — markdown reply with a ```json block works too'}
            spellcheck="false"
          ></textarea>

          {#if aiErrors.length > 0}
            <div class="ai-messages ai-errors">
              {#each aiErrors as e (e)}<div>✗ {e}</div>{/each}
            </div>
          {/if}
          {#if aiWarnings.length > 0}
            <div class="ai-messages ai-warnings">
              {#each aiWarnings as w (w)}<div>⚠ {w}</div>{/each}
            </div>
          {/if}
          {#if aiSuccess}
            <div class="ai-messages ai-success">{aiSuccess}</div>
          {/if}

          <label title={notes.length === 0 ? 'Clip is empty — nothing to variate on' : 'Sends the current notes to the AI and asks it to variate on them'}>
            <input type="checkbox" bind:checked={aiIncludeNotes} disabled={notes.length === 0} /> Include existing notes as input (variate on them)
          </label>
          <label><input type="checkbox" bind:checked={aiReplace} /> Replace existing notes (off = merge)</label>
          <div class="popup-actions">
            <button class="primary" onclick={aiImport} disabled={aiText.trim().length === 0}>Import</button>
            <button onclick={() => (aiOpen = false)}>Cancel</button>
          </div>
        </div>
      </div>
    {/if}

    {#if importOpen && importFile}
      <div class="popup-backdrop">
        <div class="popup wide">
          <div class="popup-title">Import MIDI — {importFile.tracks.length} tracks{importFile.tempo ? ` · ${importFile.tempo} BPM` : ''}</div>
          <table>
            <thead><tr><th></th><th>Track</th><th>Channels</th><th>Notes</th></tr></thead>
            <tbody>
              {#each importFile.tracks as t, i (t.index)}
                <tr class:dim={t.noteCount === 0}>
                  <td><input type="checkbox" bind:checked={importTracks[i]} disabled={t.noteCount === 0} /></td>
                  <td>{t.name ?? `Track ${i + 1}`}</td>
                  <td>{t.channels.length ? t.channels.map((c) => c + 1).join(', ') : '—'}</td>
                  <td>{t.noteCount}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          <div class="channels">
            Channels:
            {#each Object.keys(importChannels).map(Number).sort((a, b) => a - b) as ch (ch)}
              <label><input type="checkbox" bind:checked={importChannels[ch]} /> {ch + 1}</label>
            {/each}
          </div>
          <label><input type="checkbox" bind:checked={importReplace} /> Replace existing notes (off = merge)</label>
          <label><input type="checkbox" bind:checked={importSetLength} /> Set loop length from file ({Math.min(COMPOSER_MAX_LENGTH, Math.ceil(importFile.lengthBeats))} beats{importFile.lengthBeats > COMPOSER_MAX_LENGTH ? ` — file is ${Math.ceil(importFile.lengthBeats)}, notes past the max are dropped` : ''})</label>
          <div class="popup-actions">
            <button class="primary" onclick={doImport}>Import</button>
            <button onclick={() => { importOpen = false; importFile = null; }}>Cancel</button>
          </div>
        </div>
      </div>
    {/if}

<style>
  .roll-core {
    width: 100%;
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    box-sizing: border-box;
    overflow: hidden;
  }
  .toolbar-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: nowrap;
    flex: none;
    height: 24px;
    min-width: 0;
    overflow: hidden;
  }
  /* Match the menu UI: compact 12px controls (global button defaults to 14px). */
  .toolbar-row button,
  .toolbar-row .file-btn,
  .toolbar-row select,
  .toolbar-row input {
    font-size: 12px;
    padding: 2px 8px;
  }
  .count {
    font-size: 11px;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .spacer {
    flex: 1;
  }
  label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--text-dim);
    white-space: nowrap;
  }
  input[type='number'] {
    width: 52px;
  }
  .divider {
    width: 1px;
    height: 18px;
    background: var(--panel-border);
    margin: 0 4px;
  }
  .body {
    display: flex;
    flex: 1;
    min-height: 0;
    gap: 2px;
    overflow: hidden;
    position: relative;
  }
  .scrollbar {
    position: absolute;
    background: rgba(127, 127, 127, 0.12);
    border-radius: 5px;
    z-index: 2;
  }
  .scrollbar.v {
    top: 0;
    bottom: 0;
    right: 0;
    width: 9px;
  }
  .scrollbar.h {
    right: 0;
    bottom: 0;
    height: 9px;
  }
  .scrollbar .thumb {
    position: absolute;
    background: var(--text-dim, #888);
    opacity: 0.55;
    border-radius: 5px;
    cursor: grab;
  }
  .scrollbar.v .thumb {
    left: 1px;
    right: 1px;
  }
  .scrollbar.h .thumb {
    top: 1px;
    bottom: 1px;
  }
  .scrollbar .thumb:hover {
    opacity: 0.85;
  }
  .resize-grip {
    position: absolute;
    right: 1px;
    bottom: 1px;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    z-index: 3;
    background:
      linear-gradient(135deg, transparent 0 50%, var(--text-dim, #888) 50% 60%, transparent 60% 70%, var(--text-dim, #888) 70% 80%, transparent 80%);
    opacity: 0.6;
  }
  .resize-grip:hover {
    opacity: 1;
  }
  canvas {
    border-radius: 4px;
    touch-action: none;
    display: block;
    flex: none;
  }
  canvas.grid {
    cursor: crosshair;
  }
  .lane-row {
    display: flex;
    gap: 2px;
    align-items: stretch;
  }
  .lane-row select {
    width: 56px;
    font-size: 10px;
  }
  .file-btn {
    position: relative;
    overflow: hidden;
    background: var(--button, #2a2a33);
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    padding: 4px 10px;
    cursor: pointer;
    color: var(--text);
  }
  .file-btn input[type='file'] {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
  .popup-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 70;
  }
  .popup {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    padding: 14px;
    min-width: 260px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .popup.wide {
    min-width: 380px;
  }
  .popup-title {
    font-weight: 700;
    color: var(--text);
    font-size: 13px;
  }
  .popup table {
    font-size: 12px;
    color: var(--text);
    border-collapse: collapse;
  }
  .popup th,
  .popup td {
    text-align: left;
    padding: 2px 8px 2px 0;
  }
  .popup tr.dim {
    opacity: 0.45;
  }
  .channels {
    display: flex;
    gap: 8px;
    font-size: 12px;
    color: var(--text-dim);
    flex-wrap: wrap;
  }
  .popup-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .popup.ai-midi {
    width: 540px;
    max-width: 92vw;
  }
  .ai-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .provider-tag {
    font-size: 11px;
    font-weight: 400;
    color: var(--text-dim);
    border: 1px solid var(--panel-border);
    border-radius: 5px;
    padding: 1px 6px;
  }
  .ai-spacer {
    flex: 1;
  }
  .ai-help {
    font-size: 12px;
    color: var(--text-dim);
    margin: 0;
    line-height: 1.7;
  }
  .ai-prompt-row {
    display: flex;
    gap: 8px;
  }
  .ai-prompt-row input {
    flex: 1;
    font-size: 12px;
  }
  .popup.ai-midi textarea {
    min-height: 140px;
    resize: vertical;
    font-family: ui-monospace, monospace;
    font-size: 11px;
  }
  .ai-messages {
    font-size: 12px;
    border-radius: 6px;
    padding: 8px 10px;
    max-height: 110px;
    overflow-y: auto;
  }
  .ai-errors {
    background: rgba(255, 80, 80, 0.12);
    color: #ff8080;
  }
  .ai-warnings {
    background: rgba(255, 177, 61, 0.1);
    color: var(--accent);
  }
  .ai-success {
    background: rgba(82, 224, 122, 0.12);
    color: #52e07a;
  }
  button.primary {
    background: var(--accent);
    color: #1a1a20;
    font-weight: 600;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
