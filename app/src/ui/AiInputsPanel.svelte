<script lang="ts">
  // Per-flavor AI input configuration. Each generation flavor (patch, MIDI,
  // lyrics, …) feeds the model some optional context around the user's prompt;
  // here the user chooses what each flavor includes. Required context (a spec,
  // a face/preset target's modules) is never listed — it always rides.
  import { AI_FLAVORS, aiInputEnabled, setAiInputEnabled, type AiFlavorId } from '../core/aiflavors';

  // Local reactive mirror of the stored prefs, seeded from effective values.
  function snapshot(): Record<string, Record<string, boolean>> {
    const o: Record<string, Record<string, boolean>> = {};
    for (const f of AI_FLAVORS) {
      o[f.id] = {};
      for (const i of f.inputs) o[f.id][i.id] = aiInputEnabled(f.id, i.id);
    }
    return o;
  }
  let on = $state(snapshot());

  function toggle(flavor: AiFlavorId, input: string, value: boolean) {
    setAiInputEnabled(flavor, input, value);
    on[flavor][input] = value;
  }
</script>

<div class="ai-inputs">
  {#each AI_FLAVORS as f (f.id)}
    <section class="flavor">
      <div class="flavor-head">
        <span class="flavor-name">{f.name}</span>
        <span class="flavor-desc">{f.description}</span>
      </div>
      {#if f.inputs.length === 0}
        <p class="no-inputs">No optional inputs — only its spec and required live context are sent.</p>
      {:else}
        {#each f.inputs as inp (inp.id)}
          <label class="input-row" title={inp.description}>
            <input
              type="checkbox"
              checked={on[f.id][inp.id]}
              onchange={(e) => toggle(f.id, inp.id, e.currentTarget.checked)}
            />
            <span class="input-label">{inp.label}</span>
            <span class="input-desc">{inp.description}</span>
          </label>
        {/each}
      {/if}
    </section>
  {/each}
</div>

<style>
  .ai-inputs {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .flavor {
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    padding: 8px 10px;
    background: var(--control);
  }
  .flavor-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 6px;
  }
  .flavor-name {
    font-weight: 600;
    font-size: 13px;
  }
  .flavor-desc {
    font-size: 11px;
    color: var(--text-dim);
  }
  .no-inputs {
    margin: 0;
    font-size: 11px;
    color: var(--text-dim);
    font-style: italic;
  }
  .input-row {
    display: grid;
    grid-template-columns: auto auto 1fr;
    align-items: baseline;
    gap: 6px;
    padding: 2px 0;
    cursor: pointer;
  }
  .input-label {
    font-size: 12px;
  }
  .input-desc {
    font-size: 11px;
    color: var(--text-dim);
  }
</style>
