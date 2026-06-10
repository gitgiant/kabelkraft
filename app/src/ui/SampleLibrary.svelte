<script lang="ts">
  import { onMount } from 'svelte';
  import { patchCanvas } from '../canvas/PatchCanvas';
  import {
    deleteDirHandle,
    entryFile,
    isAudioFile,
    loadDirHandles,
    loadFavorites,
    pickDirectory,
    saveDirHandle,
    saveFavorites,
    scanDirectory,
    supportsFolders,
    type DirHandle,
    type LibraryEntry,
  } from '../core/library';
  import { appState } from '../state';

  // PRD §8.2 Sample Library: user's own folders, audition, favorites, search,
  // drag onto a Sampler or Drum Machine pad. Side panel (user decision
  // 2026-06-09; deviates from the PRD's module wording for drag UX).

  interface FolderState {
    name: string;
    handle: DirHandle;
    granted: boolean;
    count: number;
  }

  let open = $state(false);
  let search = $state('');
  let favsOnly = $state(false);
  let folders = $state<FolderState[]>([]);
  let entries = $state<LibraryEntry[]>([]);
  let favs = $state(loadFavorites());
  let auditioning = $state<string | null>(null);
  let dragGhost = $state<{ x: number; y: number; name: string } | null>(null);
  let fileInput = $state<HTMLInputElement>();

  const MAX_ROWS = 400;
  const canPickFolders = supportsFolders();

  let shown = $derived(
    entries
      .filter((e) => !favsOnly || favs.has(e.id))
      .filter((e) => e.name.toLowerCase().includes(search.toLowerCase()))
      .slice(0, MAX_ROWS),
  );

  onMount(() => {
    const onToggle = () => {
      open = !open;
      if (open && folders.length === 0) void restoreFolders();
    };
    window.addEventListener('kk-toggle-library', onToggle);
    return () => window.removeEventListener('kk-toggle-library', onToggle);
  });

  /** Persisted handles: scan granted ones, list the rest with a re-grant button. */
  async function restoreFolders() {
    try {
      const handles = await loadDirHandles();
      for (const handle of handles) {
        const granted = (await handle.queryPermission?.({ mode: 'read' })) === 'granted';
        const state: FolderState = { name: handle.name, handle, granted, count: 0 };
        folders = [...folders, state];
        if (granted) await scanInto(state);
      }
    } catch {
      // IndexedDB unavailable — folders just won't persist
    }
  }

  async function scanInto(folder: FolderState) {
    const found = await scanDirectory(folder.handle);
    folder.count = found.length;
    entries = [...entries.filter((e) => e.folder !== folder.name), ...found];
    folders = [...folders];
  }

  async function addFolder() {
    const handle = await pickDirectory();
    if (!handle) return;
    await saveDirHandle(handle).catch(() => undefined);
    const state: FolderState = { name: handle.name, handle, granted: true, count: 0 };
    folders = [...folders.filter((f) => f.name !== handle.name), state];
    await scanInto(state);
  }

  async function regrant(folder: FolderState) {
    const result = await folder.handle.requestPermission?.({ mode: 'read' });
    if (result === 'granted') {
      folder.granted = true;
      await scanInto(folder);
    }
  }

  async function removeFolder(folder: FolderState) {
    await deleteDirHandle(folder.name).catch(() => undefined);
    folders = folders.filter((f) => f !== folder);
    entries = entries.filter((e) => e.folder !== folder.name);
  }

  /** Fallback (Firefox/Safari/denied permission): add plain files. */
  function addFiles(e: Event) {
    const files = [...((e.target as HTMLInputElement).files ?? [])].filter((f) => isAudioFile(f.name));
    entries = [
      ...entries,
      ...files.map((f) => ({ id: `files/${f.name}`, name: f.name, folder: 'files', file: f })),
    ].sort((a, b) => a.name.localeCompare(b.name));
    if (fileInput) fileInput.value = '';
  }

  function onPanelDrop(e: DragEvent) {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => isAudioFile(f.name));
    if (files.length === 0) return;
    entries = [
      ...entries,
      ...files.map((f) => ({ id: `files/${f.name}`, name: f.name, folder: 'files', file: f })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  }

  function toggleFav(entry: LibraryEntry) {
    const next = new Set(favs);
    if (next.has(entry.id)) next.delete(entry.id);
    else next.add(entry.id);
    favs = next;
    saveFavorites(next);
  }

  async function audition(entry: LibraryEntry) {
    auditioning = entry.id;
    try {
      await appState.ensureEngine();
      const file = await entryFile(entry);
      const decoded = await appState.engine.decode(await file.arrayBuffer());
      const channels: Float32Array[] = [];
      for (let c = 0; c < Math.min(2, decoded.numberOfChannels); c++) {
        channels.push(decoded.getChannelData(c).slice());
      }
      appState.engine.preview(decoded.sampleRate, channels);
    } finally {
      auditioning = null;
    }
  }

  /** Click = audition; drag past threshold = drop onto Sampler / Drum pad. */
  function rowPointerDown(e: PointerEvent, entry: LibraryEntry) {
    if ((e.target as HTMLElement).closest('.fav')) return; // star handles itself
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    const onMove = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) dragging = true;
      if (dragging) dragGhost = { x: ev.clientX, y: ev.clientY, name: entry.name };
    };
    const onUp = async (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      dragGhost = null;
      if (!dragging) {
        void audition(entry);
        return;
      }
      const target = patchCanvas.dropTargetAt(ev.clientX, ev.clientY);
      if (!target) return;
      const file = await entryFile(entry);
      await appState.loadSampleFile(target.moduleId, file, target.pad);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }
