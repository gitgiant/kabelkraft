<script lang="ts">
  import { onMount } from 'svelte';
  import {
    bindableParams,
    colorSources,
    defaultFace,
    meterTargets,
    newFaceElement,
    pruneFaceBindings,
    snapTo,
    type BindTarget,
    type FaceElement,
    type FaceElementKind,
    type FaceSpec,
  } from '../core/face';
  import { appState } from '../state';
  import { RESIZE_DIRS, resizeCursor, resizeSize, type ResizeDir } from '../canvas/resize';

  let groupId = $state<string | null>(null);
  let face = $state<FaceSpec>(defaultFace());
  let selectedId = $state<string | null>(null);
  let learning = $state(false);
  let targets = $state<BindTarget[]>([]);
  let meterMods = $state<Array<{ moduleId: string; label: string }>>([]);
  let colorMods = $state<Array<{ moduleId: string; label: string }>>([]);
  let poleInfo = $state<ReturnType<(typeof appState.graph)['groupPoleEditInfo']>>({ poles: [], addable: [] });
  let bgFileInput: HTMLInputElement;
  let imgFileInput: HTMLInputElement;

  const KINDS: Array<{ kind: FaceElementKind; label: string }> = [
    { kind: 'knob', label: '◉ Knob' },
    { kind: 'slider', label: '▭ Slider' },
    { kind: 'xy', label: '⊞ XY Pad' },
    { kind: 'button', label: '▣ Button' },
    { kind: 'label', label: 'A Label' },
    { kind: 'image', label: '🖼 Image' },
    { kind: 'meter', label: '▮ Meter' },
    { kind: 'readout', label: '# Readout' },
  ];

  const selected = $derived(face.elements.find((e) => e.id === selectedId) ?? null);

  function open(id: string) {
    const group = appState.graph.groups.get(id);
    if (!group) return;
    groupId = id;
    face = group.face ? structuredClone(group.face) : defaultFace();
    pruneFaceBindings(appState.graph, id, face);
    targets = bindableParams(appState.graph, id);
    meterMods = meterTargets(appState.graph, id);
    colorMods = colorSources(appState.graph, id);
    poleInfo = appState.graph.groupPoleEditInfo(id);
    selectedId = null;
    learning = false;
  }

  function refreshPoles() {
    if (groupId) poleInfo = appState.graph.groupPoleEditInfo(groupId);
  }

  function togglePole(key: string, visible: boolean) {
    if (!groupId) return;
    if (visible) appState.hideGroupPole(groupId, key);
    else appState.showGroupPole(groupId, key);
    refreshPoles();
  }

  function addPole(key: string) {
    if (!groupId || !key) return;
    const opt = poleInfo.addable.find((a) => a.key === key);
    if (opt?.baseline) appState.showGroupPole(groupId, key);
    else appState.addGroupPole(groupId, key);
    refreshPoles();
  }

  onMount(() => {
    const offE = appState.on('faceEditorChanged', () => {
      if (appState.editingFaceGroupId) open(appState.editingFaceGroupId);
      else groupId = null;
    });
    const offL = appState.on('faceLearnChanged', () => {
      learning = appState.faceLearn !== null;
      const result = appState.faceLearnResult;
      if (result && selected && groupId) {
        if (selected.kind === 'meter') {
          selected.moduleId = result.moduleId;
        } else if (selected.kind === 'xy' && selected.moduleId && selected.paramId) {
          selected.moduleId2 = result.moduleId;
          selected.paramId2 = result.paramId;
        } else {
          selected.moduleId = result.moduleId;
          selected.paramId = result.paramId;
        }
        appState.faceLearnResult = null;
        // Membership can have changed while expanded (modules added inside).
        targets = bindableParams(appState.graph, groupId);
        meterMods = meterTargets(appState.graph, groupId);
        colorMods = colorSources(appState.graph, groupId);
      }
    });
    const offG = appState.on('graphChanged', () => {
      if (groupId) poleInfo = appState.graph.groupPoleEditInfo(groupId);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && appState.faceLearn) appState.cancelFaceLearn();
      else if (e.key === 'Escape' && groupId && !learning) cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      offE();
      offL();
      offG();
      window.removeEventListener('keydown', onKey);
    };
  });

  function addElement(kind: FaceElementKind) {
    const el = newFaceElement(face, kind, face.width / 2 - 40, face.height / 2 - 40);
    face.elements.push(el);
    selectedId = el.id;
  }

  function removeSelected() {
    if (!selectedId) return;
    face.elements = face.elements.filter((e) => e.id !== selectedId);
    selectedId = null;
  }

  function startDrag(e: PointerEvent, el: FaceElement, resize = false) {
    e.stopPropagation();
    selectedId = el.id;
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = el.x;
    const oy = el.y;
    const ow = el.w;
    const oh = el.h;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (resize) {
        el.w = Math.max(16, snapTo(ow + dx, face.grid, face.snap));
        el.h = Math.max(14, snapTo(oh + dy, face.grid, face.snap));
      } else {
        el.x = Math.min(face.width - 10, Math.max(0, snapTo(ox + dx, face.grid, face.snap)));
        el.y = Math.min(face.height - 10, Math.max(0, snapTo(oy + dy, face.grid, face.snap)));
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /** Drag any of the 8 edge/corner handles to resize the whole panel. */
  function startPanelResize(e: PointerEvent, dir: ResizeDir) {
    e.stopPropagation();
    selectedId = null;
    const sx = e.clientX;
    const sy = e.clientY;
    const ow = face.width;
    const oh = face.height;
    const onMove = (ev: PointerEvent) => {
      const { w, h } = resizeSize(dir, ev.clientX - sx, ev.clientY - sy, ow, oh);
      face.width = Math.min(1200, Math.max(120, Math.round(w)));
      face.height = Math.min(900, Math.max(80, Math.round(h)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /** Inline placement for a panel resize handle (edges full-span, corners boxed). */
  function panelHandleStyle(dir: ResizeDir): string {
    const T = 8; // edge thickness
    const C = 14; // corner box
    const pos: string[] = [`cursor:${resizeCursor(dir)}`, 'position:absolute', 'z-index:5'];
    const isCorner = dir.length === 2;
    // Anchored just inside the edges — .surface has overflow:hidden, so handles
    // placed outside would be clipped and unclickable.
    if (isCorner) {
      pos.push(`width:${C}px`, `height:${C}px`);
      pos.push(dir.includes('n') ? 'top:0' : 'bottom:0');
      pos.push(dir.includes('w') ? 'left:0' : 'right:0');
      pos.push('z-index:6');
    } else if (dir === 'n' || dir === 's') {
      pos.push(`left:${C}px`, `right:${C}px`, `height:${T}px`);
      pos.push(dir === 'n' ? 'top:0' : 'bottom:0');
    } else {
      pos.push(`top:${C}px`, `bottom:${C}px`, `width:${T}px`);
      pos.push(dir === 'w' ? 'left:0' : 'right:0');
    }
    return pos.join(';');
  }

  /** Drag the ⟳ handle to rotate about the element center; shift snaps to 15°. */
  function startRotate(e: PointerEvent, el: FaceElement) {
    e.stopPropagation();
    selectedId = el.id;
    const node = (e.currentTarget as HTMLElement).parentElement!;
    const r = node.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const onMove = (ev: PointerEvent) => {
      let deg = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI + 90;
      if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
      deg = ((Math.round(deg) % 360) + 360) % 360;
      el.rot = deg === 0 ? undefined : deg;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function bindingValue(el: FaceElement, axis: 1 | 2): string {
    const m = axis === 1 ? el.moduleId : el.moduleId2;
    const p = axis === 1 ? el.paramId : el.paramId2;
    return m && p ? `${m}:${p}` : '';
  }

  function setBinding(el: FaceElement, axis: 1 | 2, key: string) {
    const [moduleId, paramId] = key ? key.split(':') : [undefined, undefined];
    if (axis === 1) {
      el.moduleId = moduleId;
      el.paramId = paramId;
    } else {
      el.moduleId2 = moduleId;
      el.paramId2 = paramId;
    }
  }

  async function loadImageFile(e: Event, apply: (assetId: string) => void) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const dataUrl = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsDataURL(file);
    });
    apply(appState.addFaceAsset(dataUrl));
    (e.target as HTMLInputElement).value = '';
  }

  function assetUrl(id?: string): string | undefined {
    return id ? appState.faceAssets.get(id) : undefined;
  }

  function hex(c?: number): string {
    return `#${(c ?? 0x222230).toString(16).padStart(6, '0')}`;
  }

  function save() {
    if (!groupId) return;
    appState.setGroupFace(groupId, structuredClone($state.snapshot(face)) as FaceSpec);
    appState.closeFaceEditor();
  }

  function cancel() {
    appState.closeFaceEditor();
  }
</script>

{#if groupId}
  <div class="face-editor" class:learning>
    {#if learning}
      <div class="learn-banner">
        🎯 Learn: click a parameter on a module inside the group… (Esc cancels)
      </div>
    {:else}
      <div class="panel">
        <div class="header">
          <strong>Face Editor</strong>
          <label>W <input type="number" min="120" max="1200" bind:value={face.width} /></label>
          <label>H <input type="number" min="80" max="900" bind:value={face.height} /></label>
          <label>Grid <input type="number" min="2" max="50" bind:value={face.grid} /></label>
          <label><input type="checkbox" bind:checked={face.snap} /> Snap</label>
          <label>
            BG
            <input
              type="color"
              value={hex(face.bgColor)}
              oninput={(e) => (face.bgColor = parseInt(e.currentTarget.value.slice(1), 16))}
            />
          </label>
          <button onclick={() => bgFileInput.click()} title="Load a background image">BG Image</button>
          {#if face.bgAssetId}
            <button onclick={() => (face.bgAssetId = undefined)} title="Remove background image">✕ BG</button>
          {/if}
          <span class="spacer"></span>
          <button class="primary" onclick={save}>Save Face</button>
          <button onclick={cancel}>Cancel</button>
        </div>

        <div class="body">
          <div class="kinds">
            {#each KINDS as k}
              <button onclick={() => addElement(k.kind)}>{k.label}</button>
            {/each}
          </div>

          <div class="surface-wrap">
            <div
              class="surface"
              style:width="{face.width}px"
              style:height="{face.height}px"
              style:background-color={hex(face.bgColor ?? 0x222230)}
              style:background-image={assetUrl(face.bgAssetId)
                ? `url(${assetUrl(face.bgAssetId)})`
                : face.snap
                  ? `repeating-linear-gradient(0deg, transparent, transparent ${face.grid - 1}px, rgba(255,255,255,0.06) ${face.grid}px), repeating-linear-gradient(90deg, transparent, transparent ${face.grid - 1}px, rgba(255,255,255,0.06) ${face.grid}px)`
                  : 'none'}
              style:background-size={assetUrl(face.bgAssetId) ? '100% 100%' : 'auto'}
              onpointerdown={() => (selectedId = null)}
            >
              {#each RESIZE_DIRS as dir (dir)}
                <div
                  class="panel-resize"
                  style={panelHandleStyle(dir)}
                  onpointerdown={(e) => startPanelResize(e, dir)}
                ></div>
              {/each}
              {#each face.elements as el (el.id)}
                <div
                  class="el {el.kind}"
                  class:selected={el.id === selectedId}
                  class:unbound={!el.moduleId && el.kind !== 'label' && el.kind !== 'image'}
                  style:left="{el.x}px"
                  style:top="{el.y}px"
                  style:width="{el.w}px"
                  style:height="{el.h}px"
                  style:transform={el.rot ? `rotate(${el.rot}deg)` : 'none'}
                  onpointerdown={(e) => startDrag(e, el)}
                >
                  {#if el.kind === 'knob'}
                    <div class="knob-circle"></div>
                  {:else if el.kind === 'slider'}
                    <div class="slider-track" class:horiz={el.w > el.h}></div>
                  {:else if el.kind === 'xy'}
                    <div class="xy-pad"><div class="puck"></div></div>
                  {:else if el.kind === 'button'}
                    <div class="btn-face"></div>
                  {:else if el.kind === 'label'}
                    <span style:font-size="{el.size ?? 13}px" style:color={el.color !== undefined ? hex(el.color) : 'var(--text)'}>{el.text}</span>
                  {:else if el.kind === 'image'}
                    {#if assetUrl(el.assetId)}
                      <img src={assetUrl(el.assetId)} alt="" draggable="false" />
                    {:else}
                      <div class="img-placeholder">🖼</div>
                    {/if}
                  {:else if el.kind === 'meter'}
                    <div class="meter-bar"></div>
                  {:else}
                    <div class="readout-box">0.00</div>
                  {/if}
                  {#if el.label}
                    <span class="caption">{el.label}</span>
                  {/if}
                  {#if el.id === selectedId}
                    <div class="resize" onpointerdown={(e) => startDrag(e, el, true)}></div>
                    <div class="rotate" title="Drag to rotate (shift: 15° steps)" onpointerdown={(e) => startRotate(e, el)}></div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>

          <div class="inspector">
            <div class="poles">
              <div class="poles-head">Group Poles</div>
              {#each poleInfo.poles as p (p.key)}
                <label class="pole-row" title={p.wired ? 'Wired — detach the wire to hide this pole' : ''}>
                  <input
                    type="checkbox"
                    checked={true}
                    disabled={p.wired}
                    onchange={() => togglePole(p.key, true)}
                  />
                  <span class="dir {p.direction}">{p.direction === 'in' ? '▸' : '▹'}</span>
                  <span class="pole-label">{p.label}</span>
                </label>
              {/each}
              {#if poleInfo.addable.length}
                <select class="add-pole" value="" onchange={(e) => { addPole(e.currentTarget.value); e.currentTarget.value = ''; }}>
                  <option value="">＋ Add pole…</option>
                  {#each poleInfo.addable as a (a.key)}
                    <option value={a.key}>{a.label}{a.baseline ? '' : ' (tap)'}</option>
                  {/each}
                </select>
              {/if}
            </div>
            {#if selected}
              <div class="row"><strong>{selected.kind}</strong> <code>{selected.id}</code></div>
              <div class="row">
                <label>X <input type="number" bind:value={selected.x} /></label>
                <label>Y <input type="number" bind:value={selected.y} /></label>
              </div>
              <div class="row">
                <label>W <input type="number" bind:value={selected.w} /></label>
                <label>H <input type="number" bind:value={selected.h} /></label>
              </div>
              <div class="row">
                <label>Rot°
                  <input
                    type="number"
                    step="5"
                    value={selected.rot ?? 0}
                    oninput={(e) => (selected!.rot = ((Number(e.currentTarget.value) % 360) + 360) % 360 || undefined)}
                  />
                </label>
              </div>
              {#if selected.kind !== 'label' && selected.kind !== 'image'}
                <label class="full">Caption <input type="text" bind:value={selected.label} /></label>
              {/if}

              {#if selected.kind === 'label'}
                <label class="full">Text <input type="text" bind:value={selected.text} /></label>
                <div class="row">
                  <label>Size <input type="number" min="8" max="64" bind:value={selected.size} /></label>
                  <label>
                    Color
                    <input
                      type="color"
                      value={selected.color !== undefined ? hex(selected.color) : '#d8d8e0'}
                      oninput={(e) => (selected!.color = parseInt(e.currentTarget.value.slice(1), 16))}
                    />
                  </label>
                </div>
              {:else if selected.kind === 'image'}
                <button onclick={() => imgFileInput.click()}>Load image…</button>
              {:else if selected.kind === 'meter'}
                <label class="full">
                  Module
                  <select
                    value={selected.moduleId ?? ''}
                    onchange={(e) => (selected!.moduleId = e.currentTarget.value || undefined)}
                  >
                    <option value="">— unbound —</option>
                    {#each meterMods as m}
                      <option value={m.moduleId}>{m.label}</option>
                    {/each}
                  </select>
                </label>
              {:else}
                <label class="full">
                  {selected.kind === 'xy' ? 'X binding' : 'Binding'}
                  <select
                    value={bindingValue(selected, 1)}
                    onchange={(e) => setBinding(selected!, 1, e.currentTarget.value)}
                  >
                    <option value="">— unbound —</option>
                    {#each targets as t}
                      <option value="{t.moduleId}:{t.paramId}">{t.label}</option>
                    {/each}
                  </select>
                </label>
                {#if selected.kind === 'xy'}
                  <label class="full">
                    Y binding
                    <select
                      value={bindingValue(selected, 2)}
                      onchange={(e) => setBinding(selected!, 2, e.currentTarget.value)}
                    >
                      <option value="">— unbound —</option>
                      {#each targets as t}
                        <option value="{t.moduleId}:{t.paramId}">{t.label}</option>
                      {/each}
                    </select>
                  </label>
                {/if}
                <button onclick={() => groupId && appState.armFaceLearn(groupId)} title="Then click a param on a module inside the group">
                  🎯 Learn binding
                </button>
                {#if selected.kind !== 'readout'}
                  <label class="full">
                    Color source
                    <select
                      value={selected.colorModuleId ?? ''}
                      onchange={(e) => (selected!.colorModuleId = e.currentTarget.value || undefined)}
                    >
                      <option value="">— static —</option>
                      {#each colorMods as m}
                        <option value={m.moduleId}>{m.label}</option>
                      {/each}
                    </select>
                  </label>
                {/if}
              {/if}
              <button class="danger" onclick={removeSelected}>Delete element</button>
            {:else}
              <p class="hint">
                Add elements from the left, drag them on the face, then bind each to an inner
                module parameter. The face renders on the collapsed group tile.
              </p>
            {/if}
          </div>
        </div>
      </div>
    {/if}
    <input bind:this={bgFileInput} type="file" accept="image/*" hidden onchange={(e) => loadImageFile(e, (id) => (face.bgAssetId = id))} />
    <input bind:this={imgFileInput} type="file" accept="image/*" hidden onchange={(e) => loadImageFile(e, (id) => selected && (selected.assetId = id))} />
  </div>
{/if}

<style>
  .face-editor {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 60;
  }
  .face-editor.learning {
    background: transparent;
    pointer-events: none;
    align-items: flex-start;
    justify-content: center;
  }
  .learn-banner {
    pointer-events: auto;
    margin-top: 60px;
    background: var(--panel);
    border: 1px solid var(--accent);
    color: var(--accent);
    border-radius: 8px;
    padding: 8px 16px;
    font-size: 13px;
    animation: pulse 1s infinite alternate;
  }
  @keyframes pulse {
    from { opacity: 1; }
    to { opacity: 0.55; }
  }
  .panel {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    width: min(96vw, 1100px);
    max-height: 92vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--panel-border);
    flex-wrap: wrap;
  }
  .header label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .header input[type='number'] {
    width: 56px;
  }
  .spacer {
    flex: 1;
  }
  .primary {
    background: var(--accent);
    color: #1a1a20;
    font-weight: 600;
  }
  .body {
    display: flex;
    min-height: 0;
    flex: 1;
  }
  .kinds {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px;
    border-right: 1px solid var(--panel-border);
    min-width: 110px;
  }
  .surface-wrap {
    flex: 1;
    overflow: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    background: var(--bg);
  }
  .surface {
    position: relative;
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    overflow: hidden;
    flex-shrink: 0;
  }
  /* Invisible edge/corner grab zones for resizing the whole panel. */
  .panel-resize {
    background: transparent;
    touch-action: none;
  }
  .el {
    position: absolute;
    cursor: move;
    user-select: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .el.selected {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .el.unbound {
    opacity: 0.5;
  }
  .knob-circle {
    width: 70%;
    aspect-ratio: 1;
    border-radius: 50%;
    background: var(--control);
    border: 3px solid #ff3dd0;
  }
  .slider-track {
    width: 10px;
    height: 90%;
    border-radius: 5px;
    background: linear-gradient(0deg, #ff3dd0 40%, var(--control) 40%);
  }
  .slider-track.horiz {
    width: 90%;
    height: 10px;
    background: linear-gradient(90deg, #ff3dd0 40%, var(--control) 40%);
  }
  .xy-pad {
    width: 100%;
    height: 100%;
    background: var(--control);
    border-radius: 6px;
    position: relative;
  }
  .puck {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 14px;
    height: 14px;
    margin: -7px;
    border-radius: 50%;
    background: #ff3dd0;
    border: 2px solid var(--text);
  }
  .btn-face {
    width: 100%;
    height: 100%;
    border-radius: 10px;
    background: var(--control);
    border: 2px solid var(--control-border);
  }
  .img-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--control);
    border-radius: 6px;
    font-size: 22px;
  }
  .el img {
    width: 100%;
    height: 100%;
    object-fit: fill;
    pointer-events: none;
  }
  .meter-bar {
    width: 100%;
    height: 100%;
    border-radius: 4px;
    background: linear-gradient(90deg, #52e07a 55%, var(--control) 55%);
  }
  .readout-box {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--control);
    border-radius: 4px;
    font-size: 11px;
    color: var(--text);
  }
  .caption {
    font-size: 10px;
    color: var(--text-dim);
    margin-top: 2px;
    pointer-events: none;
  }
  .resize {
    position: absolute;
    right: -6px;
    bottom: -6px;
    width: 12px;
    height: 12px;
    background: var(--accent);
    border-radius: 3px;
    cursor: nwse-resize;
  }
  .rotate {
    position: absolute;
    top: -20px;
    left: 50%;
    margin-left: -6px;
    width: 12px;
    height: 12px;
    background: var(--accent);
    border-radius: 50%;
    cursor: grab;
  }
  .inspector {
    width: 230px;
    border-left: 1px solid var(--panel-border);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow-y: auto;
  }
  .inspector .row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .inspector label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--text-dim);
    min-width: 0;
  }
  .inspector label.full {
    flex-direction: column;
    align-items: stretch;
  }
  .inspector input[type='number'] {
    width: 58px;
  }
  .inspector select,
  .inspector input[type='text'] {
    width: 100%;
  }
  .poles {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-bottom: 10px;
    margin-bottom: 6px;
    border-bottom: 1px solid var(--panel-border);
  }
  .poles-head {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-dim);
  }
  .pole-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text);
  }
  .pole-row .dir {
    color: var(--text-dim);
  }
  .pole-row .dir.out {
    color: var(--accent);
  }
  .pole-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .add-pole {
    width: 100%;
    margin-top: 2px;
  }
  .danger {
    color: #ff5050;
  }
  .hint {
    font-size: 12px;
    color: var(--text-dim);
    line-height: 1.5;
  }
</style>
