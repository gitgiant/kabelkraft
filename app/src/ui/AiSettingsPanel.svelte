<script lang="ts">
  // Unified AI backend setup (PRD §10.3) — the single place every AI entry
  // point (AI Patch dialog, AI Project, piano roll MIDI popup) configures its
  // backend. Settings live in localStorage (core/aiprovider), so all entry
  // points share one configuration.
  import { onMount } from 'svelte';
  import {
    CLAUDE_MODELS,
    CUSTOM_PRESETS,
    OPENROUTER_CODE_KEY,
    exchangeOpenRouterCode,
    fetchOpenRouterModels,
    saveSettings,
    startOpenRouterAuth,
    type AiSettings,
    type OpenRouterModel,
  } from '../core/aiprovider';

  let { settings = $bindable() }: { settings: AiSettings } = $props();

  let connecting = $state(false);
  let connectError = $state('');

  // OpenRouter model catalog (loaded once an account/key is present).
  let orModels = $state<OpenRouterModel[]>([]);
  let orModelsLoading = $state(false);
  let orModelsError = $state('');

  function persistSettings() {
    saveSettings(settings);
  }

  async function loadOpenRouterModels() {
    if (settings.provider !== 'openrouter' || !settings.openrouter.apiKey.trim()) {
      orModels = [];
      return;
    }
    orModelsLoading = true;
    orModelsError = '';
    try {
      orModels = await fetchOpenRouterModels(settings.openrouter.apiKey);
    } catch (e) {
      orModelsError = (e as Error).message;
      orModels = [];
    } finally {
      orModelsLoading = false;
    }
  }

  // Match the custom base URL back to a preset so the dropdown tracks manual
  // edits; '' selects the "Custom…" option.
  const presetName = $derived(
    CUSTOM_PRESETS.find((p) => p.baseUrl === settings.custom.baseUrl.trim().replace(/\/$/, ''))
      ?.name ?? '',
  );

  function applyPreset(name: string) {
    const preset = CUSTOM_PRESETS.find((p) => p.name === name);
    if (!preset) return;
    settings.custom.baseUrl = preset.baseUrl;
    settings.custom.model = preset.model;
    persistSettings();
  }

  async function connectOpenRouter() {
    connectError = '';
    if (!(await startOpenRouterAuth())) {
      connectError = 'Popup blocked — allow popups for this site and try again.';
      return;
    }
    connecting = true;
  }

  // The OAuth callback popup drops the one-time code into localStorage; the
  // "storage" event only fires in *other* windows, i.e. exactly here. Gated on
  // `connecting` so only the panel that opened the popup exchanges the code
  // (two panels may be mounted: AI Patch dialog and piano roll).
  async function onStorage(e: StorageEvent) {
    if (!connecting || e.key !== OPENROUTER_CODE_KEY || !e.newValue) return;
    connecting = false;
    localStorage.removeItem(OPENROUTER_CODE_KEY);
    try {
      settings.openrouter.apiKey = await exchangeOpenRouterCode(e.newValue);
      persistSettings();
      void loadOpenRouterModels();
    } catch (err) {
      connectError = (err as Error).message;
    }
  }

  onMount(() => {
    window.addEventListener('storage', onStorage);
    void loadOpenRouterModels();
    return () => window.removeEventListener('storage', onStorage);
  });
</script>

