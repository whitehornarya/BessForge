import * as THREE from 'three';

// Scene-readiness signal for capture tooling (marketing stills).
//
// drei's useGLTF/useTexture and the satellite TextureLoader all route
// through THREE.DefaultLoadingManager, so its onStart/onLoad callbacks are
// a reliable "assets in flight" signal across the GLB cache, ground/road
// textures and the satellite drape. We chain onto any pre-existing
// handlers rather than replacing them.
//
// Readiness = the manager has been continuously idle for `settleMs`.
// The idle window matters: a view-mode switch mounts suspense boundaries
// over a couple of frames, and a finished GLB load can immediately kick
// off its texture decodes — a single instantaneous "idle" reading is not
// proof that nothing else is about to start. On a warm cache nothing
// loads at all, so the wait costs only the settle window instead of the
// old multi-second fixed sleeps. A hard `timeoutMs` bounds the wait on
// slow networks or a stuck loader, so capture always proceeds.

let loading = false;

const mgr = THREE.DefaultLoadingManager;
const prevStart = mgr.onStart?.bind(mgr);
const prevLoad = mgr.onLoad?.bind(mgr);
mgr.onStart = (url, itemsLoaded, itemsTotal) => {
  loading = true;
  prevStart?.(url, itemsLoaded, itemsTotal);
};
mgr.onLoad = () => {
  // The manager fires onLoad when every started item has ended (errored
  // loaders call itemEnd too, so a failed tile never wedges this flag).
  loading = false;
  prevLoad?.();
};

export function loadersBusy(): boolean {
  return loading;
}

/**
 * Resolves once THREE.DefaultLoadingManager has been idle for `settleMs`
 * straight, or after `timeoutMs` regardless (hard fallback — never rejects).
 *
 * Resolves `true` when the scene genuinely settled, `false` when the hard
 * timeout fired while loaders were still busy (callers may surface a
 * warning — e.g. the offline tour render capturing half-loaded models).
 */
export function waitForSceneReady({ settleMs = 400, timeoutMs = 10000 }: {
  settleMs?: number;
  timeoutMs?: number;
} = {}): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const deadline = performance.now() + timeoutMs;
    let idleSince: number | null = loading ? null : performance.now();
    const tick = () => {
      const now = performance.now();
      if (now >= deadline) return resolve(!loading);
      if (loading) {
        idleSince = null;
      } else {
        if (idleSince === null) idleSince = now;
        if (now - idleSince >= settleMs) return resolve(true);
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}
