<script lang="ts">
  import { onMount } from 'svelte';
  import { patchCanvas } from '../canvas/PatchCanvas';
  import { generateSpecPack } from '../core/aispec';
  import {
    CLAUDE_MODELS,
    generatePatch,
    loadSettings,
    providerLabel,
    providerReady,
    saveSettings,
    type AiSettings,
  } from '../core/aiprovider';
  import { appState } from '../state';

  // PRD §10.2: copy the spec pack for an external chatbot, paste its JSON
  // reply (or drop a .kkgroup file), validate readably, insert as a group.
  // PRD §10.3: if a backend (Claude / local LLM) is configured, generate in-app
  // instead — same spec pack, same validator, with an automatic repair loop.

  let open = $state(false);
  let text = $state('');
  let errors = $state<string[]>([]);
  let warnings = $state<string[]>([]);
  let copied = $state(false);
  let imported = $state(false);

  let settings = $state<AiSettings>(loadSettings());
  let showSettings = $state(false);
  let generating = $state(false);
  let genStatus = $state('');

  onMount(() => {
    const onToggle = () => {
      open = !open;
      errors = [];
      warnings = [];
      imported = false;
    };
    window.addEventListener('kk-ai-import', onToggle);
    return () => window.removeEventListener('kk-ai-import', onToggle);
  });

  let userPrompt = $state('');

  function persistSettings() {
    saveSettings(settings);
  }

  async function generate() {
    const prompt = userPrompt.trim();
    if (!prompt || generating) return;
    generating = true;
    genStatus = '';
    errors = [];
    warnings = [];
    imported = false;
    try {
      const result = await generatePatch(prompt, settings, 3, (s) => (genStatus = s));
      text = result.text;
      runImport(); // validate + insert (or surface errors) via the shared path
    } catch (e) {
      errors = [(e as Error).message];
    } finally {
      generating = false;
      genStatus = '';
    }
  }

  async function copySpec() {
    // Spec + the user's request in one paste-able block.
    const prompt = userPrompt.trim();
    const payload = prompt ? `${generateSpecPack()}\n\nUSER PROMPT: ${prompt}` : generateSpecPack();
    await navigator.clipboard.writeText(payload);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  function runImport() {
    imported = false;
    const result = appState.importAiPatch(text, patchCanvas.viewCenter());
    errors = result.errors;
    warnings = result.warnings;
    if (result.ok) {
      imported = true;
      text = '';
      setTimeout(() => {
        open = false;
      }, 900);
    }
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) text = await file.text();
  }

  function onKey(e: KeyboardEvent) {
    if (open && e.key === 'Escape') open = false;
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div class="ai-backdrop">
    <div class="ai-dialog" role="dialog" aria-label="Import AI Patch" tabindex="-1" ondragover={(e) => e.preventDefault()} ondrop={onDrop}>
      <div class="ai-header">
        <span class="ai-title">AI Patch</span>
        <span class="provider-tag" title="Active AI backend (configure with Setup)">{providerLabel(settings)}</span>
        <span class="spacer"></span>
        <button class="setup-btn" class:active={showSettings} onclick={() => (showSettings = !showSettings)} title="Configure an AI backend">
          ⚙ Setup
        </button>
        <button onclick={() => (open = false)} title="Close (Esc)">✕</button>
      </div>

      {#if showSettings}
        <div class="settings">
          <div class="settings-row">
            <span class="settings-label">Backend</span>
            <div class="provider-pick">
              <label><input type="radio" name="prov" value="none" bind:group={settings.provider} onchange={persistSettings} /> Off (copy/paste)</label>
              <label><input type="radio" name="prov" value="claude" bind:group={settings.provider} onchange={persistSettings} /> Claude</label>
              <label><input type="radio" name="prov" value="local" bind:group={settings.provider} onchange={persistSettings} /> Local LLM</label>
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
                {#each CLAUDE_MODELS as m}<option value={m}>{m}</option>{/each}
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
      {/if}

      <p class="ai-help">
        {#if providerReady(settings)}
          Describe the sound you want and click <strong>Generate</strong> — it's built, validated, and inserted in one step.
        {:else}
          1. Describe the sound you want, copy, and paste it into any chatbot.<br />
          2. Paste the JSON it answers with below (or drop a .kkgroup file here).
        {/if}
      </p>

      <div class="prompt-row">
        <input
          class="ai-prompt"
          type="text"
          bind:value={userPrompt}
          placeholder="e.g. a warm dub bassline with tape delay"
          spellcheck="false"
          onkeydown={(e) => { if (e.key === 'Enter' && providerReady(settings)) generate(); }}
        />
        {#if providerReady(settings)}
          <button class="generate" onclick={generate} disabled={generating || userPrompt.trim().length === 0} title="Generate, validate, and insert in one step">
            {generating ? '… ' + genStatus : '✨ Generate'}
          </button>
        {:else}
          <button class="copy-spec" onclick={copySpec} title="Copies the AI spec followed by USER PROMPT: your text">
            {copied ? '✓ Copied!' : '📋 Copy Spec + Prompt'}
          </button>
        {/if}
      </div>

      <textarea
        bind:value={text}
        placeholder={'{ "kind": "kkgroup", ... }  — markdown reply with a ```json block works too'}
        spellcheck="false"
      ></textarea>

      {#if errors.length > 0}
        <div class="messages errors">
          {#each errors as e}<div>✗ {e}</div>{/each}
        </div>
      {/if}
      {#if warnings.length > 0}
        <div class="messages warnings">
          {#each warnings as w}<div>⚠ {w}</div>{/each}
        </div>
      {/if}
      {#if imported}
        <div class="messages success">✓ Imported as a module group — it's selected on the canvas.</div>
      {/if}

      <div class="ai-actions">
        <button class="import" onclick={runImport} disabled={text.trim().length === 0}>Import</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .ai-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 65;
  }
  .ai-dialog {
    width: 640px;
    max-width: 92vw;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .ai-header {
    display: flex;
    align-items: center;
  }
  .ai-title {
    font-weight: 700;
    font-size: 14px;
    color: var(--text);
  }
  .spacer {
    flex: 1;
  }
  .ai-help {
    font-size: 12px;
    color: var(--text-dim);
    margin: 0;
    line-height: 1.9;
  }
  .copy-spec {
    font-weight: 600;
    white-space: nowrap;
  }
  .provider-tag {
    font-size: 11px;
    color: var(--text-dim);
    border: 1px solid var(--panel-border);
    border-radius: 5px;
    padding: 1px 6px;
    margin-left: 8px;
  }
  .setup-btn.active {
    outline: 1px solid var(--accent);
  }
  .generate {
    background: var(--accent);
    color: #1a1a20;
    font-weight: 600;
    white-space: nowrap;
  }
  .generate:disabled {
    opacity: 0.5;
  }
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
  .prompt-row {
    display: flex;
    gap: 8px;
  }
  .ai-prompt {
    flex: 1;
    font-size: 12px;
  }
  textarea {
    min-height: 180px;
    resize: vertical;
    font-family: ui-monospace, monospace;
    font-size: 11px;
  }
  .messages {
    font-size: 12px;
    border-radius: 6px;
    padding: 8px 10px;
    max-height: 120px;
    overflow-y: auto;
  }
  .errors {
    background: rgba(255, 80, 80, 0.12);
    color: #ff8080;
  }
  .warnings {
    background: rgba(255, 177, 61, 0.1);
    color: var(--accent);
  }
  .success {
    background: rgba(82, 224, 122, 0.12);
    color: #52e07a;
  }
  .ai-actions {
    display: flex;
    justify-content: flex-end;
  }
  .import {
    background: var(--accent);
    color: #1a1a20;
    font-weight: 600;
    padding: 6px 18px;
  }
  .import:disabled {
    opacity: 0.4;
  }
</style>
