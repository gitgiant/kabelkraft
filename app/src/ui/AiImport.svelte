<script lang="ts">
  import { onMount } from 'svelte';
  import { patchCanvas } from '../canvas/PatchCanvas';
  import { buildAiContext, buildGroupContext, withContext } from '../core/aicontext';
import { extractJson } from '../core/aiimport';
  import { generateProjectSpecPack, parseKkProject } from '../core/aiproject';
  import { MODULE_DEFS } from '../core/registry';
  import { generateSpecPack } from '../core/aispec';
  import {
    generatePatch,
    generateProject,
    loadSettings,
    providerLabel,
    providerReady,
    type AiSettings,
  } from '../core/aiprovider';
  import { appState } from '../state';
  import AiSettingsPanel from './AiSettingsPanel.svelte';

  // PRD §10.2: copy the spec pack for an external chatbot, paste its JSON
  // reply (or drop a .kkgroup file), validate readably, insert as a group.
  // PRD §10.3: if a backend (Claude / local LLM) is configured, generate in-app
  // instead — same spec pack, same validator, with an automatic repair loop.

  let open = $state(false);
  // 'patch' = insert a module group; 'project' = replace the whole project;
  // 'group' = edit ONE existing group in place (container 🤖 button) — its
  // full configuration rides along in the prompt context.
  let mode = $state<'patch' | 'project' | 'group'>('patch');
  // Target of a 'group' edit.
  let groupId = $state('');
  let text = $state('');
  let errors = $state<string[]>([]);
  let warnings = $state<string[]>([]);
  let copied = $state(false);
  let imported = $state(false);

  let settings = $state<AiSettings>(loadSettings());
  let showSettings = $state(false);
  let generating = $state(false);
  let genStatus = $state('');

  // A generated + validated patch waiting to be placed (drag onto canvas / Place).
  let readyPatch = $state('');
  let readyName = $state('');
  let placing = $state(false);

  onMount(() => {
    const toggle = (m: 'patch' | 'project' | 'group', target = '') => {
      if (open && mode === m && groupId === target) {
        open = false;
        return;
      }
      mode = m;
      groupId = target;
      open = true;
      errors = [];
      warnings = [];
      imported = false;
      readyPatch = '';
      placing = false;
    };
    const onToggle = () => toggle('patch');
    const onToggleProject = () => toggle('project');
    const onToggleGroup = (e: Event) => toggle('group', (e as CustomEvent<{ groupId: string }>).detail.groupId);
    window.addEventListener('kk-ai-import', onToggle);
    window.addEventListener('kk-ai-project', onToggleProject);
    window.addEventListener('kk-ai-group', onToggleGroup);
    // Drag the ready-patch chip anywhere over the canvas to place it there.
    window.addEventListener('dragover', onWindowDragOver);
    window.addEventListener('drop', onWindowDrop);
    return () => {
      window.removeEventListener('kk-ai-import', onToggle);
      window.removeEventListener('kk-ai-project', onToggleProject);
      window.removeEventListener('kk-ai-group', onToggleGroup);
      window.removeEventListener('dragover', onWindowDragOver);
      window.removeEventListener('drop', onWindowDrop);
    };
  });

  function patchName(t: string): string {
    try {
      return (JSON.parse(extractJson(t)).name as string) || 'AI Patch';
    } catch {
      return 'AI Patch';
    }
  }

  /** Validate + insert at a world point, then pop the new modules in. */
  function insertAt(point: { x: number; y: number }) {
    const result = appState.importAiPatch(readyPatch, point);
    errors = result.errors;
    warnings = result.warnings;
    if (result.ok) {
      patchCanvas.popInImport(result.moduleIds, result.groupId);
      imported = true;
      readyPatch = '';
      text = '';
      setTimeout(() => (open = false), 900);
    }
  }

  function place() {
    if (readyPatch) insertAt(patchCanvas.viewCenter());
  }

  function onChipDragStart(e: DragEvent) {
    placing = true;
    e.dataTransfer?.setData('text/plain', readyName);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
  }

  function onWindowDragOver(e: DragEvent) {
    if (placing) e.preventDefault(); // mark the page as a valid drop surface
  }

  function onWindowDrop(e: DragEvent) {
    if (!placing || !readyPatch) return;
    e.preventDefault();
    const point = patchCanvas.worldFromClient(e.clientX, e.clientY);
    placing = false;
    if (point) insertAt(point); // dropped outside the canvas → keep the chip
  }

  let userPrompt = $state('');

  /** Group edit: swap the target group's contents in place (one undo step). */
  function importGroupEdit(t: string) {
    imported = false;
    const result = appState.replaceAiGroup(groupId, t);
    errors = result.errors;
    warnings = result.warnings;
    if (result.ok) {
      patchCanvas.popInImport(result.moduleIds, result.groupId);
      imported = true;
      text = '';
      setTimeout(() => (open = false), 900);
    }
  }

  /** Project import replaces everything — validate, confirm, import, lay out. */
  function importProject(t: string) {
    imported = false;
    // Validate first so a broken reply shows errors without a confirm prompt.
    const check = parseKkProject(t, MODULE_DEFS);
    if (!check.ok) {
      errors = check.errors;
      warnings = check.warnings;
      return;
    }
    if (
      appState.graph.modules.size > 0 &&
      !confirm('Load the AI project? This replaces the current project (undo restores it).')
    ) {
      return;
    }
    const result = appState.importAiProject(t);
    errors = result.errors;
    warnings = result.warnings;
    if (result.ok) {
      patchCanvas.autoArrange();
      imported = true;
      text = '';
      setTimeout(() => (open = false), 900);
    }
  }

  async function generate() {
    const prompt = userPrompt.trim();
    if (!prompt || generating) return;
    generating = true;
    genStatus = '';
    errors = [];
    warnings = [];
    imported = false;
    readyPatch = '';
    try {
      const gen = mode === 'project' ? generateProject : generatePatch;
      const context =
        mode === 'group'
          ? `${buildAiContext(appState.graph)}\n\n${buildGroupContext(appState.graph, groupId)}`
          : buildAiContext(appState.graph);
      const contextual = withContext(context, prompt);
      const result = await gen(contextual, settings, 3, (s) => (genStatus = s));
      text = result.text;
      if (!result.ok) {
        runImport(); // surface the validation errors (nothing is inserted)
      } else if (mode === 'project') {
        importProject(result.text); // whole project: no chip, load it
      } else if (mode === 'group') {
        importGroupEdit(result.text); // in-place edit: no chip, rebuild it
      } else {
        // Hold it as a draggable chip instead of auto-inserting (PRD §10).
        readyPatch = result.text;
        readyName = patchName(result.text);
      }
    } catch (e) {
      errors = [(e as Error).message];
    } finally {
      generating = false;
      genStatus = '';
    }
  }

  async function copySpec() {
    // Spec + live context + the user's request in one paste-able block.
    const prompt = userPrompt.trim();
    const spec = mode === 'project' ? generateProjectSpecPack() : generateSpecPack();
    const context =
      mode === 'group'
        ? `${buildAiContext(appState.graph)}\n\n${buildGroupContext(appState.graph, groupId)}`
        : buildAiContext(appState.graph);
    const payload = prompt ? `${spec}\n\n${withContext(context, prompt)}` : `${spec}\n\n${context}`;
    await navigator.clipboard.writeText(payload);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  function runImport() {
    if (mode === 'project') {
      importProject(text);
      return;
    }
    if (mode === 'group') {
      importGroupEdit(text);
      return;
    }
    imported = false;
    const result = appState.importAiPatch(text, patchCanvas.viewCenter());
    errors = result.errors;
    warnings = result.warnings;
    if (result.ok) {
      patchCanvas.popInImport(result.moduleIds, result.groupId);
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
  <div class="ai-backdrop" class:placing>
    <div class="ai-dialog" role="dialog" aria-label="Import AI Patch" tabindex="-1" ondragover={(e) => e.preventDefault()} ondrop={onDrop}>
      <div class="ai-header">
        <span class="ai-title">
          {mode === 'project'
            ? 'AI Project'
            : mode === 'group'
              ? `AI Edit — ${appState.graph.groups.get(groupId)?.name ?? 'Group'}`
              : 'AI Patch'}
        </span>
        <span class="provider-tag" title="Active AI backend (configure with Setup)">{providerLabel(settings)}</span>
        <span class="spacer"></span>
        <button class="setup-btn" class:active={showSettings} onclick={() => (showSettings = !showSettings)} title="Configure an AI backend">
          ⚙ Setup
        </button>
        <button onclick={() => (open = false)} title="Close (Esc)">✕</button>
      </div>

      {#if showSettings}
        <AiSettingsPanel bind:settings />
      {/if}

      <p class="ai-help">
        {#if readyPatch}
          Patch ready — <strong>drag it onto the canvas</strong> to place it where you drop, or <strong>Place</strong> it in the center.
        {:else if mode === 'project'}
          {#if providerReady(settings)}
            Describe the whole piece — instruments, style, structure — and click <strong>Generate</strong>.
            The AI writes composers, synths, effects, mixer and output, music included. <strong>Replaces the current project</strong> (undo restores it).
          {:else}
            1. Describe the piece you want, copy, and paste it into any chatbot.<br />
            2. Paste the JSON it answers with below. <strong>Replaces the current project</strong> (undo restores it).
          {/if}
        {:else if mode === 'group'}
          {#if providerReady(settings)}
            Describe the change — sound, wiring, face, inputs — and click <strong>Generate</strong>.
            The AI knows this group's full configuration and <strong>rebuilds it in place</strong> (undo restores it).
          {:else}
            1. Describe the change you want, copy, and paste it into any chatbot — the group's full configuration rides along.<br />
            2. Paste the JSON it answers with below. <strong>Rebuilds the group in place</strong> (undo restores it).
          {/if}
        {:else if providerReady(settings)}
          Describe the sound you want and click <strong>Generate</strong> — it's built and validated, then drag it onto the canvas.
        {:else}
          1. Describe the sound you want, copy, and paste it into any chatbot.<br />
          2. Paste the JSON it answers with below (or drop a .kkgroup file here).
        {/if}
      </p>

      {#if readyPatch}
        <div class="ready">
          <div
            class="patch-chip"
            role="button"
            tabindex="0"
            draggable="true"
            ondragstart={onChipDragStart}
            ondragend={() => (placing = false)}
            title="Drag onto the canvas to drop it there"
          >
            <span class="chip-icon">🎛</span>
            <span class="chip-name">{readyName}</span>
            <span class="chip-hint">drag onto canvas</span>
          </div>
          <button class="place" onclick={place}>Place in center</button>
        </div>
      {/if}

      <div class="prompt-row">
        <input
          class="ai-prompt"
          type="text"
          bind:value={userPrompt}
          placeholder={mode === 'project'
            ? 'e.g. a chill lofi loop: drums, sub bass, e-piano chords, vinyl noise'
            : mode === 'group'
              ? 'e.g. add a chorus before the output and put a mix knob on the face'
              : 'e.g. a warm dub bassline with tape delay'}
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
        placeholder={mode === 'project'
          ? '{ "kind": "kkproject", ... }  — markdown reply with a ```json block works too'
          : '{ "kind": "kkgroup", ... }  — markdown reply with a ```json block works too'}
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
        <div class="messages success">
          {mode === 'project'
            ? '✓ Project loaded — press Play to hear it.'
            : mode === 'group'
              ? "✓ Group rebuilt in place — it's selected on the canvas."
              : "✓ Imported as a module group — it's selected on the canvas."}
        </div>
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
    transition: opacity 0.12s ease;
  }
  /* While dragging the ready chip, get out of the way so the canvas is the drop target. */
  .ai-backdrop.placing {
    opacity: 0;
    pointer-events: none;
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
  .ready {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .patch-chip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 8px;
    background: var(--accent);
    color: #1a1a20;
    font-weight: 600;
    cursor: grab;
    user-select: none;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
  }
  .patch-chip:active {
    cursor: grabbing;
  }
  .chip-icon {
    font-size: 16px;
  }
  .chip-hint {
    font-size: 11px;
    font-weight: 500;
    opacity: 0.75;
  }
  .place {
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
