export const OFFLINE_DB_NAME = 'bessforge-offline';
export const OFFLINE_DB_VERSION = 1;
export const OFFLINE_STORE = 'api-responses';
export const MAX_CACHE_BYTES = 96 * 1024 * 1024;
export const MAX_CACHE_ENTRIES = 300;

export interface OfflineCacheRecord {
  schemaVersion: 1;
  key: string;
  endpoint: string;
  body: string;
  contentType: string;
  sha256: string;
  provenance: string;
  createdAt: number;
  expiresAt: number;
  lastAccessedAt: number;
  size: number;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(v => v.toString(16).padStart(2, '0')).join('');
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function db(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw new Error('Persistent offline storage is unavailable');
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    open.onupgradeneeded = () => {
      const d = open.result;
      if (!d.objectStoreNames.contains(OFFLINE_STORE)) {
        const store = d.createObjectStore(OFFLINE_STORE, { keyPath: 'key' });
        store.createIndex('lastAccessedAt', 'lastAccessedAt');
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('Unable to open offline storage'));
  });
}

export async function getCacheRecord(key: string): Promise<OfflineCacheRecord | null> {
  const d = await db();
  let record: OfflineCacheRecord | undefined;
  try {
    const tx = d.transaction(OFFLINE_STORE, 'readonly');
    record = await request(tx.objectStore(OFFLINE_STORE).get(key)) as OfflineCacheRecord | undefined;
    await transactionDone(tx);
  } finally { d.close(); }
  const valid = record && record.schemaVersion === 1 &&
    record.size === new TextEncoder().encode(record.body).byteLength &&
    await sha256Hex(record.body) === record.sha256;
  const d2 = await db();
  try {
    const tx = d2.transaction(OFFLINE_STORE, 'readwrite');
    if (!valid) {
      if (record) tx.objectStore(OFFLINE_STORE).delete(key);
    } else {
      record!.lastAccessedAt = Date.now();
      tx.objectStore(OFFLINE_STORE).put(record!);
    }
    await transactionDone(tx);
  } finally { d2.close(); }
  return valid ? record! : null;
}

export async function listCacheRecords(): Promise<OfflineCacheRecord[]> {
  const d = await db();
  try {
    const tx = d.transaction(OFFLINE_STORE, 'readonly');
    const records = await request(tx.objectStore(OFFLINE_STORE).getAll()) as OfflineCacheRecord[];
    await transactionDone(tx);
    return records.filter(r => r.schemaVersion === 1);
  } finally { d.close(); }
}

async function pruneCache(): Promise<void> {
  const records = (await listCacheRecords()).sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  let bytes = records.reduce((n, r) => n + r.size, 0);
  let count = records.length;
  const remove: string[] = [];
  for (const r of records) {
    if (bytes <= MAX_CACHE_BYTES && count <= MAX_CACHE_ENTRIES) break;
    remove.push(r.key); bytes -= r.size; count--;
  }
  if (!remove.length) return;
  const d = await db();
  try {
    const tx = d.transaction(OFFLINE_STORE, 'readwrite');
    remove.forEach(k => tx.objectStore(OFFLINE_STORE).delete(k));
    await transactionDone(tx);
  } finally { d.close(); }
}

export async function putCacheRecord(record: OfflineCacheRecord): Promise<void> {
  if (record.size > MAX_CACHE_BYTES / 2) return;
  try {
    const d = await db();
    try {
      const tx = d.transaction(OFFLINE_STORE, 'readwrite');
      tx.objectStore(OFFLINE_STORE).put(record);
      await transactionDone(tx);
    } finally { d.close(); }
    await pruneCache();
  } catch (e) {
    if (!(e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'UnknownError'))) throw e;
    const records = (await listCacheRecords()).sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    const d2 = await db();
    try {
      const tx = d2.transaction(OFFLINE_STORE, 'readwrite');
      records.slice(0, Math.max(1, Math.ceil(records.length / 4))).forEach(r => tx.objectStore(OFFLINE_STORE).delete(r.key));
      await transactionDone(tx);
    } finally { d2.close(); }
    const d3 = await db();
    try {
      const tx = d3.transaction(OFFLINE_STORE, 'readwrite');
      tx.objectStore(OFFLINE_STORE).put(record);
      await transactionDone(tx);
    } finally { d3.close(); }
  }
}

export async function importCacheRecord(record: OfflineCacheRecord): Promise<void> {
  let url: URL;
  try { url = new URL(record.key); } catch { throw new Error('Cache record URL is invalid'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname))) {
    throw new Error('Cache record URL is not an allowed API URL');
  }
  if (record.schemaVersion !== 1 || typeof record.endpoint !== 'string' || !record.endpoint.startsWith('/api/') ||
      url.pathname !== record.endpoint || typeof record.body !== 'string' ||
      typeof record.provenance !== 'string' || !record.provenance ||
      !Number.isFinite(record.createdAt) || !Number.isFinite(record.expiresAt) ||
      !Number.isInteger(record.size) || record.size < 0 ||
      record.size !== new TextEncoder().encode(record.body).byteLength ||
      await sha256Hex(record.body) !== record.sha256) throw new Error(`Cache integrity check failed for ${record.key}`);
  await putCacheRecord({ ...record, lastAccessedAt: Date.now() });
}