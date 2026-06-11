<script lang="ts">
  // Shared AI backend settings block (PRD §10.3) — used by the AI Patch
  // dialog and the piano roll's AI MIDI popup. Settings live in localStorage
  // (core/aiprovider), so both entry points configure the same backend.
  import { CLAUDE_MODELS, saveSettings, type AiSettings } from '../core/aiprovider';

  let { settings = $bindable() }: { settings: AiSettings } = $props();

  // Unique radio-group name per panel instance (two dialogs may both mount).
  const groupName = `prov-${Math.random().toString(36).slice(2)}`;

  function persistSettings() {
    saveSettings(settings);
  }
</script>

<div class="settings">
  <div class="settings-row">
    <span class="settings-label">Backend</span>
    <div class="provider-pick">
      <label><input type="radio" name={groupName} value="none" bind:group={settings.provider} onchange={persistSettings} /> Off (copy/paste)</label>
      <label><input type="radio" name={groupName} value="claude" bind:group={settings.provider} onchange={persistSettings} /> Claude</label>
      <label><input type="radio" name={groupName} value="local" bind:group={settings.provider} onchange={persistSettings} /> Local LLM</label>
    </div>
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
  {:else if settings.provider === 'local'}
    <div class="settings-row">
      <span class="settings-label">Base URL</span>
      <input class="grow" type="text" placeholder="http://localhost:11434/v1" bind:value={settings.local.baseUrl} onchange={persistSettings} spellcheck="false" />
    </div>
    <div class="settings-row">
      <span class="settings-label">Model</span>
      <input class="grow" type="text" placeholder="llama3.1" bind:value={settings.local.model} onchange={persistSettings} spellcheck="false" />
    </div>
    <p class="settings-note">Any OpenAI-compatible endpoint (Ollama, LM Studio). The server must allow this page's origin (CORS).</p>
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
  .provider-pick {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
  }
  .provider-pick label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--text);
  }
  .settings .grow {
    flex: 1;
    font-size: 12px;
  }
  .settings-note {
    font-size: 11px;
    color: var(--text-dim);
    margin: 0;
  }
</style>
