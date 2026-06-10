<script lang="ts">
  import { onMount } from 'svelte';
  import { patchCanvas } from '../canvas/PatchCanvas';
  import { generateSpecPack } from '../core/aispec';
  import { appState } from '../state';

  // PRD §10.2: copy the spec pack for an external chatbot, paste its JSON
  // reply (or drop a .kkgroup file), validate readably, insert as a group.

  let open = $state(false);
  let text = $state('');
  let errors = $state<string[]>([]);
  let warnings = $state<string[]>([]);
  let copied = $state(false);
  let imported = $state(false);

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
        <span class="ai-title">Import AI Patch</span>
        <span class="spacer"></span>
        <button onclick={() => (open = false)} title="Close (Esc)">✕</button>
      </div>

      <p class="ai-help">
        1. Describe the sound you want, copy, and paste it into any chatbot.<br />
        2. Paste the JSON it answers with below (or drop a .kkgroup file here).
      </p>

      <div class="prompt-row">
        <input
          class="ai-prompt"
          type="text"
          bind:value={userPrompt}
          placeholder="e.g. a warm dub bassline with tape delay"
          spellcheck="false"
        />
        <button class="copy-spec" onclick={copySpec} title="Copies the AI spec followed by USER PROMPT: your text">
          {copied ? '✓ Copied!' : '📋 Copy Spec + Prompt'}
        </button>
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
