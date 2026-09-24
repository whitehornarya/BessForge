import { useDesignStore } from './stores/useDesignStore';

/** Yield so React can paint BusyOverlay / computing banner before sync work. */
export function paintFrame(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      setTimeout(resolve, 30);
    });
  });
}

/**
 * Run sync heavy work after the UI has painted (e.g. computing banner).
 * Prefer withBusyOverlay for multi-second user-initiated jobs.
 */
export async function paintThen<T>(fn: () => T): Promise<T> {
  await paintFrame();
  return fn();
}

/**
 * Full-screen BusyOverlay around async (or paint-then-sync) work.
 * Always clears the overlay in finally, even on throw.
 */
export async function withBusyOverlay<T>(
  label: string,
  work: () => Promise<T> | T,
  opts?: { frac?: number },
): Promise<T> {
  const { setBusyOverlay } = useDesignStore.getState();
  setBusyOverlay({ label, frac: opts?.frac });
  await paintFrame();
  try {
    return await work();
  } finally {
    useDesignStore.getState().setBusyOverlay(null);
  }
}

/** Update BusyOverlay progress mid-job (0..1). No-op if overlay is already cleared. */
export function setBusyFrac(frac: number, label?: string) {
  const cur = useDesignStore.getState().busyOverlay;
  if (!cur) return;
  useDesignStore.getState().setBusyOverlay({
    label: label ?? cur.label,
    frac: Math.max(0, Math.min(1, frac)),
  });
}
