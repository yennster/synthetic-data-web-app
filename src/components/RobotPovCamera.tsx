import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { captureFrame } from '../lib/capture';
import {
  createReadbackBlitState,
  ensureReadbackBlitState,
  putFlippedReadback,
  resetReadbackBlitState,
} from '../lib/readbackBlit';
import { resolveRobotCapture } from '../lib/robotCapture';
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
  // useFrame polls `useStore.getState().robotCaptureSignal` each tick;
  // we don't subscribe through the hook so a bump doesn't unnecessarily
  // re-render the bridge. Initialize the "already handled" watermark to
  // whatever the store currently has so we don't replay a stale bump
  // that happened before this component mounted.
  const lastHandledCaptureSignal = useRef(
    useStore.getState().robotCaptureSignal,
  );

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

    // Object-detection capture handoff: if the runner asked for a
    // snapshot since our last tick, render it at the configured output
    // resolution and hand the blob + bounding boxes back through the
    // `lib/robotCapture` Promise queue. We do this with the POV
    // camera *after* it has been re-aimed for this frame so the
    // capture matches what the user sees in the preview.
    const liveSignal = useStore.getState().robotCaptureSignal;
    if (liveSignal !== lastHandledCaptureSignal.current) {
      lastHandledCaptureSignal.current = liveSignal;
      // The PerspectiveCamera's aspect is currently bound to the preview
      // canvas; the offscreen capture renderer in `captureFrame` will
      // briefly override it to match `width / height` and restore after.
      const { robot } = useStore.getState();
      const width = robot.objectDetectionWidth;
      const height = robot.objectDetectionHeight;
      // Hide every node tagged `userData.hideForCapture` (e.g. the
      // rover's lidar/ToF beam overlay) so the rendered PNG shows the
      // physical scene as a real onboard camera would — no debug
      // graphics burned into the training data. We restore visibility
      // unconditionally after the toBlob settles. Live preview is
      // unaffected because we toggle visibility only across the
      // single synchronous `captureFrame` render call.
      const hidden: THREE.Object3D[] = [];
      scene.traverse((obj) => {
        if (obj.userData?.hideForCapture && obj.visible) {
          obj.visible = false;
          hidden.push(obj);
        }
      });
      const restore = () => {
        for (const o of hidden) o.visible = true;
      };
      // Don't await — useFrame must stay synchronous. Capture runs in
      // its own microtask; resolveRobotCapture fires when toBlob lands.
      void captureFrame({
        renderer: gl as THREE.WebGLRenderer,
        scene,
        camera,
        width,
        height,
      })
        .then(({ blob, boxes }) => {
          restore();
          resolveRobotCapture({ blob, boxes, width, height });
        })
        .catch(() => {
          restore();
          resolveRobotCapture(null);
        });
    }

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
