// Persistence for the imported CAD reference drawing.
//
// A full site export is far too big for the localStorage session blob: the
// customer's Big Iron KMZ carries ~261,000 vertices, which serializes to
// several MB and would push the whole autosave over quota — losing the
// drafter's design edits along with it. The drawing therefore lives in
// IndexedDB under its own key, and the session/project only records that one
// is present plus the per-layer visibility.
//
// Reference geometry only: nothing here is read by layout, routing,
// compliance, or any exporter. BUT the render-time heal for stale traced
// roads re-derives from this drawing — so a failure here must be LOUD:
// a silent null used to leave stale gate roads rendering as bare strips
// with a clean console, which is undiagnosable from a screenshot.
import type { ImportedDrawing } from './nextera/kmz';

const DB_NAME = 'nextera-drawing';
const STORE = 'drawing';
const KEY = 'imported';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    db =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
        tx.oncomplete = () => db.close();
      })
  );
}

// All operations run through one FIFO chain so a Remove (delete) fired just
// before a Replace (put) can never land after it and eat the new drawing.
let opChain: Promise<unknown> = Promise.resolve();
function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const next = opChain.then(op, op);
  opChain = next.catch(() => undefined);
  return next;
}

// Loud but not repetitive: one warning per distinct failure per page
// lifetime. A broken storage backend fails EVERY autosave (and every load in
// environments without IndexedDB, like the Node test suites) — repeating the
// identical stack trace hundreds of times buries the diagnostic it carries.
const storageWarnSeen = new Set<string>();
function warnOnce(kind: string, e: unknown, message: string): void {
  const key = `${kind}|${e instanceof Error ? e.message : String(e)}`;
  if (storageWarnSeen.has(key)) return;
  storageWarnSeen.add(key);
  console.warn(message, e);
}

/** Persist the imported drawing. Failures are non-fatal (display aid only)
 * but always logged — a drawing that silently fails to persist means the
 * next reload cannot re-derive stale traced roads from it. */
export function saveDrawing(drawing: ImportedDrawing | null): Promise<void> {
  return enqueue(async () => {
    try {
      if (!drawing) await withStore('readwrite', s => s.delete(KEY));
      // Structured-clone stores the flat number arrays directly — no JSON pass.
      else await withStore('readwrite', s => s.put(drawing, KEY));
    } catch (e) {
      warnOnce('save', e, '[traced-heal] persisting the reference drawing to browser storage failed — it will NOT survive a reload. Re-import the KMZ after reloading.');
    }
  });
}

/** Load the persisted drawing, or null when there is none. Ordered after any
 * pending save/delete so a read never observes a state an earlier write is
 * about to replace. */
export function loadDrawing(): Promise<ImportedDrawing | null> {
  return enqueue(async () => {
    try {
      const found = await withStore<ImportedDrawing | undefined>('readonly', s => s.get(KEY));
      if (found && (!Array.isArray(found.layers) || !found.layers.length)) {
        warnOnce('empty', 'no layers', '[traced-heal] the persisted reference drawing is present but has no layers — treating it as missing');
        return null;
      }
      return found ?? null;
    } catch (e) {
      warnOnce('load', e, '[traced-heal] reading the reference drawing from browser storage (IndexedDB) failed');
      return null;
    }
  });
}
