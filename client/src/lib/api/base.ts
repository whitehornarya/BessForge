export const API_OVERRIDE_STORAGE_KEY = 'bessforge.eci.apiBase';

export interface ApiRuntimeConfig {
  apiBase?: unknown;
  API_BASE_URL?: unknown;
}

declare global {
  interface Window {
    __BESSFORGE_CONFIG__?: ApiRuntimeConfig;
  }
}

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/** Validate an API origin. Paths, credentials, query strings and fragments are forbidden. */
export function validateApiBase(value: string): string {
  const input = value.trim();
  if (!input) throw new Error('API base is empty');
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('API base must be an absolute URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('API base must use HTTP or HTTPS');
  }
  if (url.username || url.password) throw new Error('API base must not contain credentials');
  if (url.search || url.hash) throw new Error('API base must not contain a query or fragment');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('API base must be an origin without a path');
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
    throw new Error('API base must use HTTPS except on loopback');
  }
  return url.origin;
}

export interface ResolveApiBaseOptions {
  runtimeValue?: unknown;
  savedValue?: unknown;
  location?: Pick<Location, 'protocol' | 'origin'>;
}

function nonempty(value: unknown): unknown | undefined {
  return typeof value === 'string' && value.trim() === '' ? undefined : value ?? undefined;
}

/** One resolver for browser, hosted, file, desktop, and synthetic test environments. */
export function resolveApiBase(options: ResolveApiBaseOptions = {}): string {
  const browser = typeof window !== 'undefined' ? window : undefined;
  const runtime = options.runtimeValue !== undefined
    ? nonempty(options.runtimeValue)
    : nonempty(browser?.__BESSFORGE_CONFIG__?.apiBase)
      ?? nonempty(browser?.__BESSFORGE_CONFIG__?.API_BASE_URL);
  let saved = options.savedValue;
  if (saved === undefined && browser) {
    try { saved = browser.localStorage.getItem(API_OVERRIDE_STORAGE_KEY); } catch { /* storage unavailable */ }
  }
  // An override entered in the application is intentionally the highest
  // priority. Desktop/runtime configuration becomes active again after Clear.
  const selected = nonempty(saved) ?? runtime;
  if (selected !== undefined) {
    if (typeof selected !== 'string') throw new Error('API base override must be a string');
    return validateApiBase(selected);
  }
  const loc = options.location ?? browser?.location;
  if (loc && (loc.protocol === 'http:' || loc.protocol === 'https:')) return '';
  return 'http://127.0.0.1:53117';
}

export function getSavedApiBaseOverride(): string {
  if (typeof window === 'undefined') return '';
  try { return window.localStorage.getItem(API_OVERRIDE_STORAGE_KEY) ?? ''; } catch { return ''; }
}

export function saveApiBaseOverride(value: string): string {
  const input = value.trim();
  const clean = input ? validateApiBase(input) : '';
  if (typeof window !== 'undefined') {
    if (clean) window.localStorage.setItem(API_OVERRIDE_STORAGE_KEY, clean);
    else window.localStorage.removeItem(API_OVERRIDE_STORAGE_KEY);
  }
  return resolveApiBase({ savedValue: clean || undefined });
}

export function apiUrl(path: string, query?: Record<string, string | number | undefined>): string {
  if (!path.startsWith('/api/')) throw new Error('API path must start with /api/');
  const base = resolveApiBase();
  const url = new URL(path, base ? `${base}/` : 'https://same-origin.invalid/');
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return base ? url.toString() : `${url.pathname}${url.search}`;
}