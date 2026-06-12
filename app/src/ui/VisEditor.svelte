<script lang="ts">
  import { onMount } from 'svelte';
  import { patchCanvas } from '../canvas/PatchCanvas';
  import { appState } from '../state';
  import { visGraphOf } from '../visual/migrate';
  import { VIS_NODE_DEFS } from '../visual/registry';
  import { ContainerRenderer, webgpuAvailable } from '../visual/runtime';
  import type { VisGraphData, VisNodeDef, VisNodeInstance, VisPortType, VisWire } from '../visual/types';

  // Visual graph editor — edits a visualizer container's nested node graph
  // (VISUALIZER_ENGINE_PLAN.md Phase 2). Opens IN PLACE: the tile grows (like
  // the composer's piano roll) and this panel pins itself over the module,
  // tracking canvas pan/zoom. Layout: palette | SVG graph | inspector with a
  // live preview. Mutations go through appState.setVisGraph (undoable);
  // drag gestures snapshot once at gesture start.

  let open = $state(false);
  let moduleId: string | null = null;

  // Panel anchoring over the module tile (PianoRoll pattern).
  const INSET_X = 14;
  const INSET_T = 28; // below the tile title bar
  const INSET_B = 14;
  let panelLeft = $state(0);
  let panelTop = $state(0);
  let panelW = $state(800);
  let panelH = $state(520);
  let scale = $state(1);
  let onScreen = $state(true);

  /** Pin the panel over the module's face area each frame, tracking zoom. */
  function reposition(): void {
    if (!moduleId) return;
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
  let graph = $state<VisGraphData>({ nodes: [], wires: [] });
  let selectedNode = $state<string | null>(null);
  let selectedWire = $state<string | null>(null);
  let svgEl = $state<SVGSVGElement>();
  let previewEl = $state<HTMLCanvasElement>();
  let previewRenderer: ContainerRenderer | null = null;
  let raf = 0;
  // Re-pull guard: our own setVisGraph calls also fire visGraphChanged.
  let applying = false;

  const NODE_W = 132;
  const PORT_GAP = 18;
  const HEAD_H = 24;

  const PORT_COLORS: Record<VisPortType, string> = {
    visual: '#52e0c4',
    control: '#ff3dd0',
    note: '#3dd9ff',
    text: '#b9c0cc',
  };

  const CATEGORIES: { id: VisNodeDef['category']; label: string }[] = [
    { id: 'source', label: 'Sources' },
    { id: 'effect', label: 'Effects' },
    { id: 'combine', label: 'Combine' },
    { id: 'util', label: 'Util' },
  ];

  function defsIn(cat: VisNodeDef['category']): VisNodeDef[] {
    return [...VIS_NODE_DEFS.values()].filter((d) => d.category === cat);
  }

  function pull(): void {
    const mod = moduleId ? appState.graph.modules.get(moduleId) : null;
    const g = mod ? visGraphOf(mod.data) : null;
    // Deep copy so in-progress edits never alias state the renderer reads.
    graph = g ? structuredClone($state.snapshot(g) as VisGraphData) : { nodes: [], wires: [] };
  }

  function apply(undoable = true): void {
    if (!moduleId) return;
    applying = true;
    appState.setVisGraph(moduleId, structuredClone($state.snapshot(graph) as VisGraphData), undoable);
    applying = false;
  }

  onMount(() => {
    const offE = appState.on('visEditorChanged', () => {
      moduleId = appState.visEditorOpen;
      open = moduleId !== null;
      selectedNode = null;
      selectedWire = null;
      pull();
      cancelAnimationFrame(raf);
      previewRenderer = null;
      if (open) {
        if (webgpuAvailable()) void attachPreview(moduleId!);
        raf = requestAnimationFrame(tickPreview);
      }
    });
    // External undo/redo or AI import while open → refresh the working copy.
    const offG = appState.on('visGraphChanged', () => {
      if (open && !applying) pull();
    });
    const offP = appState.on('projectLoaded', () => {
      if (open) pull();
    });
    // Module deleted (trash, undo) while editing → close the panel.
    const offS = appState.on('graphChanged', () => {
      if (open && moduleId && !appState.graph.modules.has(moduleId)) appState.closeVisEditor();
    });
    return () => {
      offE();
      offG();
      offP();
      offS();
      cancelAnimationFrame(raf);
    };
  });

  async function attachPreview(forModule: string): Promise<void> {
    await Promise.resolve();
    if (!open || moduleId !== forModule || !previewEl) return;
    previewRenderer = await ContainerRenderer.create(previewEl);
  }

  function tickPreview(): void {
    if (!open) return;
    raf = requestAnimationFrame(tickPreview);
    reposition();
    if (previewRenderer && moduleId) {
      previewRenderer.render($state.snapshot(graph) as VisGraphData, appState.visFeatures(moduleId));
    }
  }

  function close(): void {
    appState.closeVisEditor();
  }

  // -- geometry ---------------------------------------------------------------

  function def(node: VisNodeInstance): VisNodeDef | undefined {
    return VIS_NODE_DEFS.get(node.type);
  }

  function inPorts(node: VisNodeInstance) {
    return def(node)?.ports.filter((p) => p.direction === 'in') ?? [];
  }

  function outPorts(node: VisNodeInstance) {
    return def(node)?.ports.filter((p) => p.direction === 'out') ?? [];
  }

  function nodeH(node: VisNodeInstance): number {
    return HEAD_H + Math.max(inPorts(node).length, outPorts(node).length, 1) * PORT_GAP + 6;
  }

  function portPos(node: VisNodeInstance, portId: string): { x: number; y: number } {
    const ins = inPorts(node);
    const outs = outPorts(node);
    const inIdx = ins.findIndex((p) => p.id === portId);
    if (inIdx >= 0) return { x: node.x, y: node.y + HEAD_H + inIdx * PORT_GAP + 10 };
    const outIdx = outs.findIndex((p) => p.id === portId);
    return { x: node.x + NODE_W, y: node.y + HEAD_H + outIdx * PORT_GAP + 10 };
  }

  function wirePath(w: VisWire): string {
    const from = graph.nodes.find((n) => n.id === w.from.nodeId);
    const to = graph.nodes.find((n) => n.id === w.to.nodeId);
    if (!from || !to) return '';
    const a = portPos(from, w.from.portId);
    const b = portPos(to, w.to.portId);
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }

  function wireColor(w: VisWire): string {
    const from = graph.nodes.find((n) => n.id === w.from.nodeId);
    const port = from ? def(from)?.ports.find((p) => p.id === w.from.portId) : null;
    return PORT_COLORS[port?.type ?? 'visual'];
  }

  // -- mutations ----------------------------------------------------------------

  function nextNodeId(): string {
    let n = 1;
    while (graph.nodes.some((node) => node.id === `v${n}`)) n++;
    return `v${n}`;
  }

  function nextWireId(): string {
    let n = 1;
    while (graph.wires.some((w) => w.id === `vw${n}`)) n++;
    return `vw${n}`;
  }

  function addNode(d: VisNodeDef): void {
    const params: Record<string, number> = {};
    for (const p of d.params) params[p.id] = p.default;
    const idx = graph.nodes.length;
    graph.nodes.push({
      id: nextNodeId(),
      type: d.type,
      x: 60 + (idx % 5) * 170,
      y: 60 + Math.floor(idx / 5) * 140,
      params,
    });
    selectedNode = graph.nodes[graph.nodes.length - 1].id;
    selectedWire = null;
    apply();
  }

  function removeSelected(): void {
    if (selectedWire) {
      graph.wires = graph.wires.filter((w) => w.id !== selectedWire);
      selectedWire = null;
      apply();
      return;
    }
    if (!selectedNode) return;
    graph.nodes = graph.nodes.filter((n) => n.id !== selectedNode);
    graph.wires = graph.wires.filter(
      (w) => w.from.nodeId !== selectedNode && w.to.nodeId !== selectedNode,
    );
    selectedNode = null;
    apply();
  }

  /** True when adding from→to would close a cycle (path to→…→from exists). */
  function wouldCycle(fromId: string, toId: string): boolean {
    const seen = new Set<string>([toId]);
    const queue = [toId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (id === fromId) return true;
      for (const w of graph.wires) {
        if (w.from.nodeId === id && !seen.has(w.to.nodeId)) {
          seen.add(w.to.nodeId);
          queue.push(w.to.nodeId);
        }
      }
    }
    return false;
  }

  // -- pointer interactions -------------------------------------------------------

  let dragNode: { id: string; offX: number; offY: number } | null = null;
  let dragWire = $state<{ nodeId: string; portId: string; type: VisPortType; x: number; y: number } | null>(null);
  let gestureSnapshotTaken = false;

  function svgPoint(e: PointerEvent): { x: number; y: number } {
    // The panel is CSS-scaled with the canvas zoom — client coords must be
    // divided back into the panel's logical pixel space.
    const rect = svgEl!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / scale,
      y: (e.clientY - rect.top) / scale,
    };
  }

  function onNodeDown(e: PointerEvent, node: VisNodeInstance): void {
    e.stopPropagation();
    selectedNode = node.id;
    selectedWire = null;
    const p = svgPoint(e);
    dragNode = { id: node.id, offX: p.x - node.x, offY: p.y - node.y };
    gestureSnapshotTaken = false;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  function onPortDown(e: PointerEvent, node: VisNodeInstance, portId: string, dir: 'in' | 'out', type: VisPortType): void {
    e.stopPropagation();
    if (dir === 'in') {
      // Dragging from a wired input detaches the wire (re-route gesture).
      const existing = graph.wires.find((w) => w.to.nodeId === node.id && w.to.portId === portId);
      if (existing) {
        graph.wires = graph.wires.filter((w) => w.id !== existing.id);
        const from = graph.nodes.find((n) => n.id === existing.from.nodeId);
        if (from) {
          const p = svgPoint(e);
          dragWire = { nodeId: from.id, portId: existing.from.portId, type, x: p.x, y: p.y };
        }
        apply();
      }
      return;
    }
    const p = svgPoint(e);
    dragWire = { nodeId: node.id, portId, type, x: p.x, y: p.y };
  }

  function onPortUp(node: VisNodeInstance, portId: string, dir: 'in' | 'out', type: VisPortType): void {
    if (!dragWire || dir !== 'in') return;
    if (type !== dragWire.type) return;
    if (node.id === dragWire.nodeId) return;
    if (wouldCycle(dragWire.nodeId, node.id)) return;
    // Inputs are single fan-in: replace any existing wire.
    graph.wires = graph.wires.filter((w) => !(w.to.nodeId === node.id && w.to.portId === portId));
    graph.wires.push({
      id: nextWireId(),
      from: { nodeId: dragWire.nodeId, portId: dragWire.portId },
      to: { nodeId: node.id, portId },
    });
    dragWire = null;
    apply();
  }

  function onSvgMove(e: PointerEvent): void {
    if (dragNode) {
      if (!gestureSnapshotTaken) {
        appState.beginUndoable();
        gestureSnapshotTaken = true;
      }
      const node = graph.nodes.find((n) => n.id === dragNode!.id);
      if (node) {
        const p = svgPoint(e);
        node.x = Math.max(0, p.x - dragNode.offX);
        node.y = Math.max(0, p.y - dragNode.offY);
      }
    } else if (dragWire) {
      const p = svgPoint(e);
      dragWire = { ...dragWire, x: p.x, y: p.y };
    }
  }

  function onSvgUp(): void {
    if (dragNode) {
      dragNode = null;
      // Position already snapshot at gesture start; commit without another.
      apply(false);
    }
    dragWire = null;
  }

  function onSvgDown(): void {
    selectedNode = null;
    selectedWire = null;
  }

  function onKey(e: KeyboardEvent): void {
    if (!open) return;
    const tag = (document.activeElement?.tagName ?? '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (e.key === 'Escape') close();
    if ((e.key === 'Delete' || e.key === 'Backspace') && (selectedNode || selectedWire)) {
      e.preventDefault();
      removeSelected();
    }
  }

  // -- inspector -------------------------------------------------------------------

  let paramGestureActive = false;

  function selected(): VisNodeInstance | null {
    return graph.nodes.find((n) => n.id === selectedNode) ?? null;
  }

  function onParamInput(node: VisNodeInstance, paramId: string, value: number): void {
    if (!paramGestureActive) {
      appState.beginUndoable();
      paramGestureActive = true;
    }
    node.params[paramId] = value;
    apply(false);
  }

  function onParamCommit(): void {
    paramGestureActive = false;
  }

  async function pickImage(node: VisNodeInstance, file: File): Promise<void> {
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    node.data = { ...node.data, src: url, srcName: file.name };
    apply();
  }

  function pickVideo(node: VisNodeInstance, file: File): void {
    // Session-only object URL — videos are too big to embed in saves.
    node.data = { ...node.data, src: URL.createObjectURL(file), srcName: file.name };
    apply();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div
    class="vised"
    style="left:{panelLeft}px;top:{panelTop}px;width:{panelW}px;height:{panelH}px;transform:scale({scale});visibility:{onScreen ? 'visible' : 'hidden'}"
  >
    <div class="vised-bar">
      <span class="vised-title">Visual Graph</span>
      <span class="spacer"></span>
      <button onclick={() => moduleId && appState.openVisualizer(moduleId)} title="Big view">⛶</button>
      <button onclick={close} title="Close (Esc)">✕</button>
    </div>
    <div class="vised-main">
      <div class="palette">
        {#each CATEGORIES as cat (cat.id)}
          <div class="cat">{cat.label}</div>
          {#each defsIn(cat.id) as d (d.type)}
            <button class="add" title={d.description} onclick={() => addNode(d)}>+ {d.name}</button>
          {/each}
        {/each}
      </div>
      <div class="graph-scroll">
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <svg
          bind:this={svgEl}
          width="1600"
          height="900"
          onpointerdown={onSvgDown}
          onpointermove={onSvgMove}
          onpointerup={onSvgUp}
        >
          {#each graph.wires as w (w.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <path
              class="wire"
              class:selected={selectedWire === w.id}
              d={wirePath(w)}
              stroke={wireColor(w)}
              onpointerdown={(e) => {
                e.stopPropagation();
                selectedWire = w.id;
                selectedNode = null;
              }}
            />
          {/each}
          {#if dragWire}
            {@const from = graph.nodes.find((n) => n.id === dragWire!.nodeId)}
            {#if from}
              {@const a = portPos(from, dragWire.portId)}
              <path
                class="wire pending"
                d={`M ${a.x} ${a.y} L ${dragWire.x} ${dragWire.y}`}
                stroke={PORT_COLORS[dragWire.type]}
              />
            {/if}
          {/if}
          {#each graph.nodes as node (node.id)}
            <g class="node" class:selected={selectedNode === node.id} transform={`translate(${node.x}, ${node.y})`}>
              <rect
                class="body"
                width={NODE_W}
                height={nodeH(node)}
                rx="6"
                onpointerdown={(e) => onNodeDown(e, node)}
              />
              <text class="title" x={NODE_W / 2} y="16">{def(node)?.name ?? node.type}</text>
              {#each inPorts(node) as port, i (port.id)}
                <circle
                  class="port"
                  cx="0"
                  cy={HEAD_H + i * PORT_GAP + 10}
                  r="6"
                  fill={PORT_COLORS[port.type]}
                  onpointerdown={(e) => onPortDown(e, node, port.id, 'in', port.type)}
                  onpointerup={() => onPortUp(node, port.id, 'in', port.type)}
                >
                  <title>{port.label} — {port.description}</title>
                </circle>
                <text class="plabel in" x="10" y={HEAD_H + i * PORT_GAP + 13}>{port.label}</text>
              {/each}
              {#each outPorts(node) as port, i (port.id)}
                <circle
                  class="port"
                  cx={NODE_W}
                  cy={HEAD_H + i * PORT_GAP + 10}
                  r="6"
                  fill={PORT_COLORS[port.type]}
                  onpointerdown={(e) => onPortDown(e, node, port.id, 'out', port.type)}
                >
                  <title>{port.label} — {port.description}</title>
                </circle>
                <text class="plabel out" x={NODE_W - 10} y={HEAD_H + i * PORT_GAP + 13}>{port.label}</text>
              {/each}
            </g>
          {/each}
        </svg>
      </div>
      <div class="inspector">
        <canvas class="preview" bind:this={previewEl}></canvas>
        {#if !webgpuAvailable()}
          <div class="hint">Full preview needs a WebGPU browser; the tile shows an approximation.</div>
        {/if}
        {#if selected()}
          {@const node = selected()!}
          {@const d = def(node)}
          <div class="sel-head">
            <span class="sel-name">{d?.name ?? node.type}</span>
            <button class="danger" onclick={removeSelected} title="Delete node (Del)">🗑</button>
          </div>
          <div class="sel-desc">{d?.description}</div>
          {#if node.type === 'image'}
            <label class="file">
              {node.data?.srcName ?? 'Pick image…'}
              <input
                type="file"
                accept="image/*"
                onchange={(e) => {
                  const f = (e.currentTarget as HTMLInputElement).files?.[0];
                  if (f) void pickImage(node, f);
                }}
              />
            </label>
          {/if}
          {#if node.type === 'video'}
            <label class="file">
              {node.data?.srcName ?? 'Pick video…'}
              <input
                type="file"
                accept="video/*"
                onchange={(e) => {
                  const f = (e.currentTarget as HTMLInputElement).files?.[0];
                  if (f) pickVideo(node, f);
                }}
              />
            </label>
          {/if}
          {#each d?.params ?? [] as p (p.id)}
            <div class="param">
              <span class="pname">{p.label}</span>
              {#if p.options}
                <select
                  value={String(Math.round(node.params[p.id] ?? p.default))}
                  onchange={(e) => {
                    appState.beginUndoable();
                    node.params[p.id] = Number((e.currentTarget as HTMLSelectElement).value);
                    apply(false);
                  }}
                >
                  {#each p.options as opt, i (opt)}
                    <option value={String(i)}>{opt}</option>
                  {/each}
                </select>
              {:else}
                <input
                  type="range"
                  min={p.min}
                  max={p.max}
                  step={(p.max - p.min) / 100}
                  value={node.params[p.id] ?? p.default}
                  oninput={(e) => onParamInput(node, p.id, Number((e.currentTarget as HTMLInputElement).value))}
                  onchange={onParamCommit}
                />
                <span class="pval">{(node.params[p.id] ?? p.default).toFixed(2)}</span>
              {/if}
            </div>
          {/each}
        {:else}
          <div class="hint">
            Click a node to edit its params. Drag from an output port to an input port to wire.
            Drag a wired input to re-route. Del removes the selection.
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .vised {
    position: fixed;
    transform-origin: 0 0;
    background: var(--panel, #14141c);
    border: 1px solid var(--panel-border, #2a2a36);
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    z-index: 60;
    overflow: hidden;
  }
  .vised-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: var(--panel, #181820);
    border-bottom: 1px solid var(--panel-border, #2a2a36);
  }
  .vised-title {
    font-weight: 700;
    font-size: 13px;
    color: var(--text, #e8e8ee);
  }
  .spacer {
    flex: 1;
  }
  .vised-main {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .palette {
    width: 130px;
    overflow-y: auto;
    padding: 8px;
    border-right: 1px solid var(--panel-border, #2a2a36);
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .cat {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--text-dim, #8a8a96);
    margin-top: 8px;
  }
  .add {
    text-align: left;
    font-size: 12px;
    padding: 3px 6px;
  }
  .graph-scroll {
    flex: 1;
    overflow: auto;
    background: #0c0c12;
  }
  svg {
    display: block;
  }
  .node .body {
    fill: #1c1c26;
    stroke: #34343f;
    stroke-width: 1;
    cursor: grab;
  }
  .node.selected .body {
    stroke: #52e0c4;
    stroke-width: 1.5;
  }
  .node .title {
    fill: #e8e8ee;
    font-size: 11px;
    font-weight: 700;
    text-anchor: middle;
    pointer-events: none;
  }
  .plabel {
    fill: #8a8a96;
    font-size: 9px;
    pointer-events: none;
  }
  .plabel.out {
    text-anchor: end;
  }
  .port {
    cursor: crosshair;
    stroke: #0c0c12;
    stroke-width: 1.5;
  }
  .wire {
    fill: none;
    stroke-width: 2.5;
    cursor: pointer;
  }
  .wire.selected {
    stroke-width: 4;
    filter: brightness(1.4);
  }
  .wire.pending {
    stroke-dasharray: 5 4;
    pointer-events: none;
  }
  .inspector {
    width: 230px;
    border-left: 1px solid var(--panel-border, #2a2a36);
    padding: 10px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .preview {
    width: 100%;
    height: 120px;
    background: #0c0c12;
    border-radius: 6px;
    flex-shrink: 0;
  }
  .sel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .sel-name {
    font-weight: 700;
    font-size: 13px;
    color: var(--text, #e8e8ee);
  }
  .sel-desc {
    font-size: 11px;
    color: var(--text-dim, #8a8a96);
  }
  .param {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }
  .pname {
    width: 62px;
    flex-shrink: 0;
    color: var(--text, #cfcfda);
  }
  .param input[type='range'] {
    flex: 1;
    min-width: 0;
  }
  .pval {
    width: 34px;
    text-align: right;
    color: var(--text-dim, #8a8a96);
  }
  .param select {
    flex: 1;
  }
  .file {
    display: block;
    font-size: 11px;
    padding: 5px 8px;
    background: #1c1c26;
    border: 1px dashed #34343f;
    border-radius: 6px;
    cursor: pointer;
    color: var(--text, #cfcfda);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file input {
    display: none;
  }
  .hint {
    font-size: 11px;
    color: var(--text-dim, #8a8a96);
    line-height: 1.5;
  }
  .danger {
    color: #ff6a6a;
  }
</style>
