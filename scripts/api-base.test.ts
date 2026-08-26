import assert from 'node:assert/strict';
import {
  API_OVERRIDE_STORAGE_KEY,
  apiUrl,
  resolveApiBase,
  saveApiBaseOverride,
  validateApiBase,
} from '../client/src/lib/api/base';

assert.equal(validateApiBase('https://api.example.com/'), 'https://api.example.com');
assert.equal(validateApiBase('http://localhost:5000'), 'http://localhost:5000');
assert.equal(resolveApiBase({
  runtimeValue: 'https://runtime.example',
  savedValue: 'https://saved.example',
  location: { protocol: 'https:', origin: 'https://hosted.example' } as Location,
}), 'https://saved.example');
assert.equal(resolveApiBase({
  savedValue: 'https://saved.example',
  location: { protocol: 'https:', origin: 'https://hosted.example' } as Location,
}), 'https://saved.example');
assert.equal(resolveApiBase({
  location: { protocol: 'https:', origin: 'https://hosted.example' } as Location,
}), '');
assert.equal(resolveApiBase({
  runtimeValue: '   ',
  savedValue: 'https://saved.example',
  location: { protocol: 'https:', origin: 'https://hosted.example' } as Location,
}), 'https://saved.example');
assert.equal(resolveApiBase({
  location: { protocol: 'file:', origin: 'null' } as Location,
}), 'http://127.0.0.1:53117');

for (const bad of [
  'ftp://api.example.com', 'http://api.example.com', 'https://u:p@api.example.com',
  'https://api.example.com/path', 'https://api.example.com?q=1', 'https://api.example.com/#x',
]) assert.throws(() => validateApiBase(bad));

function exerciseApplyAndClear(
  label: string,
  runtimeValue: string,
  location: Pick<Location, 'protocol' | 'origin'>,
  expectedAfterClear: string,
): void {
  const values = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const fakeWindow = {
    __BESSFORGE_CONFIG__: { apiBase: runtimeValue },
    localStorage,
    location,
  };
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });

  assert.equal(apiUrl('/api/site', { source: label }), `${expectedAfterClear}/api/site?source=${label}`);
  assert.equal(saveApiBaseOverride(' https://override.example/ '), 'https://override.example');
  assert.equal(values.get(API_OVERRIDE_STORAGE_KEY), 'https://override.example');
  assert.equal(
    apiUrl('/api/site', { source: label }),
    `https://override.example/api/site?source=${label}`,
    `${label}: Apply must affect subsequent API URLs`,
  );
  assert.equal(saveApiBaseOverride(''), expectedAfterClear);
  assert.equal(values.has(API_OVERRIDE_STORAGE_KEY), false);
  assert.equal(
    apiUrl('/api/site', { source: label }),
    `${expectedAfterClear}/api/site?source=${label}`,
    `${label}: Clear must restore runtime/default`,
  );
}

exerciseApplyAndClear(
  'web',
  '',
  { protocol: 'https:', origin: 'https://hosted.example' },
  '',
);
exerciseApplyAndClear(
  'electron',
  'http://127.0.0.1:53117',
  { protocol: 'file:', origin: 'null' },
  'http://127.0.0.1:53117',
);
exerciseApplyAndClear(
  'tauri',
  'http://localhost:53117',
  { protocol: 'tauri:', origin: 'null' },
  'http://localhost:53117',
);
delete (globalThis as { window?: unknown }).window;

console.log('api-base.test.ts: all assertions passed');