</script>

{#if open}
  <div
    class="library"
    role="region"
    aria-label="Sample Library"
    ondragover={(e) => e.preventDefault()}
    ondrop={onPanelDrop}
  >
    <div class="lib-header">
      <span class="lib-title">Samples</span>
      <span class="spacer"></span>
      {#if canPickFolders}
        <button class="add-folder" onclick={addFolder} title="Add a local sample folder (read-only access)">
          + Folder
        </button>
      {/if}
      <button class="add-files" onclick={() => fileInput?.click()} title="Add individual audio files">
        + Files
      </button>
      <input
        bind:this={fileInput}
        type="file"
        accept="audio/*,.wav,.aif,.aiff,.mp3,.flac,.ogg,.m4a"
        multiple
        hidden
        onchange={addFiles}
      />
    </div>

    <div class="lib-controls">
      <input class="search" type="search" placeholder="Search…" bind:value={search} />
      <button
        class="fav-filter"
        class:active={favsOnly}
        onclick={() => (favsOnly = !favsOnly)}
        title="Show favorites only"
      >★</button>
    </div>

    {#each folders as folder (folder.name)}
      <div class="folder-row">
        <span class="folder-name" title={folder.name}>📁 {folder.name}</span>
        {#if folder.granted}
          <span class="folder-count">{folder.count}</span>
        {:else}
          <button class="regrant" onclick={() => regrant(folder)} title="Browser needs a one-click re-grant per session">
            re-grant
          </button>
        {/if}
        <button class="remove" onclick={() => removeFolder(folder)} title="Remove folder from library">✕</button>
      </div>
    {/each}

    <div class="entries">
      {#each shown as entry (entry.id)}
        <div
          class="entry"
          class:auditioning={auditioning === entry.id}
          role="button"
          tabindex="0"
          onpointerdown={(e) => rowPointerDown(e, entry)}
          title="Click: audition. Drag onto a Sampler or Drum Machine pad to load."
        >
          <span class="entry-name">{entry.name}</span>
          <span class="entry-folder">{entry.folder}</span>
          <button class="fav" class:faved={favs.has(entry.id)} onclick={() => toggleFav(entry)}>
            {favs.has(entry.id) ? '★' : '☆'}
          </button>
        </div>
      {:else}
        <div class="empty">
          {entries.length === 0
            ? canPickFolders
              ? 'Add a folder or drop audio files here.'
              : 'Add or drop audio files here (folder access needs a Chromium browser).'
            : 'No matches.'}
        </div>
      {/each}
      {#if shown.length === MAX_ROWS}
        <div class="empty">…more hidden — narrow the search.</div>
      {/if}
    </div>
  </div>
{/if}

{#if dragGhost}
  <div class="drag-ghost" style="left: {dragGhost.x + 12}px; top: {dragGhost.y + 8}px">
    🎵 {dragGhost.name}
  </div>
{/if}

<style>
  .library {
    width: 240px;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border-left: 1px solid var(--panel-border);
    user-select: none;
    min-height: 0;
  }
  .lib-header,
  .lib-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px 0;
  }
  .lib-title {
    font-weight: 700;
    font-size: 13px;
    color: var(--text);
  }
  .spacer {
    flex: 1;
  }
  .search {
    flex: 1;
    min-width: 0;
  }
  .fav-filter.active {
    color: var(--accent);
  }
  .folder-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .folder-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .folder-count {
    font-size: 11px;
  }
  .entries {
    flex: 1;
    overflow-y: auto;
    margin-top: 6px;
    border-top: 1px solid var(--panel-border);
  }
  .entry {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    font-size: 12px;
    color: var(--text);
    cursor: grab;
  }
  .entry:hover {
    background: var(--control);
  }
  .entry.auditioning {
    background: var(--control-border);
  }
  .entry-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .entry-folder {
    font-size: 10px;
    color: var(--text-dim);
  }
  .fav {
    background: none;
    border: none;
    padding: 0 2px;
    color: var(--text-dim);
    cursor: pointer;
  }
  .fav.faved {
    color: var(--accent);
  }
  .empty {
    padding: 12px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .drag-ghost {
    position: fixed;
    z-index: 80;
    pointer-events: none;
    background: var(--panel);
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 12px;
    color: var(--text);
  }
</style>
