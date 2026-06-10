<script lang="ts">
  import { onMount } from 'svelte';
  import { sampleKey, type SampleData } from '../core/samples';
  import * as ops from '../core/sampleops';
  import { appState } from '../state';

  // PRD §8.2: waveform view with zoom, trim, cut/copy/paste, normalize,
  // reverse, fades, loop points with crossfade, pitch shift, time stretch.
  // Non-destructive: all ops hit a working copy; the store changes on Save only.

  let open = $state(false);
  let title = $state('');
  let dirty = $state(false);
  let lengthText = $state('');
  let selection = $state<{ start: number; end: number } | null>(null);
  let cursor = $state(0);
  let zoom = $state(1);
  let viewStart = $state(0); // frames
  let loopStart = $state<number | null>(null);
  let loopEnd = $state<number | null>(null);
  let pitchSemis = $state(0);
  let stretchPct = $state(100);
  let crossfadeMs = $state(20);

  let target: { moduleId: string; pad?: number } | null = null;
  let working: SampleData | null = null;
  let clipboard = $state<Float32Array[] | null>(null);
  let canvasEl: HTMLCanvasElement | undefined = $state();

  const W = 760;
  const H = 200;

  onMount(() => appState.on('editorChanged', sync));

  function sync() {
    target = appState.editingSample;
    if (!target) {
      open = false;
      working = null;
      return;
    }
    const src = appState.samples.get(sampleKey(target.moduleId, target.pad));
    if (!src) {
      open = false;
      return;
    }
    working = {
      name: src.name,
      sampleRate: src.sampleRate,
      channels: src.channels.map((c) => c.slice()),
      loopStart: src.loopStart,
      loopEnd: src.loopEnd,
    };
    title = target.pad !== undefined ? `${src.name} — pad ${target.pad + 1}` : src.name;
    dirty = false;
    selection = null;
    cursor = 0;
    zoom = 1;
    viewStart = 0;
    loopStart = src.loopStart ?? null;
    loopEnd = src.loopEnd ?? null;
    open = true;
    updateLengthText();
    requestAnimationFrame(draw);
  }

  function frames(): number {
    return working?.channels[0]?.length ?? 0;
  }

  function viewLen(): number {
    return Math.max(2, Math.round(frames() / zoom));
  }

  function updateLengthText() {
    if (!working) return;
    const s = frames() / working.sampleRate;
    lengthText = `${frames()} frames · ${s.toFixed(3)} s · ${working.sampleRate} Hz · ${working.channels.length} ch`;
  }

  // -- waveform drawing -----------------------------------------------------

  function draw() {
    if (!canvasEl || !working) return;
    const ctx = canvasEl.getContext('2d')!;
    const css = getComputedStyle(document.documentElement);
    ctx.fillStyle = css.getPropertyValue('--bg').trim() || '#16161c';
    ctx.fillRect(0, 0, W, H);

    const len = frames();
    const v0 = Math.max(0, Math.min(len - 2, viewStart));
    const vl = Math.min(viewLen(), len - v0);
    const pcm = working.channels[0];
    const pcm2 = working.channels[1];

    // Selection backdrop.
    if (selection) {
      const x0 = ((Math.min(selection.start, selection.end) - v0) / vl) * W;
      const x1 = ((Math.max(selection.start, selection.end) - v0) / vl) * W;
      ctx.fillStyle = 'rgba(255, 177, 61, 0.18)';
      ctx.fillRect(x0, 0, x1 - x0, H);
    }

    // Peaks.
    ctx.strokeStyle = '#ffb13d';
    ctx.beginPath();
    const mid = H / 2;
    const perCol = vl / W;
    for (let x = 0; x < W; x++) {
      const start = Math.floor(v0 + x * perCol);
      const end = Math.min(len, Math.ceil(v0 + (x + 1) * perCol));
      let min = 1;
      let max = -1;
      const stride = Math.max(1, Math.floor((end - start) / 32));
      for (let i = start; i < end; i += stride) {
        const v = pcm2 ? (pcm[i] + pcm2[i]) / 2 : pcm[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (max < min) continue;
      ctx.moveTo(x + 0.5, mid - max * (mid - 4));
      ctx.lineTo(x + 0.5, mid - min * (mid - 4) + 1);
    }
    ctx.stroke();

    // Center line.
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(W, mid);
    ctx.stroke();

    // Loop markers.
    if (loopStart !== null && loopEnd !== null) {
      for (const [pos, label] of [
        [loopStart, 'L'],
        [loopEnd, 'R'],
      ] as const) {
        const x = ((pos - v0) / vl) * W;
        if (x < 0 || x > W) continue;
        ctx.strokeStyle = '#52e07a';
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, H);
        ctx.stroke();
        ctx.fillStyle = '#52e07a';
        ctx.fillText(label, x + 3, 12);
      }
    }

    // Cursor.
    const cx = ((cursor - v0) / vl) * W;
    if (cx >= 0 && cx <= W && !selection) {
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(cx + 0.5, 0);
      ctx.lineTo(cx + 0.5, H);
      ctx.stroke();
    }
  }

  // -- canvas interaction: click = cursor, drag = selection -------------------

  function frameAt(clientX: number): number {
    const rect = canvasEl!.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * W;
    return Math.max(0, Math.min(frames(), Math.round(viewStart + (x / W) * viewLen())));
  }

  function onCanvasDown(e: PointerEvent) {
    if (!working) return;
    const anchor = frameAt(e.clientX);
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const f = frameAt(ev.clientX);
      if (Math.abs(f - anchor) > viewLen() / 200) moved = true;
      if (moved) {
        selection = { start: Math.min(anchor, f), end: Math.max(anchor, f) };
        draw();
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!moved) {
        selection = null;
        cursor = anchor;
        draw();
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // -- zoom / scroll ----------------------------------------------------------

  function setZoom(z: number) {
    const center = selection
      ? (selection.start + selection.end) / 2
      : viewStart + viewLen() / 2;
    zoom = Math.max(1, Math.min(256, z));
    viewStart = Math.max(0, Math.min(frames() - viewLen(), Math.round(center - viewLen() / 2)));
    draw();
  }

  function onScroll(e: Event) {
    viewStart = Number((e.currentTarget as HTMLInputElement).value);
    draw();
  }

  // -- operations ---------------------------------------------------------------

  function region(): ops.Region | null {
    return selection && selection.end > selection.start ? selection : null;
  }

  function afterStructuralChange() {
    selection = null;
    cursor = Math.min(cursor, frames());
    if (loopStart !== null && loopEnd !== null && loopEnd > frames()) {
      loopStart = null;
      loopEnd = null;
      if (working) {
        working.loopStart = undefined;
        working.loopEnd = undefined;
      }
    }
    zoom = 1;
    viewStart = 0;
  }

  function apply(fn: (ch: ops.Channels) => ops.Channels, structural = false) {
    if (!working) return;
    working.channels = fn(working.channels);
    dirty = true;
    if (structural) afterStructuralChange();
    updateLengthText();
    draw();
  }

  function doTrim() {
    const r = region();
    if (r) apply((ch) => ops.trim(ch, r), true);
  }
  function doCut() {
    const r = region();
    if (!r || !working) return;
    clipboard = ops.copy(working.channels, r);
    apply((ch) => ops.remove(ch, r), true);
  }
  function doCopy() {
    const r = region();
    if (r && working) clipboard = ops.copy(working.channels, r);
  }
  function doPaste() {
    if (!clipboard) return;
    const clip = clipboard;
    const r = region();
    if (r) {
      // Paste over the selection: remove it, insert at its start.
      apply((ch) => ops.insert(ops.remove(ch, r), r.start, clip), true);
    } else {
      apply((ch) => ops.insert(ch, cursor, clip), true);
    }
  }
  function doNormalize() {
    apply((ch) => ops.normalize(ch, region() ?? undefined));
  }
  function doReverse() {
    apply((ch) => ops.reverse(ch, region() ?? undefined));
  }
  function doFadeIn() {
    apply((ch) => ops.fadeIn(ch, region() ?? undefined));
  }
  function doFadeOut() {
    apply((ch) => ops.fadeOut(ch, region() ?? undefined));
  }
  function doPitch() {
    if (pitchSemis !== 0) apply((ch) => ops.pitchShift(ch, pitchSemis), true);
  }
  function doStretch() {
    const f = stretchPct / 100;
    if (f > 0 && f !== 1) apply((ch) => ops.timeStretch(ch, f), true);
  }

  function setLoopFromSelection() {
    const r = region();
    if (!r || !working) return;
    loopStart = r.start;
    loopEnd = r.end;
    working.loopStart = r.start;
    working.loopEnd = r.end;
    dirty = true;
    draw();
  }
  function clearLoop() {
    loopStart = null;
    loopEnd = null;
    if (working) {
      working.loopStart = undefined;
      working.loopEnd = undefined;
    }
    dirty = true;
    draw();
  }
  function doCrossfade() {
    if (loopStart === null || loopEnd === null || !working) return;
    const fade = Math.round((crossfadeMs / 1000) * working.sampleRate);
    const ls = loopStart;
    const le = loopEnd;
    apply((ch) => ops.crossfadeLoop(ch, ls, le, fade));
  }

  // -- preview / save / cancel ---------------------------------------------------

  async function preview() {
    if (!working) return;
    await appState.ensureEngine();
    const r = region();
    const ch = r ? ops.copy(working.channels, r) : working.channels;
    appState.engine.preview(working.sampleRate, ch);
  }

  function save() {
    if (!target || !working) return;
    appState.setSample(target.moduleId, working, target.pad);
    appState.closeSampleEditor();
  }

  function cancel() {
    appState.closeSampleEditor();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!open) return;
    const tag = (document.activeElement?.tagName ?? '').toLowerCase();
    if (tag === 'input') return;
    if (e.key === 'Escape') cancel();
    if (e.key === 'Delete' || e.key === 'Backspace') doCut();
  }
</script>

<svelte:window onkeydown={onKeyDown} />

{#if open}
  <div class="editor-backdrop">
    <div class="sample-editor">
      <div class="header">
        <span class="title">Sample Editor — {title}{dirty ? ' *' : ''}</span>
        <span class="length">{lengthText}</span>
        <span class="spacer"></span>
        <button onclick={preview} title="Play the working copy (selection if any)">▶ Preview</button>
        <button onclick={() => appState.engine.stopPreview()} title="Stop preview">⏹</button>
        <button class="save" onclick={save} disabled={!dirty} title="Write changes back to the module">Save</button>
        <button onclick={cancel} title="Discard changes (Esc)">Cancel</button>
      </div>

      <canvas
        bind:this={canvasEl}
        width={W}
        height={H}
        onpointerdown={onCanvasDown}
        title="Click: place cursor. Drag: select a region."
      ></canvas>

      {#if zoom > 1}
        <input
          class="scroll"
          type="range"
          min="0"
          max={Math.max(0, frames() - viewLen())}
          step="1"
          value={viewStart}
          oninput={onScroll}
        />
      {/if}

      <div class="toolbar-row">
        <button onclick={() => setZoom(zoom * 2)} title="Zoom in">🔍+</button>
        <button onclick={() => setZoom(zoom / 2)} disabled={zoom <= 1} title="Zoom out">🔍−</button>
        <span class="divider"></span>
        <button onclick={doTrim} disabled={!selection} title="Keep only the selection">Trim</button>
        <button onclick={doCut} disabled={!selection} title="Cut selection to clipboard (Del)">Cut</button>
        <button onclick={doCopy} disabled={!selection} title="Copy selection">Copy</button>
        <button onclick={doPaste} disabled={!clipboard} title="Paste at cursor / over selection">Paste</button>
        <span class="divider"></span>
        <button onclick={doNormalize} title="Normalize selection or whole sample to −0.45 dB">Normalize</button>
        <button onclick={doReverse} title="Reverse selection or whole sample">Reverse</button>
        <button onclick={doFadeIn} title="Fade in over selection or whole sample">Fade In</button>
        <button onclick={doFadeOut} title="Fade out over selection or whole sample">Fade Out</button>
      </div>

      <div class="toolbar-row">
        <label title="Tape-style pitch shift; length changes with pitch">
          Pitch
          <input type="number" min="-24" max="24" step="1" bind:value={pitchSemis} /> st
          <button onclick={doPitch} disabled={pitchSemis === 0}>Apply</button>
        </label>
        <span class="divider"></span>
        <label title="Time stretch without pitch change (overlap-add)">
          Stretch
          <input type="number" min="25" max="400" step="5" bind:value={stretchPct} /> %
          <button onclick={doStretch} disabled={stretchPct === 100}>Apply</button>
        </label>
        <span class="divider"></span>
        <button onclick={setLoopFromSelection} disabled={!selection} title="Loop region = selection (sampler loop mode)">
          Set Loop
        </button>
        <button onclick={clearLoop} disabled={loopStart === null} title="Remove the loop region">Clear Loop</button>
        <label title="Bake a click-free crossfade at the loop seam">
          <input type="number" min="1" max="500" step="1" bind:value={crossfadeMs} /> ms
          <button onclick={doCrossfade} disabled={loopStart === null}>Crossfade</button>
        </label>
      </div>
    </div>
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
  .sample-editor {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    padding: 12px;
    width: 790px;
    max-width: 95vw;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .title {
    font-weight: 700;
    color: var(--text);
    font-size: 13px;
  }
  .length {
    font-size: 11px;
    color: var(--text-dim);
  }
  .spacer {
    flex: 1;
  }
  canvas {
    width: 100%;
    border-radius: 6px;
    cursor: text;
    touch-action: none;
  }
  .scroll {
    width: 100%;
  }
  .toolbar-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .toolbar-row label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .toolbar-row input[type='number'] {
    width: 56px;
  }
  .divider {
    width: 1px;
    height: 18px;
    background: var(--panel-border);
    margin: 0 4px;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .save {
    background: var(--accent);
    color: #1a1a20;
    font-weight: 600;
  }
</style>
