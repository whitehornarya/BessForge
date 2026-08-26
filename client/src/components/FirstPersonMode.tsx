import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { SiteDesign } from '../lib/nextera/types';
import { useDesignStore } from '../lib/stores/useDesignStore';
import {
  buildWalkWorld,
  gateSpawn,
  stepWalk,
  eyeHeight,
  WalkState,
  WalkInput,
} from '../lib/walkthrough';

// First-person walkthrough camera: places the engineer just outside the gate
// facing into the yard, then walks the ground plane with WASD / arrow keys
// (Shift = jog) and pointer-lock mouse look. Collides with the fence (except
// the gate opening) and every piece of equipment; slides along surfaces.
// 3D preview only — no effect on layout math or DXF/PDF exports.

const MOUSE_SENS = 0.0022;    // rad per px
const MAX_PITCH = 1.45;       // rad, keep horizon sane

const KEY_MAP: Record<string, keyof WalkInput> = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
};

export default function FirstPersonMode({ design }: { design: SiteDesign }) {
  const camera = useThree(s => s.camera);
  const gl = useThree(s => s.gl);
  const setWalkMode = useDesignStore(s => s.setWalkMode);

  const world = useMemo(() => buildWalkWorld(design), [design]);
  const spawn = useMemo(() => gateSpawn(design), [design]);

  const state = useRef<WalkState | null>(null);
  const pitch = useRef(0);
  const input = useRef<WalkInput>({ forward: false, back: false, left: false, right: false, sprint: false });
  const saved = useRef<{ pos: THREE.Vector3; quat: THREE.Quaternion } | null>(null);

  // Enter: save the orbit camera pose, drop to the gate. Exit: restore.
  useEffect(() => {
    if (!spawn) { setWalkMode(false); return; }
    saved.current = { pos: camera.position.clone(), quat: camera.quaternion.clone() };
    state.current = { x: spawn.x, y: spawn.y, vx: 0, vy: 0, yaw: spawn.yaw, bobPhase: 0 };
    pitch.current = 0;
    const prevNear = camera.near;
    camera.near = 0.5; // human-scale near plane so railings/gate don't clip
    camera.updateProjectionMatrix();
    return () => {
      if (saved.current) {
        camera.position.copy(saved.current.pos);
        camera.quaternion.copy(saved.current.quat);
      }
      camera.near = prevNear;
      camera.updateProjectionMatrix();
      if (document.pointerLockElement) document.exitPointerLock();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard: window-level so it works with or without pointer lock.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const k = KEY_MAP[e.code];
      if (k) { input.current[k] = true; e.preventDefault(); }
      if (e.code === 'Escape' && !document.pointerLockElement) setWalkMode(false);
    };
    const up = (e: KeyboardEvent) => {
      const k = KEY_MAP[e.code];
      if (k) input.current[k] = false;
    };
    const clearInput = () => {
      input.current.forward = false;
      input.current.back = false;
      input.current.left = false;
      input.current.right = false;
      input.current.sprint = false;
    };
    const onVisibility = () => { if (document.hidden) clearInput(); };
    const onLockChange = () => { if (!document.pointerLockElement) clearInput(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clearInput);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('pointerlockchange', onLockChange);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clearInput);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('pointerlockchange', onLockChange);
    };
  }, [setWalkMode]);

  // Pointer lock mouse look: click the canvas to grab the mouse.
  useEffect(() => {
    const el = gl.domElement;
    const requestLock = () => {
      if (!document.pointerLockElement) el.requestPointerLock?.();
    };
    const onMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== el || !state.current) return;
      state.current.yaw -= e.movementX * MOUSE_SENS;
      pitch.current = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch.current - e.movementY * MOUSE_SENS));
    };
    el.addEventListener('click', requestLock);
    document.addEventListener('mousemove', onMove);
    // grab immediately if we entered from a button click gesture
    requestLock();
    return () => {
      el.removeEventListener('click', requestLock);
      document.removeEventListener('mousemove', onMove);
    };
  }, [gl]);

  useFrame((st, delta) => {
    const s = state.current;
    if (!s) return;
    st.invalidate(); // demand frameloop: walk mode animates continuously
    state.current = stepWalk(s, input.current, delta, world);
    const ns = state.current;
    camera.position.set(ns.x, eyeHeight(ns), -ns.y);
    // plan yaw (CCW from +x) -> three Y rotation (camera looks down -z at 0)
    camera.rotation.order = 'YXZ';
    camera.rotation.y = ns.yaw - Math.PI / 2;
    camera.rotation.x = pitch.current;
    camera.rotation.z = 0;
  });

  return null;
}
