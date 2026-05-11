import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import {
  createReadbackBlitState,
  ensureReadbackBlitState,
  putFlippedReadback,
  resetReadbackBlitState,
} from '../lib/readbackBlit';
import { useStore } from '../store/useStore';

/**
 * First-person preview camera for the robotics rigs. Mounts via
 * named scene-graph nodes:
 *
 *   - **rover**  `rover-pov-mount` (front bumper, chassis height)
 *                + `rover-pov-look` (1 m forward target)
 *   - **arm**    `arm-pov-mount`   (gripper carrier)
 *                + `arm-pov-look`  (8 cm past the gripper tip)
 *
 * Each frame we walk the scene by name, copy the mount's world
 * transform onto the camera, and aim it at the look anchor's world
 * position. This avoids re-deriving forward kinematics from joint
 * angles in this component — the previous arm-side math had a sign
 * error that put the camera inside the base column and rendered the
 * arm from below. Reading the actual transforms is robust to any
 * future rig changes too.
 *
 * Renders into the offscreen `previewTarget`, then blits the pixel
 * buffer to the overlay canvas. ~15 Hz to keep GPU work modest.
 */
const PREVIEW_HZ = 15;
const PREVIEW_INTERVAL_MS = 1000 / PREVIEW_HZ;
const FOV_DEG = 70;

export function RobotPovCamera({
  previewCanvas,
}: {
  previewCanvas: HTMLCanvasElement | null;
}) {
  const { gl, scene } = useThree();
  const robotKind = useStore((s) => s.robot.kind);
  const armCameraMount = useStore((s) => s.robot.armCameraMount);

  const camera = useMemo(() => {
    const c = new THREE.PerspectiveCamera(FOV_DEG, 4 / 3, 0.02, 50);
    return c;
  }, []);

  const previewTarget = useMemo(() => {
    const t = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      colorSpace: THREE.SRGBColorSpace,
    });
    return t;
  }, []);
  const readback = useRef(createReadbackBlitState());
  const previewCtx = useRef<CanvasRenderingContext2D | null>(null);
  const previewCtxCanvas = useRef<HTMLCanvasElement | null>(null);
  const lastPreviewMs = useRef(0);

  useEffect(() => {
    return () => {
      previewTarget.dispose();
    };
  }, [previewTarget]);

  useEffect(() => {
    if (!previewCanvas) return;
    const w = Math.max(1, previewCanvas.width);
    const h = Math.max(1, previewCanvas.height);
    previewTarget.setSize(w, h);
    resetReadbackBlitState(readback.current);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }, [previewCanvas, previewTarget, camera]);

  // Pre-allocated scratch vectors — useFrame is hot.
  const mountPos = useMemo(() => new THREE.Vector3(), []);
  const lookPos = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    if (!previewCanvas) return;
    const now = performance.now();
    if (now - lastPreviewMs.current < PREVIEW_INTERVAL_MS) return;
    lastPreviewMs.current = now;

    const canvasW = Math.max(1, previewCanvas.width);
    const canvasH = Math.max(1, previewCanvas.height);
    if (previewTarget.width !== canvasW || previewTarget.height !== canvasH) {
      previewTarget.setSize(canvasW, canvasH);
      resetReadbackBlitState(readback.current);
      camera.aspect = canvasW / canvasH;
      camera.updateProjectionMatrix();
    }

    const mountName =
      robotKind === 'rover'
        ? 'rover-pov-mount'
        : `arm-pov-${armCameraMount}`;
    const lookName =
      robotKind === 'rover'
        ? 'rover-pov-look'
        : `arm-pov-${armCameraMount}-look`;
    const mount = scene.getObjectByName(mountName);
    const look = scene.getObjectByName(lookName);
    if (!mount || !look) return;

    mount.getWorldPosition(mountPos);
    look.getWorldPosition(lookPos);
    camera.position.copy(mountPos);
    camera.lookAt(lookPos);

    const prevTarget = gl.getRenderTarget();
    try {
      gl.setRenderTarget(previewTarget);
      gl.render(scene, camera);
    } finally {
      gl.setRenderTarget(prevTarget);
    }

    const w = previewTarget.width;
    const h = previewTarget.height;
    if (previewCtxCanvas.current !== previewCanvas) {
      previewCtxCanvas.current = previewCanvas;
      previewCtx.current = previewCanvas.getContext('2d');
      resetReadbackBlitState(readback.current);
    }
    const ctx = previewCtx.current;
    if (!ctx) return;
    if (previewCanvas.width !== w || previewCanvas.height !== h) {
      previewCanvas.width = w;
      previewCanvas.height = h;
      resetReadbackBlitState(readback.current);
    }
    const pixels = ensureReadbackBlitState(readback.current, ctx, w, h);
    gl.readRenderTargetPixels(previewTarget, 0, 0, w, h, pixels);
    putFlippedReadback(ctx, readback.current);
  });

  return null;
}
