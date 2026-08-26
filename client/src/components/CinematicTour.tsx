import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { SiteDesign } from '../lib/nextera/types';
import { useDesignStore } from '../lib/stores/useDesignStore';
import { buildTourSampler, feederFlyalongRoute, flyalongIsland, buildTourIntro, introProgressAt, flyalongFutureGhosts, flightRealisticEnabled, CLOSEUP_FADE_LEAD, CLOSEUP_FADE_TAIL } from '../lib/cinematicTour';
import { waitForSceneReady } from '../lib/sceneReady';
import { bessCountForInverters } from '../lib/nextera/feederColors';
import { feederDisplayName } from '../lib/nextera/feederNaming';
import { getEffectiveConfiguration } from '../lib/nextera/catalog';
import { MODEL_URLS, inverterModelUrl } from './RealisticEquipment';
import { getConfiguration } from '../lib/nextera/catalog';

// Cinematic marketing tour playback: drives the perspective camera along the
// authored path from lib/cinematicTour (orbit → gate dive → drive-through →
// pull-up bookend). Mounted only while the tour is active (3D view); saves
// the drafter's camera pose on entry and restores it on exit/cancel.
// Presentation-only — no effect on layout math or exports.
export default function CinematicTourCamera({ design }: { design: SiteDesign }) {
  const camera = useThree(s => s.camera);
  const controls = useThree(s => s.controls) as any;
  const invalidate = useThree(s => s.invalidate);
  const stopTour = useDesignStore(s => s.stopCinematicTour);

  const tourOptions = useDesignStore(s => s.tourOptions);
  // Feeder fly-along extras: the routed feeder polyline (substation ->
  // island) plus the island stat card content. All read-only derivations of
  // already-routed state — nothing is re-routed or persisted.
  const feeders = useDesignStore(s => s.feeders);
  const substation = useDesignStore(s => s.substation);
  const fly = useMemo(() => feederFlyalongRoute(feeders, substation), [feeders, substation]);
  const sampler = useMemo(
    () => buildTourSampler(design, tourOptions, { feederRoute: fly?.route ?? null }),
    [design, tourOptions, fly],
  );
  // Cinematic title intro content: pure derivation from the design + the
  // effective equipment configuration (manufacturer names, rating, KMZ
  // project name/location). Fixed per tour.
  const configId = useDesignStore(s => s.configId);
  const containersPerPcs = useDesignStore(s => s.containersPerPcs);
  const introInfo = useMemo(
    () => buildTourIntro(design, getEffectiveConfiguration(configId, containersPerPcs), {
      title: tourOptions.introTitle,
      subtitle: tourOptions.introSubtitle,
    }),
    [design, configId, containersPerPcs, tourOptions.introTitle, tourOptions.introSubtitle],
  );
  const statCard = useMemo(() => {
    if (!fly) return null;
    const f = fly.feeder;
    const island = flyalongIsland(design, f);
    const installed = f.inverterIds.length;
    const bess = bessCountForInverters(f.inverterIds, design.equipment);
    const aug = island
      ? design.reservedZones.filter(z => z.id.startsWith(`island-aug-${island.n}-`)).length
      : 0;
    return {
      title: island ? `ISLAND ${island.n} · FEEDER #${feederDisplayName(f)}` : `FEEDER #${feederDisplayName(f)}`,
      // Stated island rating (the standard 7+2 island): overlay copy only.
      lines: ['QTY 9 PCS PER FEEDER', 'QTY 7 INSTALLED', 'QTY 2 FUTURE UPGRADE w/ BESS'],
      sub: [
        `${installed} PCS · ${bess} BATTERY CONTAINERS ON FEEDER`,
        `${aug ? `${aug} AUG UNIT${aug === 1 ? '' : 'S'} · ` : ''}${Math.round(f.totalLengthFt).toLocaleString()} FT FEEDER RUN`,
      ],
    };
  }, [design, fly]);
  // Ghost outlines for the stat card's "QTY 2 FUTURE UPGRADE" line: the
  // future-upgrade PCS boxes on the served island, faded in/out over the
  // same hold window. Pure derivation of the design's own future ghosts.
  const ghosts = useMemo(
    () => (fly ? flyalongFutureGhosts(design, fly.feeder) : []),
    [design, fly],
  );
  const t = useRef(0);
  const saved = useRef<{ pos: THREE.Vector3; quat: THREE.Quaternion; target: THREE.Vector3 | null } | null>(null);
  // Realistic-flight gate: when the drafter's tour option asks for realistic
  // models during the flight, the clock holds at t=0 until the GLBs settle
  // so the camera never flies past half-loaded units. true = fly.
  const modelsReady = useRef(true);

  // Realistic models for the flight (opt-in tour option): flip the scene
  // toggle on for the duration of the camera path and restore the drafter's
  // prior state on ANY exit (finish → showcase hand-off, Esc, click, view
  // switch, clearSite unmount). Presentation-only — never persisted as a
  // design change; the showcase's own reveal segment manages its own state
  // after this component unmounts.
  useEffect(() => {
    const st = useDesignStore.getState();
    if (!flightRealisticEnabled(st.tourOptions)) return;
    const prev = st.realisticModels;
    if (!prev) st.setRealisticModels(true);
    modelsReady.current = false;
    let disposed = false;
    // Live flight waits a bounded time; the offline renderer drives via
    // tourSeek and performs its own (longer, quality-mode) wait, so this
    // gate never stalls a stepped render.
    waitForSceneReady({ timeoutMs: 20000 }).then(() => {
      if (disposed) return;
      modelsReady.current = true;
      invalidate();
    });
    return () => {
      disposed = true;
      modelsReady.current = true;
      useDesignStore.getState().setRealisticModels(prev);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prefetch the realistic-model GLBs in the background while the ~74 s
  // camera path plays, WITHOUT flipping the realistic toggle: the showcase's
  // reveal segment then finds them already in drei's GLTF cache, so a cold
  // cache over a slow connection no longer pops in half-loaded models when
  // the 15 s waitForSceneReady hold runs out. useGLTF.preload uses the exact
  // same loader/cache as the ModelInstances useGLTF(url) calls, so this is a
  // pure warm-up — no scene change, no extra memory beyond the eventual
  // load, and no network cost when the tour is never started (this component
  // mounts only while a tour is active). (configId is subscribed above for
  // the intro title card.)
  useEffect(() => {
    const pcsUrl = inverterModelUrl(getConfiguration(configId)?.inverterModel);
    const urls = new Set<string>([...Object.values(MODEL_URLS), pcsUrl]);
    urls.forEach(url => useGLTF.preload(url));
  }, [configId]);

  // A design with no usable path (no fence) can't play: exit immediately.
  useEffect(() => {
    if (!sampler) stopTour();
  }, [sampler, stopTour]);

  // Save pose on entry, restore on exit (finish, Esc, click, view switch).
  useEffect(() => {
    saved.current = {
      pos: camera.position.clone(),
      quat: camera.quaternion.clone(),
      target: controls?.target ? controls.target.clone() : null,
    };
    t.current = 0;
    invalidate();
    return () => {
      const s = saved.current;
      if (!s) return;
      camera.position.copy(s.pos);
      camera.quaternion.copy(s.quat);
      if (controls?.target && s.target) {
        controls.target.copy(s.target);
        controls.update?.();
      }
      invalidate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc or a click anywhere ends the tour (the plan's "stop" affordances).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') stopTour();
    };
    const onPointer = () => stopTour();
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [stopTour]);

  useFrame((st, delta) => {
    if (!sampler) return;
    const seek = useDesignStore.getState().tourSeek;
    if (seek !== null) {
      // Visual-test hook: hold a fixed progress; still repaint on demand.
      t.current = Math.min(1, Math.max(0, seek));
    } else if (modelsReady.current) {
      // Clamp delta: a background-tab stall must not teleport the camera.
      t.current = Math.min(1, t.current + Math.min(delta, 0.1) / sampler.duration);
    }
    // While the realistic-flight gate holds, the camera parks on the opening
    // pose (t stays 0) until the GLBs settle.
    const { pos, target } = sampler.sample(t.current);
    camera.position.copy(pos);
    camera.lookAt(target);
    // Keep the orbit target in sync so the hand-off back to OrbitControls
    // (on stop) doesn't snap.
    if (controls?.target) controls.target.copy(target);
    // Final flyover: force the grounding grid overlay on for the pull-up so
    // the buried loop/grid reads under the yard. Transient store flag only —
    // the drafter's own grounding toggle is never touched, and stopping the
    // tour (any path) clears it.
    const store = useDesignStore.getState();
    const wantGrid = sampler.pullStartT !== null && t.current >= sampler.pullStartT;
    if (store.tourGrounding !== wantGrid) store.setTourGrounding(wantGrid);
    // Close-up hold: live DC reroute beat + white fade-up back into the
    // drive. Both are pure functions of tour progress (seek-friendly) and
    // transient store flags only — the drafter's dcRouting is never touched
    // and stopping the tour (any path) clears them.
    const cu = sampler.closeup;
    if (cu) {
      const len = Math.max(cu.holdEndT - cu.holdStartT, 1e-6);
      const s0 = cu.holdStartT + len * 0.25; // settle top-down before the swap
      const s1 = cu.holdStartT + len * 0.75; // fully re-routed while holding
      // Restore the drafter's routing at the fade peak (covered by white).
      const swap = t.current >= cu.holdEndT
        ? 0
        : Math.min(1, Math.max(0, (t.current - s0) / Math.max(s1 - s0, 1e-6)));
      store.setTourDcSwap(swap);
      const f0 = cu.holdEndT - CLOSEUP_FADE_LEAD; // fade to white at the end of the hold
      const f1 = cu.holdEndT + CLOSEUP_FADE_TAIL; // fade back out as the drive resumes
      let fade = 0;
      if (t.current >= f0 && t.current <= f1) {
        fade = t.current < cu.holdEndT
          ? (t.current - f0) / Math.max(cu.holdEndT - f0, 1e-6)
          : 1 - (t.current - cu.holdEndT) / Math.max(f1 - cu.holdEndT, 1e-6);
      }
      store.setTourFade(fade);
      // Reroute-beat caption: on for the whole top-down hold, cleared when
      // the white fade starts. Drawn on the recorder-captured overlay canvas
      // (TourFadeOverlay) so it lands in the exported video.
      const caption = t.current >= cu.holdStartT && t.current < f0
        ? 'Live DC routing comparison — orthogonal vs direct'
        : null;
      if (store.tourCaption !== caption) store.setTourCaption(caption);
    }
    // Title intro over the opening orbit: progress is a pure function of
    // normalized tour time (seek/cancel-safe); the overlay stages the text
    // reveals from this single scalar.
    const introP = tourOptions.intro !== false ? introProgressAt(t.current) : 0;
    store.setTourIntroT(introP);
    const wantIntro = introP > 0 ? introInfo : null;
    if (store.tourIntroInfo !== wantIntro) store.setTourIntroInfo(wantIntro);
    // Feeder fly-along island stat card: eased fade in/out driven purely by
    // normalized tour time inside the arrival-hold window (seek/cancel-safe;
    // stopping the tour clears both transients on any path).
    const fa = sampler.flyalong;
    if (fa) {
      const len = Math.max(fa.holdEndT - fa.holdStartT, 1e-6);
      const inK = (t.current - fa.holdStartT) / (len * 0.22);
      const outK = (fa.holdEndT - t.current) / (len * 0.28);
      const alpha = t.current >= fa.holdStartT && t.current <= fa.holdEndT
        ? Math.min(1, Math.max(0, Math.min(inK, outK)))
        : 0;
      store.setTourStatAlpha(alpha);
      const want = alpha > 0 ? statCard : null;
      if (store.tourStatCard !== want) store.setTourStatCard(want);
      // Future-PCS ghost outlines share the hold window and the same pure
      // fade function of tour time (seek/cancel-safe).
      store.setTourGhostAlpha(ghosts.length ? alpha : 0);
      const wantGhosts = alpha > 0 && ghosts.length ? ghosts : null;
      if (store.tourGhosts !== wantGhosts) store.setTourGhosts(wantGhosts);
    } else {
      // Route invalidated mid-tour (feeders cleared/re-routed): tear the
      // card down instead of leaving a stale overlay on screen.
      if (store.tourStatAlpha !== 0) store.setTourStatAlpha(0);
      if (store.tourStatCard !== null) store.setTourStatCard(null);
      if (store.tourGhostAlpha !== 0) store.setTourGhostAlpha(0);
      if (store.tourGhosts !== null) store.setTourGhosts(null);
    }
    if (seek === null && t.current >= 1) {
      // Finished: adopt the final overview pose as the restore pose so the
      // bookend ending IS where the drafter lands (no jump), then hand off
      // to the scripted showcase segment (CAD → plot → BOM → SLD).
      saved.current = {
        pos: camera.position.clone(),
        quat: camera.quaternion.clone(),
        target: controls?.target ? controls.target.clone() : null,
      };
      store.finishTourPath();
      return;
    }
    st.invalidate(); // demand frameloop: keep the tour animating
  });

  return null;
}
