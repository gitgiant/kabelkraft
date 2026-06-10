<script lang="ts">
  import { MODULE_DEFS } from '../core/registry';
  import { patchCanvas } from '../canvas/PatchCanvas';
  import { appState } from '../state';

  const defs = [...MODULE_DEFS.values()];

  let query = $state('');

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

  function addModule(type: string) {
    const c = patchCanvas.viewCenter();
    // Slight scatter so repeated adds don't stack exactly.
    const jitter = () => (Math.random() - 0.5) * 80;
    appState.addModule(type, c.x + jitter(), c.y + jitter());
  }
</script>

<div class="palette">
  <div class="palette-title">Modules</div>
  <input
    class="palette-search"
    type="search"
    placeholder="Search…"
    bind:value={query}
    spellcheck="false"
  />
  {#each categories as cat}
    <div class="category">{cat}</div>
    {#each visible.filter((d) => d.category === cat) as def}
      <button class="module-entry" title={def.description} onclick={() => addModule(def.type)}>
        {def.name}
      </button>
    {/each}
  {/each}
  {#if visible.length === 0}
    <div class="no-match">No modules match “{query}”.</div>
  {/if}
</div>

<style>
  .palette {
    width: 170px;
    background: var(--panel);
    border-right: 1px solid var(--panel-border);
    padding: 10px;
    overflow-y: auto;
    user-select: none;
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
  .module-entry {
    display: block;
    width: 100%;
    text-align: left;
    margin-bottom: 4px;
    padding: 6px 8px;
    background: var(--control);
    border: 1px solid var(--control-border);
  }
  .module-entry:hover {
    background: var(--panel-border);
    border-color: var(--accent);
  }
  .no-match {
    font-size: 11px;
    color: var(--text-dim);
    margin-top: 8px;
  }
</style>
