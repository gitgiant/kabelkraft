<script lang="ts">
  import { onMount } from 'svelte';
  import { appState } from '../state';
  import {
    generateLyricsSpecPack,
    parseKkLyrics,
    type LyricsLine,
    type LyricsSongContext,
  } from '../core/ailyrics';
  import { aiInputEnabled } from '../core/aiflavors';
  import { clipFromData } from '../core/composer';
  import {
    generateLyricsClip,
    loadSettings,
    providerLabel,
    providerReady,
    type AiSettings,
  } from '../core/aiprovider';

  let open = $state<string | null>(null);
  /** Editable rows mirroring the module's timed sheet. */
  let rows = $state<{ start: number; text: string }[]>([]);
  let songName = $state('');

  // -- AI (mirrors the AI MIDI popup; shares the backend) ---------------------
  let aiOpen = $state(false);
  let aiText = $state('');
  let aiPrompt = $state('');
  let aiErrors = $state<string[]>([]);
  let aiWarnings = $state<string[]>([]);
  let aiSettings = $state<AiSettings>(loadSettings());
  let aiGenerating = $state(false);
  let aiGenStatus = $state('');
  let aiCopied = $state(false);
  let aiReplace = $state(true);
  let aiSuccess = $state('');

  /** Longest composer clip length in beats (the dominant loop), 0 if none. */
  function longestClipBeats(): number {
    let max = 0;
    for (const m of appState.graph.modules.values()) {
      if (m.type === 'composer') max = Math.max(max, clipFromData(m.data).length);
    }
    return max;
  }

  /**
   * Song context for generation, gated by AI-input prefs. There is no hard song
   * length in the app, so the target = longest clip × 4 (fallback 32 bars).
   */
  function songCtx(): LyricsSongContext | undefined {
    const wantCtx = aiInputEnabled('lyrics', 'songContext');
    const wantLen = aiInputEnabled('lyrics', 'songLength');
    if (!wantCtx && !wantLen) return undefined;
    const base: LyricsSongContext = {
      tempo: appState.transport.tempo,
      timeSignature: appState.transport.timeSignature,
    };
    if (!wantLen) return base;
    const loop = longestClipBeats();
    const songLengthBeats = loop > 0 ? loop * 4 : appState.transport.timeSignature.num * 32;
    return { ...base, songLengthBeats, ...(loop > 0 ? { loopBeats: loop } : {}) };
  }

  function load() {
    open = appState.lyricsEditorOpen;
    if (!open) return;
    const mod = appState.graph.modules.get(open);
    if (!mod) {
      open = null;
      return;
    }
    const lines = (mod.data?.lines as LyricsLine[] | undefined) ?? [];
    rows = lines.map((l) => ({ start: l.start, text: l.text }));
    songName = (mod.data?.name as string | undefined) ?? '';
    aiSettings = loadSettings();
    aiErrors = [];
    aiWarnings = [];
    aiSuccess = '';
  }

  function loadAndOpenAi() {
    if (appState.lyricsAiRequest && appState.lyricsAiRequest === appState.lyricsEditorOpen) {
      load();
      aiOpen = true;
      appState.lyricsAiRequest = null;
    }
  }

  onMount(() => {
    const offOpen = appState.on('lyricsChanged', load);
    const offAi = appState.on('lyricsAiRequest', loadAndOpenAi);
    return () => {
      offOpen();
      offAi();
    };
  });

  function close() {
    aiOpen = false;
    appState.closeLyrics();
  }

  // -- manual editing ---------------------------------------------------------

  function addRow() {
    const last = rows.length ? rows[rows.length - 1].start : 0;
    rows = [...rows, { start: last + 4, text: '' }];
  }

  function removeRow(i: number) {
    rows = rows.filter((_, j) => j !== i);
  }

  /** Commit the table back to the module — sorted, blank lines dropped. */
  function saveRows() {
    if (!open) return;
    const lines: LyricsLine[] = rows
      .filter((r) => r.text.trim() && Number.isFinite(Number(r.start)))
      .map((r) => ({ start: Math.max(0, Number(r.start)), text: r.text.trim() }))
      .sort((a, b) => a.start - b.start);
    appState.setLyricsClip(open, lines, songName.trim() || undefined);
    close();
  }

  // -- AI flow ----------------------------------------------------------------

  async function aiCopySpec() {
    await navigator.clipboard.writeText(generateLyricsSpecPack(aiPrompt, songCtx()));
    aiCopied = true;
    setTimeout(() => (aiCopied = false), 2000);
  }

  function applyClip(lines: LyricsLine[], name?: string) {
    if (aiReplace) {
      rows = lines.map((l) => ({ start: l.start, text: l.text }));
    } else {
      rows = [...rows, ...lines.map((l) => ({ start: l.start, text: l.text }))].sort(
        (a, b) => a.start - b.start,
      );
    }
    if (name) songName = name;
    aiSuccess = `✓ ${lines.length} lines${name ? ` — “${name}”` : ''}.`;
    aiText = '';
    setTimeout(() => {
      aiOpen = false;
      aiSuccess = '';
    }, 900);
  }

  function aiImport() {
    const r = parseKkLyrics(aiText);
    aiErrors = r.errors;
    aiWarnings = r.warnings;
    if (r.ok && r.clip) applyClip(r.clip.lines, r.name);
  }

  async function aiGenerate() {
    const prompt = aiPrompt.trim();
    if (!prompt || aiGenerating) return;
    aiGenerating = true;
    aiGenStatus = '';
    aiErrors = [];
    aiWarnings = [];
    aiSuccess = '';
    try {
      const result = await generateLyricsClip(prompt, songCtx(), aiSettings, 3, (s) => (aiGenStatus = s));
      aiText = result.text;
      const parsed = parseKkLyrics(result.text);
      aiErrors = parsed.errors;
      aiWarnings = parsed.warnings;
      if (parsed.ok && parsed.clip) applyClip(parsed.clip.lines, parsed.name);
    } catch (e) {
      aiErrors = [(e as Error).message];
    } finally {
      aiGenerating = false;
      aiGenStatus = '';
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (aiOpen) aiOpen = false;
      else close();
    }
  }
