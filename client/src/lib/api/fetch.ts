import { apiUrl } from './base';
import { getCacheRecord, putCacheRecord, sha256Hex, type OfflineCacheRecord } from '../offline/cache';

export type ApiDataSource = 'network' | 'cache';
export interface ApiResponseMeta {
  url: string;
  source: ApiDataSource;
  cached: boolean;
  stale: boolean;
  offline: boolean;
  createdAt: number;
  expiresAt: number;
  provenance: string;
}
export interface ApiResult<T> { data: T; meta: ApiResponseMeta }
export const API_STATUS_EVENT = 'bessforge:api-status';
let lastApiStatus: (ApiResponseMeta & { error?: string }) | null = null;

function emit(meta: ApiResponseMeta, error?: string): void {
  lastApiStatus = { ...meta, ...(error ? { error } : {}) };
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(API_STATUS_EVENT, { detail: lastApiStatus }));
  }
}

export function getLastApiStatus(): Readonly<ApiResponseMeta & { error?: string }> | null {
  return lastApiStatus;
}

export async function apiFetchJson<T>(
  path: string,
  query: Record<string, string | number | undefined>,
  options: { ttlMs?: number; provenance?: string; signal?: AbortSignal } = {},
): Promise<ApiResult<T>> {
  const url = apiUrl(path, query);
  const ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
  let networkError: unknown;
  let serverReached = false;
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: options.signal });
    serverReached = true;
    const text = await response.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch {
      throw new Error(`API returned invalid JSON (${response.status})`);
    }
    if (!response.ok) throw new Error(body?.message ?? `API request failed (${response.status})`);
    const now = Date.now();
    const provenance = options.provenance ?? response.headers.get('x-data-source') ?? path;
    const expiresAt = now + ttlMs;
    try {
      const record: OfflineCacheRecord = {
        schemaVersion: 1, key: url, endpoint: path, body: text,
        contentType: response.headers.get('content-type') ?? 'application/json',
        sha256: await sha256Hex(text), provenance, createdAt: now,
        expiresAt, lastAccessedAt: now,
        size: new TextEncoder().encode(text).byteLength,
      };
      await putCacheRecord(record);
    } catch { /* a successful request must survive unavailable/quota storage */ }
    const meta: ApiResponseMeta = {
      url, source: 'network', cached: false, stale: false, offline: false,
      createdAt: now, expiresAt, provenance,
    };
    emit(meta);
    return { data: body as T, meta };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    networkError = error;
  }
  let cached: OfflineCacheRecord | null = null;
  try { cached = await getCacheRecord(url); } catch { /* report original network error below */ }
  if (!cached) throw networkError instanceof Error ? networkError : new Error('API request failed and no cached data is available');
  const meta: ApiResponseMeta = {
    url, source: 'cache', cached: true, stale: Date.now() > cached.expiresAt, offline: !serverReached,
    createdAt: cached.createdAt, expiresAt: cached.expiresAt, provenance: cached.provenance,
  };
  emit(meta, networkError instanceof Error ? networkError.message : String(networkError));
  return { data: JSON.parse(cached.body) as T, meta };
}