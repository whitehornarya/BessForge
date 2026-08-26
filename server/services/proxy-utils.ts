const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function queryNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "string" || value.length > 32 || !NUMBER_RE.test(value)) {
    throw new InputError(`${name} must be a number between ${min} and ${max}`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new InputError(`${name} must be a number between ${min} and ${max}`);
  }
  return number;
}

export function optionalQueryNumber(value: unknown, name: string, min: number, max: number): number | undefined {
  return value === undefined ? undefined : queryNumber(value, name, min, max);
}

export class InputError extends Error {
  readonly status = 400;
}

export class UpstreamError extends Error {
  constructor(readonly publicMessage = "Online service is temporarily unavailable") {
    super(publicMessage);
  }
}

export async function fetchFixed(
  url: URL,
  options: RequestInit & { timeoutMs: number; maxBytes: number },
): Promise<{ response: Response; bytes: Uint8Array }> {
  if (url.protocol !== "https:") throw new Error("Proxy upstream must use HTTPS");
  const { timeoutMs, maxBytes, ...init } = options;
  let response: Response;
  try {
    response = await fetch(url, { redirect: "error", ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new UpstreamError();
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new UpstreamError("Online service response was too large");
  }
  if (!response.body) return { response, bytes: new Uint8Array() };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new UpstreamError("Online service response was too large");
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { response, bytes };
}

export function parseJson<T>(bytes: Uint8Array): T {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new UpstreamError("Online service returned an invalid response");
  }
}

type Entry<T> = { value: T; expires: number; bytes: number };

export class BoundedTtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private totalBytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.maxBytes) return;
    this.delete(key);
    while (this.entries.size >= this.maxEntries || this.totalBytes + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs, bytes });
    this.totalBytes += bytes;
  }

  private delete(key: string): void {
    const old = this.entries.get(key);
    if (old) this.totalBytes -= old.bytes;
    this.entries.delete(key);
  }
}

export function safeProxyMessage(error: unknown, fallback: string): string {
  if (error instanceof InputError || error instanceof UpstreamError) return error.message;
  return fallback;
}