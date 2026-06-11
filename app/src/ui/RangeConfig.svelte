<script lang="ts">
  import { onMount } from 'svelte';
  import { appState } from '../state';

  let open = $state<string | null>(null);
  let min = $state(0);
  let max = $state(1);
  let def = $state(0.5);
  let name = $state('');

  function load() {
    open = appState.rangeConfigOpen;
    if (!open) return;
    const mod = appState.graph.modules.get(open);
    if (!mod) {
      open = null;
      return;
    }
    name = mod.label ?? (mod.type === 'knob' ? 'Knob' : 'Slider');
    const cfg = (mod.data?.cfg ?? {}) as Record<string, number>;
    min = Number.isFinite(cfg.min) ? cfg.min : 0;
    max = Number.isFinite(cfg.max) ? cfg.max : 1;
    def = Number.isFinite(cfg.def) ? cfg.def : min + 0.5 * (max - min);
  }

  onMount(() => appState.on('rangeConfigChanged', load));

  function save() {
    if (!open) return;
    if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) return;
    const d = Number.isFinite(def) ? Math.min(Math.max(def, Math.min(min, max)), Math.max(min, max)) : min;
    appState.beginUndoable();
    appState.setModuleData(open, 'cfg', { min, max, def: d });
    // Re-set the value param so 'paramChanged' fires and the face redraws.
    const mod = appState.graph.modules.get(open);
    appState.setParam(open, 'value', mod?.params.value ?? 0);
    appState.closeRangeConfig();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') appState.closeRangeConfig();
    if (e.key === 'Enter') save();
  }
</script>

{#if open}
  <div class="range-backdrop" onpointerdown={() => appState.closeRangeConfig()}>
    <div
      class="range-config"
      role="dialog"
      aria-label="Control range"
      tabindex="-1"
      onpointerdown={(e) => e.stopPropagation()}
      onkeydown={onKey}
    >
      <div class="title">{name} range</div>
      <p class="hint">Display range only — the Control output always stays 0–1.</p>
      <label>Min <input type="number" step="any" bind:value={min} /></label>
      <label>Max <input type="number" step="any" bind:value={max} /></label>
      <label>Default <input type="number" step="any" bind:value={def} /></label>
      <div class="actions">
        <button class="primary" onclick={save} disabled={max === min}>Apply</button>
        <button onclick={() => appState.closeRangeConfig()}>Cancel</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .range-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 60;
  }
  .range-config {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    padding: 16px 20px;
    width: 240px;
  }
  .title {
    font-weight: 700;
    margin-bottom: 4px;
  }
  .hint {
    margin: 0 0 12px;
    font-size: 11px;
    color: var(--text-dim);
  }
  label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 8px;
  }
  input {
    width: 110px;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 12px;
  }
  .primary {
    background: var(--accent);
    color: #1a1a20;
    font-weight: 600;
  }
</style>
