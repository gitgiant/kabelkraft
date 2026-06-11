<script lang="ts">
  import { MODULE_DEFS } from '../core/registry';
  import { patchCanvas } from '../canvas/PatchCanvas';
  import { appState } from '../state';
  import { STARTERS } from './starters';

  const defs = [...MODULE_DEFS.values()];

  let query = $state('');
  let collapsed = $state(new Set<string>());

  const visible = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return defs;
    return defs.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        d.type.toLowerCase().includes(q) ||
        d.category.toLowerCase().includes(q) ||
        d.description.toLowerCase().includes(q),
    );
  });

  const categories = $derived([...new Set(visible.map((d) => d.category))]);

  function toggleCategory(cat: string) {
    const next = new Set(collapsed);
    if (next.has(cat)) next.delete(cat);
    else next.add(cat);
    collapsed = next;
  }

  function addModule(type: string) {
    const c = patchCanvas.viewCenter();
    const jitter = () => (Math.random() - 0.5) * 80;
    const inst = appState.addModule(type, c.x + jitter(), c.y + jitter());
    // A fresh Composer goes straight into the piano roll.
    if (type === 'composer') appState.openComposer(inst.id);
  }

  function onDragStart(e: DragEvent, type: string) {
    e.dataTransfer?.setData('module-type', type);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
  }

  // -- Drag-to-hide: grip on the right edge slides the palette away ---------

  const FULL_WIDTH = 170;
  let paletteWidth = $state(FULL_WIDTH);
  let dragging = $state(false);
  let dragStartX = 0;
  let dragStartWidth = 0;
  let dragMoved = false;

  function onGripDown(e: PointerEvent) {
    dragging = true;
    dragMoved = false;
    dragStartX = e.clientX;
    dragStartWidth = paletteWidth;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onGripMove(e: PointerEvent) {
    if (!dragging) return;
    const dx = e.clientX - dragStartX;
    if (Math.abs(dx) > 3) dragMoved = true;
    paletteWidth = Math.max(0, Math.min(FULL_WIDTH, dragStartWidth + dx));
  }

  function onGripUp() {
    if (!dragging) return;
    dragging = false;
    if (!dragMoved) paletteWidth = paletteWidth > 0 ? 0 : FULL_WIDTH;
    else paletteWidth = paletteWidth < FULL_WIDTH / 2 ? 0 : FULL_WIDTH;
  }
</script>

<div class="palette-outer">
<div class="palette-clip" class:dragging style="width: {paletteWidth}px">
<div class="palette">
  <div class="palette-title">Modules</div>
  <input
    class="palette-search"
    type="search"
    placeholder="Search…"
    bind:value={query}
    spellcheck="false"
  />

  {#if !query}
    <div class="category starter-category">Starter Modules</div>
    {#each STARTERS as starter}
      <button
        class="module-entry starter-entry"
        title={starter.description}
        onclick={starter.add}
      >
        ★ {starter.name}
      </button>
    {/each}
  {/if}

  {#each categories as cat}
    <button
      class="category category-toggle"
      onclick={() => toggleCategory(cat)}
      title={collapsed.has(cat) ? 'Show' : 'Hide'}
    >
      <span class="cat-arrow">{collapsed.has(cat) ? '▶' : '▼'}</span>
      {cat}
    </button>
    {#if !collapsed.has(cat)}
      {#each visible.filter((d) => d.category === cat) as def}
        <button
          class="module-entry"
          title={def.description}
          draggable={true}
          ondragstart={(e) => onDragStart(e, def.type)}
          onclick={() => addModule(def.type)}
        >
          {def.name}
        </button>
      {/each}
    {/if}
  {/each}
  {#if visible.length === 0}
    <div class="no-match">No modules match "{query}".</div>
  {/if}
</div>
</div>
<button
  class="palette-grip"
  title="Drag or click to hide/show the module palette"
  aria-label="Hide or show module palette"
  onpointerdown={onGripDown}
  onpointermove={onGripMove}
  onpointerup={onGripUp}
  onpointercancel={onGripUp}
>
  {paletteWidth === 0 ? '›' : '‹'}
</button>
</div>

<style>
  .palette-outer {
    display: flex;
    flex-shrink: 0;
    min-height: 0;
  }
  .palette-clip {
    overflow: hidden;
    transition: width 0.15s ease;
  }
  .palette-clip.dragging {
    transition: none;
  }
  .palette {
    width: 170px;
    height: 100%;
    background: var(--panel);
    border-right: 1px solid var(--panel-border);
    padding: 10px;
    overflow-y: auto;
    user-select: none;
  }
  .palette-grip {
    width: 14px;
    padding: 0;
    border: none;
    border-radius: 0;
    border-right: 1px solid var(--panel-border);
    background: var(--panel);
    color: var(--text-dim);
    font-size: 10px;
    cursor: ew-resize;
    touch-action: none;
    user-select: none;
  }
  .palette-grip:hover {
    background: var(--control);
    color: var(--text);
  }
  .palette-title {
    font-weight: 700;
    font-size: 13px;
    color: var(--text);
    margin-bottom: 8px;
  }
  .palette-search {
    width: 100%;
    margin-bottom: 4px;
    font-size: 12px;
  }
  .category {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-dim);
    margin: 10px 0 4px;
  }
  .category-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    width: 100%;
    text-align: left;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-dim);
    margin: 10px 0 4px;
  }
  .category-toggle:hover {
    color: var(--text);
  }
  .cat-arrow {
    font-size: 8px;
    flex-shrink: 0;
  }
  .starter-category {
    color: var(--accent);
    margin-top: 4px;
  }
  .module-entry {
    display: block;
    width: 100%;
    text-align: left;
    margin-bottom: 4px;
    padding: 6px 8px;
    background: var(--control);
    border: 1px solid var(--control-border);
    cursor: grab;
  }
  .module-entry:hover {
    background: var(--panel-border);
    border-color: var(--accent);
  }
  .module-entry:active {
    cursor: grabbing;
  }
  .starter-entry {
    cursor: pointer;
    border-color: var(--accent);
  }
  .no-match {
    font-size: 11px;
    color: var(--text-dim);
    margin-top: 8px;
  }
</style>
