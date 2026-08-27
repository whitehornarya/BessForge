/**
 * Shared dev-server bootstrap for the visual/e2e test scripts.
 *
 * The test suites used to boot their own dev server on :5000 when none was
 * running. If a test crashed (or was still running) that spawned server kept
 * the port, and the Start Game workflow crash-looped with EADDRINUSE, taking
 * the preview offline. Now every test-spawned server binds a dedicated port
 * (5199 by default, override with NEXTERA_TEST_PORT) and is torn down on
 * process exit, including failures and signals.
 */
import { spawn } from 'node:child_process';

export const TEST_PORT = Number(process.env.NEXTERA_TEST_PORT || 5199);
export const TEST_BASE = `http://127.0.0.1:${TEST_PORT}`;

let child = null;

function killChild() {
  if (child && child.exitCode === null) {
    // npx wraps tsx which wraps node — kill the whole detached process
    // group, or the actual server process outlives the wrapper and keeps
    // the port bound.
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    try { child.kill('SIGTERM'); } catch {}
  }
  child = null;
}

async function up() {
  try {
    const res = await fetch(`${TEST_BASE}/`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ensure a dev server is answering on TEST_BASE, spawning one on the test
 * port if needed. The spawned server is killed on process exit / SIGTERM /
 * SIGINT / SIGHUP — including fail() paths that call process.exit(1).
 * Throws if the server does not come up within 45s.
 */
export async function ensureDevServer() {
  if (await up()) return;
  console.log(`dev server not running on :${TEST_PORT} — starting one`);
  child = spawn('npx', ['tsx', 'server/index.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group so killChild can take out npx+tsx+node together
    env: { ...process.env, NODE_ENV: 'development', PORT: String(TEST_PORT) },
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  child.on('exit', () => { child = null; });
  process.on('exit', killChild);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => { killChild(); process.exit(1); });
  }
  const t0 = Date.now();
  while (!(await up())) {
    if (Date.now() - t0 > 45000) {
      killChild();
      throw new Error('dev server did not come up within 45s');
    }
    await sleep(1000);
  }
}

/** Kill the test-spawned dev server (no-op if we attached to an existing one). */
export function stopDevServer() {
  killChild();
}
