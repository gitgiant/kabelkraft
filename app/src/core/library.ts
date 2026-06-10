/**
 * Sample Library backing store (PRD §8.2): the user's own local sample
 * folders, browsed via the File System Access API (Chromium). Directory
 * handles persist in IndexedDB so re-grant is one click per session.
 * Fallback everywhere else: plain Files added via picker or drag-drop.
 * No bundled sample pack.
 */

export interface LibraryEntry {
  /** Stable id: `folderName/relative/path`. Favorites key off this. */
  id: string;
  name: string;
  folder: string;
  handle?: FileSystemFileHandle;
  /** Fallback path (file picker / drag-drop): the File itself. */
  file?: File;
}

/** FS Access API surface beyond lib.dom — feature-detected, never assumed. */
export type DirHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
  queryPermission?(opts?: { mode?: string }): Promise<string>;
  requestPermission?(opts?: { mode?: string }): Promise<string>;
};

export function supportsFolders(): boolean {
  return typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

export async function pickDirectory(): Promise<DirHandle | null> {
  const picker = (window as unknown as { showDirectoryPicker?: (o?: object) => Promise<DirHandle> })
    .showDirectoryPicker;
  if (!picker) return null;
  try {
    return await picker({ id: 'kk-samples', mode: 'read' });
  } catch {
    return null; // user cancelled the native picker
  }
}

const AUDIO_FILE = /\.(wav|aiff?|mp3|flac|ogg|m4a)$/i;

export function isAudioFile(name: string): boolean {
  return AUDIO_FILE.test(name);
}

/** Recursively collect audio files under a granted directory handle. */
export async function scanDirectory(dir: DirHandle, cap = 2000): Promise<LibraryEntry[]> {
  const out: LibraryEntry[] = [];
  const walk = async (d: DirHandle, prefix: string): Promise<void> => {
    for await (const child of d.values()) {
      if (out.length >= cap) return;
      if (child.kind === 'file') {
        if (isAudioFile(child.name)) {
          out.push({
            id: `${dir.name}/${prefix}${child.name}`,
            name: child.name,
            folder: dir.name,
            handle: child as FileSystemFileHandle,
          });
        }
      } else {
        await walk(child as DirHandle, `${prefix}${child.name}/`);
      }
    }
  };
  await walk(dir, '');
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function entryFile(entry: LibraryEntry): Promise<File> {
  if (entry.file) return entry.file;
  if (entry.handle) return entry.handle.getFile();
  throw new Error(`Library entry has no backing file: ${entry.id}`);
}

// -- IndexedDB persistence of directory handles ------------------------------

const DB_NAME = 'kk-library';
const STORE = 'dirs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveDirHandle(handle: DirHandle): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(handle, handle.name);
  await txDone(tx);
}

export async function deleteDirHandle(name: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(name);
  await txDone(tx);
}

export async function loadDirHandles(): Promise<DirHandle[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as DirHandle[]);
    req.onerror = () => reject(req.error);
  });
}

// -- favorites (PRD §8.2 tagging v1) ------------------------------------------

const FAV_KEY = 'kk-lib-favs';

export function loadFavorites(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function saveFavorites(favs: Set<string>): void {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify([...favs]));
  } catch {
    // storage unavailable — favorites just won't persist
  }
}
