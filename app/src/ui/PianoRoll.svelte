<script lang="ts">
  import { onMount } from 'svelte';
  import {
    clipFromData,
    defaultNote,
    humanizeNotes,
    quantizeNotes,
    randomizeNotes,
    sortNotes,
    COMPOSER_MAX_LENGTH,
    COMPOSER_MIN_NOTE_LEN,
    type ComposerNote,
  } from '../core/composer';
  import { parseSmf, writeSmf, type SmfFile } from '../core/smf';
  import { appState } from '../state';

  // PRD §8.3 reworked: full piano-roll editor for the Composer module.
  // Keys on the left, zoomable free-time note grid, per-note parameter lane,
  // cut/copy/paste/undo/redo, quantize/humanize/randomize, MIDI file I/O.
  // Edits commit straight to the module's data, so the engine stays live.

  let open = $state(false);
  let moduleId: string | null = null;
  let title = $state('Composer');

  // Resizable panel (drag the corner handle).
  let panelW = $state(Math.min(window.innerWidth - 60, 1000));
  let panelH = $state(Math.min(window.innerHeight - 80, 620));

  // View: zoom in px/beat and px/semitone, scroll in px.
  let zoomX = $state(56);
  let rowH = $state(13);
  let scrollX = $state(0);
  let scrollY = $state((127 - 72) * 13); // C5 near the top by default

  const KEYS_W = 56;
  const LANE_H = 84;
  const BLACK = new Set([1, 3, 6, 8, 10]);
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  let notes: ComposerNote[] = [];
  let clipLength = $state(16);
  let selected = new Set<ComposerNote>();
  let clipboard: ComposerNote[] = [];
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

  let suppressSync = false;
  let raf = 0;

  onMount(() => {
    const offOpen = appState.on('composerChanged', syncOpen);
    const offGraph = appState.on('graphChanged', () => {
      if (open && !suppressSync) syncNotes(true);
    });
    return () => {
      offOpen();
      offGraph();
      cancelAnimationFrame(raf);
    };
  });

  function syncOpen() {
    moduleId = appState.composerOpen;
    if (!moduleId) {
      open = false;
      cancelAnimationFrame(raf);
      return;
    }
    const mod = appState.graph.modules.get(moduleId);
    title = mod?.label ?? 'Composer';
    syncNotes(true);
    open = true;
    const tick = () => {
      drawAll();
      raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  /** Pull notes from the module data (open, undo/redo, external change). */
  function syncNotes(clearSelection: boolean) {
    if (!moduleId) return;
    const mod = appState.graph.modules.get(moduleId);
    if (!mod) {
      appState.closeComposer();
      return;
    }
    const clip = clipFromData(mod.data);
    notes = clip.notes;
    clipLength = clip.length;
    if (clearSelection) selected = new Set();
  }

  /** Write the local note list back to the module (engine updates live). */
  function commit() {
    if (!moduleId) return;
    suppressSync = true;
    appState.setModuleData(moduleId, 'notes', sortNotes(notes));
    suppressSync = false;
  }

  function commitLength(len: number) {
    if (!moduleId) return;
    clipLength = Math.min(COMPOSER_MAX_LENGTH, Math.max(1, Math.round(len * 4) / 4));
    suppressSync = true;
    appState.beginUndoable();
    appState.setModuleData(moduleId, 'length', clipLength);
    suppressSync = false;
  }

  function close() {
    appState.closeComposer();
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

  function gridSize(): { w: number; h: number } {
    return { w: Math.max(50, panelW - KEYS_W - 26), h: Math.max(50, panelH - 188) };
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
    ctx.fillStyle = '#0c0c12';
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
    ctx.fillStyle = '#0c0c12';
    ctx.fillRect(0, 0, w, h);

    // Row shading for black keys, octave separators.
    const first = Math.max(0, yToPitch(h));
    const last = Math.min(127, yToPitch(0));
    for (let p = first; p <= last; p++) {
      const y = pitchToY(p);
      if (BLACK.has(p % 12)) {
        ctx.fillStyle = 'rgba(255,255,255,0.025)';
        ctx.fillRect(0, y, w, rowH);
      }
      if (p % 12 === 11) {
        ctx.fillStyle = 'rgba(255,255,255,0.09)';
        ctx.fillRect(0, y - 0.5, w, 1);
      }
    }

    // Vertical lines: snap grid (faint), beats, bars (4 beats).
    const g = SNAP_BEATS[snap];
    const firstBeat = Math.max(0, Math.floor(xToBeat(0)));
    const lastBeat = Math.ceil(xToBeat(w));
    if (g > 0 && g * zoomX > 5) {
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      for (let b = Math.floor(firstBeat / g) * g; b <= lastBeat; b += g) {
        ctx.fillRect(beatToX(b), 0, 1, h);
      }
    }
    for (let b = firstBeat; b <= lastBeat; b++) {
      ctx.fillStyle = b % 4 === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)';
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
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(
        Math.min(marquee.x0, marquee.x1) + 0.5,
        Math.min(marquee.y0, marquee.y1) + 0.5,
        Math.abs(marquee.x1 - marquee.x0),
        Math.abs(marquee.y1 - marquee.y0),
      );
      ctx.setLineDash([]);
    }

    // Playhead while the transport runs.
    if (appState.transport.playing) {
      const pos = ((appState.transport.songPosition % clipLength) + clipLength) % clipLength;
      const px = beatToX(pos);
      if (px >= 0 && px <= w) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(px, 0, 1.5, h);
      }
    }
  }

  function drawLane() {
    if (!laneEl) return;
    const { w } = gridSize();
    const ctx = laneEl.getContext('2d')!;
    ctx.fillStyle = '#0c0c12';
    ctx.fillRect(0, 0, w, LANE_H);
    const bipolar = laneParam === 'pan';
    const zeroY = bipolar ? LANE_H / 2 : LANE_H - 2;
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
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

  function gridPos(e: PointerEvent): { x: number; y: number } {
    const r = gridEl!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
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
      scrollX = Math.max(0, drag.sx - (e.clientX - drag.startX));
      scrollY = clampScrollY(drag.sy - (e.clientY - drag.startY));
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
    return Math.min(128 * rowH - h, Math.max(0, v));
  }

  function onGridWheel(e: WheelEvent) {
    e.preventDefault();
    const { x, y } = (() => {
      const r = gridEl!.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    })();
    if (e.ctrlKey || e.metaKey) {
      // Ctrl + wheel: zoom the X axis around the cursor.
      const beat = xToBeat(x);
      zoomX = Math.min(480, Math.max(8, zoomX * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      scrollX = Math.max(0, beat * zoomX - x);
    } else if (e.altKey) {
      const pitchAnchor = (y + scrollY) / rowH;
      rowH = Math.min(28, Math.max(6, rowH * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      scrollY = clampScrollY(pitchAnchor * rowH - y);
    } else if (e.shiftKey) {
      scrollX = Math.max(0, scrollX + (e.deltaY + e.deltaX));
    } else {
      scrollY = clampScrollY(scrollY + e.deltaY);
    }
  }

  // -- keys column: click to preview ----------------------------------------

  let previewPitch = -1;

  function onKeysDown(e: PointerEvent) {
    if (!moduleId) return;
    keysEl!.setPointerCapture(e.pointerId);
    const r = keysEl!.getBoundingClientRect();
    previewPitch = Math.min(127, Math.max(0, yToPitch(e.clientY - r.top)));
    appState.noteOn(moduleId, 'roll-preview', previewPitch, 0.8);
  }

  function onKeysUp() {
    if (moduleId && previewPitch >= 0) appState.noteOff(moduleId, 'roll-preview');
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
    const x = e.clientX - r.left;
    const y = Math.min(LANE_H, Math.max(0, e.clientY - r.top));
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
    if (!importFile || !moduleId) return;
    const picked = importFile.notes.filter(
      (n) => importTracks[n.track] && importChannels[n.channel],
    );
    appState.beginUndoable();
    const incoming = picked.map((n) => ({ ...n }) as ComposerNote);
    notes = importReplace ? incoming : [...notes, ...incoming];
    if (importSetLength && importFile.lengthBeats > 0) {
      clipLength = Math.min(
        COMPOSER_MAX_LENGTH,
        Math.max(4, Math.ceil(importFile.lengthBeats / 4) * 4),
      );
      suppressSync = true;
      appState.setModuleData(moduleId, 'length', clipLength);
      suppressSync = false;
    }
    selected = new Set();
    commit();
    importOpen = false;
    importFile = null;
  }

  // -- keyboard shortcuts -----------------------------------------------------

  function onKeyDown(e: KeyboardEvent) {
    if (!open) return;
    const tag = (document.activeElement?.tagName ?? '').toLowerCase();
    if (tag === 'input' || tag === 'select') return;
    if (quantOpen || importOpen) {
      if (e.key === 'Escape') {
        quantOpen = false;
        importOpen = false;
      }
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') close();
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

  // -- panel resize -------------------------------------------------------------

  function onResizeDown(e: PointerEvent) {
    e.preventDefault();
    const startW = panelW;
    const startH = panelH;
    const sx = e.clientX;
    const sy = e.clientY;
    const onMove = (ev: PointerEvent) => {
      panelW = Math.min(window.innerWidth - 24, Math.max(560, startW + ev.clientX - sx));
      panelH = Math.min(window.innerHeight - 24, Math.max(360, startH + ev.clientY - sy));
      scrollY = clampScrollY(scrollY);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }
</script>

<svelte:window onkeydown={onKeyDown} />

{#if open}
  <div class="editor-backdrop">
    <div class="piano-roll" style="width:{panelW}px;height:{panelH}px">
      <div class="header">
        <span class="title">Piano Roll — {title}</span>
        <label title="Loop length in beats (4 per bar)">
          Length
          <input
            type="number"
            min="1"
            max={COMPOSER_MAX_LENGTH}
            step="1"
            value={clipLength}
            onchange={(e) => commitLength(Number((e.target as HTMLInputElement).value))}
          /> beats
        </label>
        <label title="Drawing/moving snap; Off = free (unquantized) notes">
          Snap
          <select bind:value={snap}>
            {#each Object.keys(SNAP_BEATS) as s (s)}<option value={s}>{s}</option>{/each}
          </select>
        </label>
        <span class="spacer"></span>
        <span class="hint">draw: click · delete: right-click · select: ctrl-drag / shift-click · pan: middle-drag · zoom: ctrl-wheel (alt = rows)</span>
        <button onclick={close} title="Close (Esc)">✕</button>
      </div>

      <div class="toolbar-row">
        <button onclick={doCut} disabled={!selected.size} title="Cut selection (Ctrl+X)">Cut</button>
        <button onclick={doCopy} disabled={!selected.size} title="Copy selection (Ctrl+C)">Copy</button>
        <button onclick={doPaste} disabled={!clipboard.length} title="Paste in place (Ctrl+V)">Paste</button>
        <span class="divider"></span>
        <button onclick={() => appState.undo()} title="Undo (Ctrl+Z)">↶ Undo</button>
        <button onclick={() => appState.redo()} title="Redo (Ctrl+Y)">↷ Redo</button>
        <span class="divider"></span>
        <button onclick={() => (quantOpen = true)} title="Snap notes to a grid (with options)">Quantize…</button>
        <button onclick={doHumanize} title="Small random timing/velocity drift — applies to selection or all">Humanize</button>
        <button onclick={doRandomize} title="Scramble pitches and velocities — selection or all">Randomize</button>
        <span class="divider"></span>
        <label class="file-btn" title="Load notes from a .mid file (channel options follow)">
          Load MIDI
          <input type="file" accept=".mid,.midi,audio/midi" onchange={pickMidi} />
        </label>
        <button onclick={saveMidi} title="Download the clip as a standard MIDI file">Save MIDI</button>
        <span class="spacer"></span>
        <span class="count">{notes.length} notes{selected.size ? ` · ${selected.size} selected` : ''}</span>
      </div>

      <div class="body">
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
        ></canvas>
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

      <div
        class="resize-handle"
        onpointerdown={onResizeDown}
        title="Drag to resize the editor"
      ></div>
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
          <label><input type="checkbox" bind:checked={importSetLength} /> Set loop length from file ({Math.ceil(importFile.lengthBeats)} beats)</label>
          <div class="popup-actions">
            <button class="primary" onclick={doImport}>Import</button>
            <button onclick={() => { importOpen = false; importFile = null; }}>Cancel</button>
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .editor-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 60;
  }
  .piano-roll {
    position: relative;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-sizing: border-box;
  }
  .header,
  .toolbar-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: nowrap;
  }
  .title {
    font-weight: 700;
    color: var(--text);
    font-size: 13px;
    white-space: nowrap;
  }
  .hint {
    font-size: 10px;
    color: var(--text-dim);
    text-align: right;
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
  }
  canvas {
    border-radius: 4px;
    touch-action: none;
    display: block;
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
  .resize-handle {
    position: absolute;
    right: 2px;
    bottom: 2px;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    background: linear-gradient(135deg, transparent 50%, var(--text-dim) 50%);
    border-bottom-right-radius: 8px;
    opacity: 0.6;
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
