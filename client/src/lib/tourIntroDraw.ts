import type { TourIntroInfo } from './cinematicTour';

// Cinematic title-card renderer, shared 1:1 between the tour's
// recorder-captured overlay canvas (TourFadeOverlay) and the live preview in
// the tour options popover — so what the drafter previews while typing IS
// the staging/typography the exported video renders. Staged type reveals are
// driven purely by p (introProgressAt output, 0..1 inside the intro window),
// so seeking and cancel re-render exactly. Pure canvas drawing — no store
// access, no side effects beyond the 2D context.
export function drawTourIntro(
  ctx: CanvasRenderingContext2D, W: number, H: number, introInfo: TourIntroInfo, p: number,
): void {
  const smooth = (v: number) => { const c = Math.min(1, Math.max(0, v)); return c * c * (3 - 2 * c); };
  const stage = (a: number, b: number) => smooth((p - a) / (b - a));
  // Global out-fade in the final stretch of the window.
  const out = 1 - smooth((p - 0.86) / 0.14);
  const mx = Math.round(W * 0.07);            // left margin
  // Bottom scrim so white type reads over any terrain.
  const scrim = ctx.createLinearGradient(0, H * 0.34, 0, H);
  scrim.addColorStop(0, 'rgba(2, 6, 23, 0)');
  scrim.addColorStop(1, `rgba(2, 6, 23, ${0.66 * out})`);
  ctx.fillStyle = scrim;
  ctx.fillRect(0, Math.round(H * 0.34), W, H - Math.round(H * 0.34));
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const rise = (s: number) => (1 - s) * Math.round(H * 0.03); // slide-up
  let y = Math.round(H * 0.56);
  // Eyebrow — small caps, wide tracking, cyan accent.
  {
    const s = stage(0.04, 0.14);
    const px = Math.max(12, Math.round(H * 0.017));
    ctx.font = `600 ${px}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = `rgba(103, 232, 249, ${0.95 * s * out})`; // cyan-300
    ctx.fillText(introInfo.eyebrow.split('').join('\u200a\u200a'), mx, y + rise(s));
    y += Math.round(px * 1.9);
  }
  // Hairline rule that draws in left→right.
  {
    const s = stage(0.08, 0.22);
    ctx.fillStyle = `rgba(148, 163, 184, ${0.7 * s * out})`;
    ctx.fillRect(mx, y - 2, Math.round(W * 0.30 * s), 2);
    y += Math.round(H * 0.012);
  }
  // Title — the KMZ project name, hero display type with a soft glow.
  {
    const s = stage(0.10, 0.24);
    let px = Math.max(30, Math.round(H * 0.062));
    ctx.font = `800 ${px}px ui-sans-serif, system-ui, sans-serif`;
    // Shrink-to-fit: long KMZ project names must never run off-frame.
    const maxW = W * 0.86 - mx;
    const tw = ctx.measureText(introInfo.title).width;
    if (tw > maxW) {
      px = Math.max(20, Math.floor(px * maxW / tw));
      ctx.font = `800 ${px}px ui-sans-serif, system-ui, sans-serif`;
    }
    ctx.save();
    ctx.shadowColor = `rgba(34, 211, 238, ${0.5 * s * out})`;
    ctx.shadowBlur = px * 0.45;
    ctx.fillStyle = `rgba(248, 250, 252, ${s * out})`;
    y += px;
    ctx.fillText(introInfo.title, mx, y + rise(s));
    ctx.restore();
  }
  // Location / acreage.
  if (introInfo.subtitle) {
    const s = stage(0.18, 0.32);
    const px = Math.max(13, Math.round(H * 0.022));
    y += Math.round(px * 1.9);
    ctx.font = `500 ${px}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = `rgba(203, 213, 225, ${0.95 * s * out})`;
    ctx.fillText(introInfo.subtitle, mx, y + rise(s));
  }
  // Rating — MW / MWh count up while their stage plays.
  {
    const s = stage(0.28, 0.44);
    const cnt = smooth((p - 0.28) / 0.32); // slower count-up, done by ~0.60
    const px = Math.max(20, Math.round(H * 0.040));
    y += Math.round(px * 2.0);
    ctx.font = `700 ${px}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = `rgba(248, 250, 252, ${s * out})`;
    const mw = Math.round(introInfo.mw * cnt);
    const mwh = Math.round(introInfo.mwh * cnt);
    const txt = `${mw} MW  ·  ${mwh} MWH  ·  ${introInfo.hours}-HOUR`;
    ctx.fillText(txt, mx, y + rise(s));
  }
  // Equipment configuration with manufacturers — staggered reveals.
  {
    const px = Math.max(12, Math.round(H * 0.019));
    ctx.font = `500 ${px}px ui-sans-serif, system-ui, sans-serif`;
    for (let i = 0; i < introInfo.equipment.length; i++) {
      const s = stage(0.40 + i * 0.06, 0.54 + i * 0.06);
      y += Math.round(px * 1.75);
      ctx.fillStyle = `rgba(103, 232, 249, ${0.9 * s * out})`;
      ctx.fillRect(mx, y - px * 0.62, Math.round(px * 0.3), Math.round(px * 0.62));
      ctx.fillStyle = `rgba(226, 232, 240, ${0.92 * s * out})`;
      ctx.fillText(introInfo.equipment[i], mx + Math.round(px * 0.9), y + rise(s));
    }
  }
}