<div class="settings">
  <div class="settings-row">
    <span class="settings-label">Backend</span>
    <select bind:value={settings.provider} onchange={persistSettings}>
      <option value="none">Off — copy/paste with any chatbot</option>
      <option value="claude">Claude (API key)</option>
      <option value="openrouter">OpenRouter (one-click connect)</option>
      <option value="custom">Custom endpoint (Ollama, OpenAI, …)</option>
    </select>
  </div>

  {#if settings.provider === 'claude'}
    <div class="settings-row">
      <span class="settings-label">API key</span>
      <input class="grow" type="password" placeholder="sk-ant-…" bind:value={settings.claude.apiKey} onchange={persistSettings} spellcheck="false" autocomplete="off" />
    </div>
    <div class="settings-row">
      <span class="settings-label">Model</span>
      <select bind:value={settings.claude.model} onchange={persistSettings}>
        {#each CLAUDE_MODELS as m (m)}<option value={m}>{m}</option>{/each}
      </select>
    </div>
    <p class="settings-note">Key is stored in this browser only and sent directly to Anthropic.</p>
  {:else if settings.provider === 'openrouter'}
    <div class="settings-row">
      <span class="settings-label">Account</span>
      {#if settings.openrouter.apiKey}
        <span class="connected">✓ Connected</span>
        <button onclick={() => { settings.openrouter.apiKey = ''; orModels = []; orModelsError = ''; persistSettings(); }}>Disconnect</button>
      {:else}
        <button class="connect" onclick={connectOpenRouter} disabled={connecting}>
          {connecting ? 'Waiting for OpenRouter…' : '🔗 Connect OpenRouter'}
        </button>
      {/if}
    </div>
    {#if !settings.openrouter.apiKey}
      <div class="settings-row">
        <span class="settings-label">…or key</span>
        <input class="grow" type="password" placeholder="sk-or-…" bind:value={settings.openrouter.apiKey} onchange={() => { persistSettings(); void loadOpenRouterModels(); }} spellcheck="false" autocomplete="off" />
      </div>
    {/if}
    <div class="settings-row">
      <span class="settings-label">Model</span>
      {#if orModels.length > 0}
        <select class="grow" bind:value={settings.openrouter.model} onchange={persistSettings}>
          {#if settings.openrouter.model && !orModels.some((m) => m.id === settings.openrouter.model)}
            <option value={settings.openrouter.model}>{settings.openrouter.model} (current)</option>
          {/if}
          {#each orModels as m (m.id)}<option value={m.id}>{m.name}</option>{/each}
        </select>
        <button onclick={loadOpenRouterModels} disabled={orModelsLoading} title="Refresh model list">↻</button>
      {:else}
        <input class="grow" type="text" placeholder="anthropic/claude-sonnet-4.6" bind:value={settings.openrouter.model} onchange={persistSettings} spellcheck="false" />
        {#if settings.openrouter.apiKey}
          <button onclick={loadOpenRouterModels} disabled={orModelsLoading} title="Load available models">
            {orModelsLoading ? '…' : '↻'}
          </button>
        {/if}
      {/if}
    </div>
    {#if orModelsLoading}
      <p class="settings-note">Loading models…</p>
    {:else if orModelsError}
      <p class="settings-note error">Couldn't load models ({orModelsError}) — type a model id above.</p>
    {/if}
    {#if connectError}
      <p class="settings-note error">{connectError}</p>
    {:else}
      <p class="settings-note">One account, every model — Connect opens openrouter.ai to approve, no key to copy. Stored in this browser only.</p>
    {/if}
  {:else if settings.provider === 'custom'}
    <div class="settings-row">
      <span class="settings-label">Preset</span>
      <select value={presetName} onchange={(e) => applyPreset(e.currentTarget.value)}>
        <option value="">Custom…</option>
        {#each CUSTOM_PRESETS as p (p.name)}<option value={p.name}>{p.name}</option>{/each}
      </select>
    </div>
    <div class="settings-row">
      <span class="settings-label">Base URL</span>
      <input class="grow" type="text" placeholder="http://localhost:11434/v1" bind:value={settings.custom.baseUrl} onchange={persistSettings} spellcheck="false" />
    </div>
    <div class="settings-row">
      <span class="settings-label">API key</span>
      <input class="grow" type="password" placeholder="optional — local servers don't need one" bind:value={settings.custom.apiKey} onchange={persistSettings} spellcheck="false" autocomplete="off" />
    </div>
    <div class="settings-row">
      <span class="settings-label">Model</span>
      <input class="grow" type="text" placeholder="llama3.1" bind:value={settings.custom.model} onchange={persistSettings} spellcheck="false" />
    </div>
    <p class="settings-note">Any OpenAI-compatible endpoint. The server must allow this page's origin (CORS).</p>
  {/if}
</div>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--control);
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    padding: 10px 12px;
  }
  .settings-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .settings-label {
    width: 64px;
    flex-shrink: 0;
    font-size: 12px;
    color: var(--text-dim);
  }
  .settings .grow {
    flex: 1;
    font-size: 12px;
  }
  .connect {
    font-weight: 600;
  }
  .connected {
    font-size: 12px;
    color: #52e07a;
  }
  .settings-note {
    font-size: 11px;
    color: var(--text-dim);
    margin: 0;
  }
  .settings-note.error {
    color: #ff8080;
  }
</style>
