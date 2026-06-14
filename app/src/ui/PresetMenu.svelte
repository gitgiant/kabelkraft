<script lang="ts">
  import { onMount } from 'svelte';
  import { appState } from '../state';
  import { AI_PRESET_LABEL, type PresetTarget } from '../core/preset';
  import type { ModulePreset } from '../core/module';
  import { generatePreset, loadSettings, providerReady } from '../core/aiprovider';
  import { generatePresetSpecPackWithPrompt, parseKkPreset } from '../core/aipreset';

  let open = $state<{ target: PresetTarget; x: number; y: number } | null>(null);
  let presets = $state<ModulePreset[]>([]);
  let activeId = $state<string | undefined>(undefined);
  let dirty = $state(false);
  let mode = $state<'list' | 'saveAs' | 'rename' | 'ai'>('list');
  let nameInput = $state('');
  let catInput = $state('');
  let renameId = $state<string | null>(null);

  // AI generation.
  let aiPrompt = $state('');
  let aiBusy = $state(false);
  let aiStatus = $state('');
  let aiErrors = $state<string[]>([]);
  let aiNeedsConfig = $state(false);
  let aiPasteOpen = $state(false);
  let aiPasteText = $state('');

  function refresh() {
    open = appState.presetMenuOpen;
    if (!open) return;
    presets = appState.presetsOf(open.target);
    activeId = appState.activePreset(open.target)?.id;
    dirty = appState.isPresetDirty(open.target);
  }

  onMount(() => {
    const offs = [
      appState.on('presetMenuChanged', () => {
        mode = 'list';
        refresh();
      }),
      appState.on('presetsChanged', refresh),
    ];
    return () => offs.forEach((o) => o());
  });

  // category → presets, in first-seen order.
  const grouped = $derived.by(() => {
    const map = new Map<string, ModulePreset[]>();
    for (const p of presets) {
      const cat = p.category || 'Default';
      (map.get(cat) ?? map.set(cat, []).get(cat)!).push(p);
    }
    return [...map.entries()];
  });

  const allCategories = $derived([...new Set(presets.map((p) => p.category || 'Default'))]);

  const menuStyle = $derived(
    open
      ? `left:${Math.min(open.x, window.innerWidth - 250)}px;top:${Math.min(open.y, window.innerHeight - 380)}px;`
      : '',
  );

  function close() {
    appState.closePresetMenu();
  }

  function load(id: string) {
    if (!open) return;
    if (id !== activeId && dirty) {
      const name = appState.presetDisplayName(open.target);
      if (!confirm(`Discard unsaved changes to "${name}"?`)) return;
    }
    appState.loadPreset(open.target, id);
    close();
  }

  function save() {
    if (!open) return;
    appState.savePreset(open.target);
    close();
  }

  function startSaveAs() {
    nameInput = '';
    catInput = appState.activePreset(open!.target)?.category ?? 'Default';
    mode = 'saveAs';
  }

  function confirmSaveAs() {
    if (!open || !nameInput.trim()) return;
    appState.savePresetAs(open.target, nameInput, catInput);
    close();
  }

  function startRename(p: ModulePreset) {
    renameId = p.id;
    nameInput = p.name;
    catInput = p.category;
    mode = 'rename';
  }

  function confirmRename() {
    if (!open || !renameId || !nameInput.trim()) return;
    appState.renamePreset(open.target, renameId, nameInput, catInput);
    mode = 'list';
  }

  function dup(id: string) {
    if (open) appState.duplicatePreset(open.target, id);
  }

  function del(id: string) {
    if (open && confirm('Delete this preset?')) appState.deletePreset(open.target, id);
  }

  function revert() {
    if (!open) return;
    appState.revertPreset(open.target);
    close();
  }

  function randomize() {
    if (open) appState.randomizePreset(open.target);
  }

  // -- AI (FaceEditor pattern: generate in-app, or copy spec + paste) --

  function startAi() {
    aiErrors = [];
    aiStatus = '';
    aiNeedsConfig = false;
    aiPasteOpen = false;
    mode = 'ai';
  }

  /** Apply a validated reply as a transient (unsaved) preset, then close. */
  function applyKkPreset(text: string): boolean {
    if (!open) return false;
    const parsed = parseKkPreset(text, appState.graph, open.target);
    aiErrors = parsed.errors;
    aiStatus = parsed.warnings.join(' · ');
    if (!parsed.ok || !parsed.preset) return false;
    const label = parsed.name ? `✨ ${parsed.name}` : AI_PRESET_LABEL;
    appState.applyTransientPreset(
      open.target,
      { id: '', name: parsed.name ?? 'AI Generated', category: parsed.category ?? 'Default', ...parsed.preset },
      label,
    );
    close();
    return true;
  }

  async function aiGenerate() {
    if (!open) return;
    const prompt = aiPrompt.trim();
    if (!prompt || aiBusy) return;
    const settings = loadSettings();
    aiErrors = [];
    if (!providerReady(settings)) {
      aiNeedsConfig = true;
      aiStatus = 'No AI provider configured — set one up, or use 📋 to copy the spec and paste a reply.';
      aiPasteOpen = true;
      return;
    }
    aiBusy = true;
    try {
      const result = await generatePreset(appState.graph, open.target, prompt, settings, 3, (s) => (aiStatus = s));
      if (!applyKkPreset(result.text)) aiStatus = 'Generation failed validation — errors below.';
    } catch (e) {
      aiErrors = [(e as Error).message];
      aiStatus = '';
    } finally {
      aiBusy = false;
    }
  }

  async function copySpec() {
    if (!open) return;
    await navigator.clipboard.writeText(generatePresetSpecPackWithPrompt(appState.graph, open.target, aiPrompt));
    aiPasteOpen = true;
    aiStatus = 'Spec copied — paste the reply below.';
  }

  function aiPasteApply() {
    if (aiPasteText.trim() && applyKkPreset(aiPasteText)) aiPasteText = '';
  }

  function openAiSettings() {
    window.dispatchEvent(new CustomEvent('kk-options', { detail: { tab: 'ai' } }));
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (mode === 'list') close();
      else mode = 'list';
    }
    if (e.key === 'Enter') {
      if (mode === 'saveAs') confirmSaveAs();
      if (mode === 'rename') confirmRename();
    }
  }