</script>

{#if open}
  <div class="ly-backdrop" onpointerdown={close}>
    <div
      class="ly-editor"
      role="dialog"
      aria-label="Lyrics editor"
      tabindex="-1"
      onpointerdown={(e) => e.stopPropagation()}
      onkeydown={onKey}
    >
      <div class="ly-head">
        <span class="ly-title">Lyrics</span>
        <input class="ly-name" type="text" placeholder="Song name" bind:value={songName} spellcheck="false" />
        <span class="spacer"></span>
        <button class="ai-btn" onclick={() => (aiOpen = true)} title="Generate timed lyrics with AI">✨ AI Lyrics</button>
        <button onclick={close} title="Close (Esc)">✕</button>
      </div>

      <p class="ly-hint">
        Times are in <strong>beats</strong> from song start ({appState.transport.timeSignature.num} per bar).
        Each line shows on the Text out as the transport reaches it.
      </p>

      <div class="ly-table">
        <div class="ly-row ly-header">
          <span>Beat</span><span>Line</span><span></span>
        </div>
        {#each rows as row, i (i)}
          <div class="ly-row">
            <input class="ly-beat" type="number" step="any" min="0" bind:value={row.start} />
            <input class="ly-text" type="text" bind:value={row.text} spellcheck="false" placeholder="lyric line" />
            <button class="ly-del" onclick={() => removeRow(i)} title="Delete line">✕</button>
          </div>
        {/each}
        {#if rows.length === 0}
          <p class="ly-empty">No lines yet — add one or generate with AI.</p>
        {/if}
      </div>

      <div class="ly-actions">
        <button onclick={addRow}>+ Add line</button>
        <span class="spacer"></span>
        <button class="primary" onclick={saveRows}>Save</button>
        <button onclick={close}>Cancel</button>
      </div>

      {#if aiOpen}
        <div class="popup-backdrop">
          <div class="popup ai-lyrics" role="dialog" aria-label="AI Lyrics">
            <div class="popup-title ai-title-row">
              <span>AI Lyrics</span>
              <span class="provider-tag" title="Active AI backend (configure in Options)">{providerLabel(aiSettings)}</span>
              <span class="spacer"></span>
              <button onclick={() => window.dispatchEvent(new CustomEvent('kk-options', { detail: { tab: 'ai' } }))} title="Configure an AI backend">⚙ Setup</button>
              <button onclick={() => (aiOpen = false)} title="Close (Esc)">✕</button>
            </div>

            <p class="ai-help">
              {#if providerReady(aiSettings)}
                Describe the song and click <strong>Generate</strong> — lines are timed in beats and land in the sheet.
              {:else}
                1. Describe the song, copy, and paste into any chatbot.<br />
                2. Paste the JSON it answers with below and hit Import.
              {/if}
            </p>

            <div class="ai-prompt-row">
              <input
                type="text"
                bind:value={aiPrompt}
                placeholder="e.g. an upbeat 3-verse pop song about summer, chorus repeats"
                spellcheck="false"
                onkeydown={(e) => { if (e.key === 'Enter' && providerReady(aiSettings)) aiGenerate(); }}
              />
              {#if providerReady(aiSettings)}
                <button class="primary" onclick={aiGenerate} disabled={aiGenerating || aiPrompt.trim().length === 0}>
                  {aiGenerating ? '… ' + aiGenStatus : '✨ Generate'}
                </button>
              {:else}
                <button onclick={aiCopySpec} title="Copies the lyrics spec (with song BPM + time signature) followed by USER PROMPT">
                  {aiCopied ? '✓ Copied!' : '📋 Copy Spec + Prompt'}
                </button>
              {/if}
            </div>

            <label class="ai-replace">
              <input type="checkbox" bind:checked={aiReplace} />
              Replace existing lines (uncheck to append)
            </label>

            <textarea
              bind:value={aiText}
              placeholder={'{ "kind": "kklyrics", "lines": [ { "start": 0, "text": "…" } ] }  — markdown reply with a ```json block works too'}
              spellcheck="false"
            ></textarea>

            {#if aiErrors.length > 0}
              <div class="ai-messages ai-errors">{#each aiErrors as e (e)}<div>✗ {e}</div>{/each}</div>
            {/if}
            {#if aiWarnings.length > 0}
              <div class="ai-messages ai-warnings">{#each aiWarnings as w (w)}<div>⚠ {w}</div>{/each}</div>
            {/if}
            {#if aiSuccess}
              <div class="ai-messages ai-success">{aiSuccess}</div>
            {/if}

            <div class="ai-foot">
              <button onclick={aiImport} disabled={!aiText.trim()}>Import JSON</button>
              <button onclick={() => (aiOpen = false)}>Done</button>
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .ly-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 60;
  }
  .ly-editor {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    padding: 14px 16px;
    width: 540px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
  }
  .ly-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .ly-title {
    font-weight: 700;
  }
  .ly-name {
    flex: 0 1 200px;
  }
  .spacer {
    flex: 1;
  }
  .ly-hint {
    margin: 0 0 10px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .ly-table {
    overflow-y: auto;
    flex: 1;
    min-height: 80px;
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    padding: 6px;
  }
  .ly-row {
    display: grid;
    grid-template-columns: 70px 1fr 24px;
    gap: 6px;
    align-items: center;
    margin-bottom: 4px;
  }
  .ly-header {
    font-size: 11px;
    color: var(--text-dim);
    margin-bottom: 6px;
  }
  .ly-beat {
    width: 100%;
  }
  .ly-text {
    width: 100%;
  }
  .ly-del {
    padding: 2px 4px;
    font-size: 11px;
  }
  .ly-empty {
    font-size: 12px;
    color: var(--text-dim);
    text-align: center;
    padding: 16px 0;
  }
  .ly-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 12px;
  }
  .primary {
    background: var(--accent);
    color: #1a1a20;
    font-weight: 600;
  }
  .ai-btn {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  /* AI popup (over the editor) */
  .popup-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 70;
  }
  .popup.ai-lyrics {
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    padding: 14px 16px;
    width: 520px;
  }
  .ai-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 700;
    margin-bottom: 8px;
  }
  .provider-tag {
    font-size: 10px;
    font-weight: 400;
    color: var(--text-dim);
    border: 1px solid var(--panel-border);
    border-radius: 4px;
    padding: 1px 6px;
  }
  .ai-help {
    margin: 0 0 10px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .ai-prompt-row {
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
  }
  .ai-prompt-row input {
    flex: 1;
  }
  .ai-replace {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-dim);
    margin-bottom: 8px;
  }
  textarea {
    width: 100%;
    min-height: 120px;
    resize: vertical;
    font-family: var(--mono, monospace);
    font-size: 12px;
  }
  .ai-messages {
    margin-top: 8px;
    font-size: 11px;
    max-height: 120px;
    overflow-y: auto;
  }
  .ai-errors {
    color: #ff8080;
  }
  .ai-warnings {
    color: #e0c060;
  }
  .ai-success {
    color: #80e0a0;
  }
  .ai-foot {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 10px;
  }
</style>
