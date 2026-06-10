<script lang="ts">
  import { MODULE_DEFS } from '../core/registry';
  import { patchCanvas } from '../canvas/PatchCanvas';
  import { appState } from '../state';

  const defs = [...MODULE_DEFS.values()];
  const categories = [...new Set(defs.map((d) => d.category))];

  function addModule(type: string) {
    const c = patchCanvas.viewCenter();
    // Slight scatter so repeated adds don't stack exactly.
    const jitter = () => (Math.random() - 0.5) * 80;
    appState.addModule(type, c.x + jitter(), c.y + jitter());
  }
</script>

<div class="palette">
  <div class="palette-title">Modules</div>
  {#each categories as cat}
    <div class="category">{cat}</div>
    {#each defs.filter((d) => d.category === cat) as def}
      <button class="module-entry" title={def.description} onclick={() => addModule(def.type)}>
        {def.name}
      </button>
    {/each}
  {/each}
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
</style>