</script>

{#if open}
  <div class="preset-backdrop" onpointerdown={close}>
    <div
      class="preset-menu"
      role="dialog"
      aria-label="Presets"
      tabindex="-1"
      style={menuStyle}
      onpointerdown={(e) => e.stopPropagation()}
      onkeydown={onKey}
    >
      {#if mode === 'list'}
        <div class="rows">
          {#each grouped as [cat, list] (cat)}
            <div class="cat">{cat}</div>
            {#each list as p (p.id)}
              <div class="preset-row">
                <button class="pick" class:active={p.id === activeId} onclick={() => load(p.id)}>
                  <span class="check">{p.id === activeId ? (dirty ? '•' : '✓') : ''}</span>
                  {p.name}
                </button>
                <button class="icon" title="Rename" onclick={() => startRename(p)}>✎</button>
                <button class="icon" title="Duplicate" onclick={() => dup(p.id)}>⧉</button>
                <button class="icon" title="Delete" onclick={() => del(p.id)}>🗑</button>
              </div>
            {/each}
          {/each}
          {#if presets.length === 0}
            <div class="empty">No presets yet.</div>
          {/if}
        </div>
        <div class="actions">
          <button onclick={save} disabled={!activeId || !dirty}>Save</button>
          <button onclick={startSaveAs}>Save As…</button>
          <button onclick={revert} disabled={!activeId || !dirty}>Revert</button>
          <button onclick={randomize}>🎲 Randomize</button>
          <button class="wide" onclick={startAi}>✨ Generate with AI</button>
        </div>
      {:else if mode === 'ai'}
        <div class="form">
          <div class="form-title">✨ Generate a preset</div>
          <textarea
            bind:value={aiPrompt}
            rows="3"
            placeholder={open?.target.isGroup ? 'e.g. fat detuned reese bass' : 'e.g. bright plucky lead'}
          ></textarea>
          <div class="actions">
            <button class="primary" onclick={() => void aiGenerate()} disabled={aiBusy || !aiPrompt.trim()}>
              {aiBusy ? '…' : '✨ Generate'}
            </button>
            <button onclick={() => void copySpec()}>📋 Copy spec</button>
            <button onclick={() => (mode = 'list')}>Back</button>
          </div>
          {#if aiNeedsConfig}
            <button class="link" onclick={openAiSettings}>⚙ Configure AI provider</button>
          {/if}
          {#if aiStatus}<div class="status">{aiStatus}</div>{/if}
          {#each aiErrors as err (err)}<div class="err">{err}</div>{/each}
          {#if aiPasteOpen}
            <textarea bind:value={aiPasteText} rows="3" placeholder="Paste the AI reply (JSON) here"></textarea>
            <button class="primary" onclick={aiPasteApply} disabled={!aiPasteText.trim()}>Apply pasted reply</button>
          {/if}
        </div>
      {:else}
        <div class="form">
          <div class="form-title">{mode === 'saveAs' ? 'Save preset as' : 'Rename preset'}</div>
          <label>Name <input bind:value={nameInput} placeholder="Preset name" /></label>
          <label>
            Category
            <input bind:value={catInput} placeholder="Default" list="preset-cats" />
          </label>
          <datalist id="preset-cats">
            {#each allCategories as c (c)}<option value={c}></option>{/each}
          </datalist>
          <div class="actions">
            <button
              class="primary"
              onclick={mode === 'saveAs' ? confirmSaveAs : confirmRename}
              disabled={!nameInput.trim()}
            >
              {mode === 'saveAs' ? 'Save' : 'Rename'}
            </button>
            <button onclick={() => (mode = 'list')}>Cancel</button>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .preset-backdrop {
    position: fixed;
    inset: 0;
    z-index: 70;
  }
  .preset-menu {
    position: fixed;
    width: 230px;
    max-height: 70vh;
    overflow-y: auto;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    padding: 6px;
    font-size: 12px;
    color: var(--text);
  }
  .cat {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    padding: 6px 6px 2px;
  }
  .preset-row {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .pick {
    flex: 1;
    text-align: left;
    padding: 5px 6px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pick:hover {
    background: rgba(255, 255, 255, 0.08);
  }
  .pick.active {
    background: var(--accent);
    color: #1a1a20;
    font-weight: 600;
  }
  .check {
    display: inline-block;
    width: 12px;
  }
  .icon {
    border: none;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
  }
  .icon:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--text);
  }
  .empty {
    padding: 8px;
    color: var(--text-dim);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 4px 4px;
    border-top: 1px solid var(--panel-border);
    margin-top: 6px;
  }
  .actions button {
    flex: 1 1 auto;
    padding: 5px 8px;
  }
  .form {
    padding: 4px;
  }
  .form-title {
    font-weight: 700;
    margin-bottom: 8px;
  }
  .form label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    color: var(--text-dim);
  }
  .form input {
    width: 130px;
  }
  .form textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    margin-bottom: 8px;
    font: inherit;
  }
  .actions .wide {
    flex: 1 1 100%;
  }
  .primary {
    background: var(--accent);
    color: #1a1a20;
    font-weight: 600;
  }
  .link {
    background: transparent;
    border: none;
    color: var(--accent);
    cursor: pointer;
    padding: 4px 0;
    text-align: left;
  }
  .status {
    font-size: 11px;
    color: var(--text-dim);
    margin-top: 6px;
  }
  .err {
    font-size: 11px;
    color: #ff6b6b;
    margin-top: 4px;
  }
</style>
