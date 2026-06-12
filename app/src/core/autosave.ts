/**
 * Crash-safety autosave (OPTIONS_MENU_PLAN.md P3) — the full project JSON
 * (samples embedded) in a single IndexedDB record. localStorage's ~5 MB quota
 * is too small once sample PCM rides along, so IndexedDB it is. One record,
 * overwritten on every save; restore is offered once on boot.
 */

const DB_NAME = 'kk-autosave';
const STORE = 'session';
const RECORD_KEY = 'last';

export interface AutosaveRecord {
  json: string;
  savedAt: number;
  projectName: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
        t.onabort = () => db.close();
      }),
  );
}

export function writeAutosave(record: AutosaveRecord): Promise<unknown> {
  return tx('readwrite', (s) => s.put(record, RECORD_KEY));
}

export async function readAutosave(): Promise<AutosaveRecord | null> {
  try {
    const rec = await tx<AutosaveRecord | undefined>('readonly', (s) => s.get(RECORD_KEY));
    return rec && typeof rec.json === 'string' ? rec : null;
  } catch {
    return null; // IndexedDB unavailable (private mode etc.) — no recovery offer
  }
}

export function clearAutosave(): Promise<unknown> {
  return tx('readwrite', (s) => s.delete(RECORD_KEY)).catch(() => undefined);
}

/** Size of the stored record in bytes (Options → Storage read-out). */
export async function autosaveSize(): Promise<number> {
  const rec = await readAutosave();
  return rec ? rec.json.length : 0;
}
