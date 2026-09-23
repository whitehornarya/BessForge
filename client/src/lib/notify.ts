import { toast } from 'sonner';

/**
 * Toast a fixed user-facing error while logging the real cause for debugging.
 * Never put exception text, status codes, or stack traces in the toast.
 */
export function toastCaught(userMessage: string, err: unknown, opts?: { duration?: number }) {
  console.error(userMessage, err);
  toast.error(userMessage, opts);
}

/** Looks like a thrown exception / browser / Node system string, not drafter copy. */
function looksLikeSystemError(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/\b(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|AggregateError)\b/i.test(t)) return true;
  if (/\b(Error|Exception):\s/i.test(t)) return true;
  if (/\bat\s+\S+\s+\([^)]+:\d+:\d+\)/.test(t)) return true; // stack frame
  if (/\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EACCES|ENOENT|EPERM)\b/i.test(t)) return true;
  if (/\bHTTP\s*[\/]?\s*\d{3}\b/i.test(t)) return true;
  if (/\bstatus\s*(code)?\s*[:=]?\s*\d{3}\b/i.test(t)) return true;
  if (/cannot read propert/i.test(t)) return true;
  if (/is not (a function|defined|iterable)/i.test(t)) return true;
  if (/^undefined\b/i.test(t) || /^null\b/i.test(t)) return true;
  if (/unknown error/i.test(t)) return true;
  return false;
}

/**
 * Use curated layout-engine rejection copy when it is human-readable.
 * System/exception strings fall back to a fixed phrase and are logged.
 */
export function friendlyRejectReason(
  why: string | null | undefined,
  fallback = 'clearances or setbacks not met',
): string {
  if (!why || !why.trim()) return fallback;
  if (looksLikeSystemError(why)) {
    console.error('Rejected with system-style reason (scrubbed from toast):', why);
    return fallback;
  }
  return why.trim();
}
