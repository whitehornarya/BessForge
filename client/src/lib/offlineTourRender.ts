// Offline frame-by-frame tour rendering (WebCodecs). Instead of recording
// the live screen in realtime — where a slow GPU or overloaded encoder drops
// frames — the tour sampler is stepped deterministically (tourSeek), every
// frame is rendered at full quality, and fed to a non-realtime VideoEncoder.
// Zero dropped frames, perfectly even 60 fps pacing, 4K output.
//
// Pure helpers live here (unit-testable); the render loop itself runs in
// DesignScene where the live canvases are reachable.

/** Scale w×h UP to UHD bounds (3840×2160) preserving aspect; never
 * downscale, and keep dimensions even for the encoder. */
export function uhdFitDims(w: number, h: number): { w: number; h: number } {
  const s = Math.min(3840 / Math.max(1, w), 2160 / Math.max(1, h));
  return s > 1
    ? { w: Math.round((w * s) / 2) * 2, h: Math.round((h * s) / 2) * 2 }
    : { w: Math.round(w / 2) * 2, h: Math.round(h / 2) * 2 };
}

/** Scale w×h to exactly touch the UHD bounds (3840×2160), up OR down,
 * preserving aspect with even dimensions. The offline encoder targets this:
 * the renderer supersamples ABOVE it (see OFFLINE_SUPERSAMPLE) and the
 * composite downscales into it — the output itself is never above 4K. */
export function uhdBoundDims(w: number, h: number): { w: number; h: number } {
  const s = Math.min(3840 / Math.max(1, w), 2160 / Math.max(1, h));
  return { w: Math.round((w * s) / 2) * 2, h: Math.round((h * s) / 2) * 2 };
}

/** Renderer supersample factor while rendering offline: the scene draws
 * ~1.4× above the UHD composite and is downscaled into it, cleaning up
 * fence lines / trench linework edges. */
export const OFFLINE_SUPERSAMPLE = 1.4;

export interface OfflineFrameSchedule {
  frames: number;        // total frames to render
  fps: number;
  frameDurUs: number;    // per-frame duration, microseconds
  seconds: number;       // covered tour seconds (after maxSeconds cap)
  tEnd: number;          // normalized tour time of the last frame (0..1]
}

/** Deterministic frame schedule for an offline render. `maxSeconds` caps the
 * covered stretch (test/preview hook); frame i plays at t = tAt(i). */
export function offlineFrameSchedule(
  durationSec: number,
  fps: number,
  maxSeconds?: number,
): OfflineFrameSchedule {
  const seconds = Math.max(0.5, Math.min(durationSec, maxSeconds ?? durationSec));
  const frames = Math.max(2, Math.round(seconds * fps));
  return {
    frames,
    fps,
    frameDurUs: Math.round(1e6 / fps),
    seconds,
    tEnd: Math.min(1, seconds / Math.max(durationSec, 1e-6)),
  };
}

export function offlineFrameT(sched: OfflineFrameSchedule, i: number): number {
  return sched.tEnd * (i / (sched.frames - 1));
}

/** Codec preference for the offline encoder (WebM container): VP9 first
 * (levels that cover 4K60), VP8 as the universal fallback. */
export const OFFLINE_CODECS = ['vp09.00.51.08', 'vp09.00.41.08', 'vp8'] as const;

/** Codec preference for the MP4 container: H.264/AVC only (High profile
 * levels that cover 4K60 then 4K30; baseline-ish 4.2 as the last resort).
 * There is deliberately NO VP9-in-MP4 entry — if no avc1 level is
 * supported, the renderer falls back to WebM with a toast instead. */
export const OFFLINE_MP4_CODECS = ['avc1.640034', 'avc1.640033', 'avc1.64002a', 'avc1.42002a'] as const;

export type OfflineContainer = 'webm' | 'mp4';

/** Codec preference list for a requested container. */
export function offlineCodecsFor(container: OfflineContainer): readonly string[] {
  return container === 'mp4' ? OFFLINE_MP4_CODECS : OFFLINE_CODECS;
}

export function codecToMuxerId(codec: string): 'V_VP9' | 'V_VP8' {
  return codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8';
}

/** Container a picked codec actually muxes into: avc1 → mp4, vp* → webm.
 * The render loop keys the muxer, file extension, and MIME type off this —
 * never off the *requested* container (an mp4 request can fall back). */
export function codecContainer(codec: string): OfflineContainer {
  return codec.startsWith('avc1') ? 'mp4' : 'webm';
}

/** Offline (non-realtime) bitrate: generous bits-per-pixel with a hard cap —
 * quality mode, the encoder is not racing the clock. */
export function offlineBitrate(w: number, h: number, fps: number): number {
  return Math.min(80_000_000, Math.max(8_000_000, Math.round(w * h * fps * 0.09)));
}

/** First supported encoder config from the container's preference list, or
 * null. `container` defaults to webm; for mp4 the caller is expected to
 * fall back to webm itself (with a user-visible notice) when this returns
 * null — avc1 support is not universal. */
export async function pickOfflineCodec(
  width: number,
  height: number,
  fps: number,
  container: OfflineContainer = 'webm',
): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const codec of offlineCodecsFor(container)) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      framerate: fps,
      bitrate: offlineBitrate(width, height, fps),
      latencyMode: 'quality',
    };
    try {
      const res = await VideoEncoder.isConfigSupported(config);
      if (res.supported) return res.config ?? config;
    } catch {
      // Unparseable codec string on this browser — try the next.
    }
  }
  return null;
}
