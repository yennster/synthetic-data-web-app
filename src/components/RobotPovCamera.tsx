import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { BRACCIO_LINKS } from '../lib/braccio';
import { useStore } from '../store/useStore';

/**
 * First-person preview camera for the robotics rigs. Mirrors the
 * detection-mode `VirtualCamera` pattern (offscreen render target →
 * 2D readback to an overlay canvas) but with the camera parented to a
 * mount point on the active rig:
 *
 *   - **rover**  front bumper, looking along the chassis +Z heading.
 *                Matches the typical "FPV rover camera" placement on
 *                Arduino-class rovers (a single forward-facing module
 *                bolted to the deck just behind the bumper).
 *   - **arm**    wrist-mounted, looking past the gripper. Matches
 *                pick-and-place setups where a small camera is stuck
 *                to the gripper carrier.
 *
 * The component is purely a *preview* — it doesn't write data to EI
 * yet; that capture path lives in the next iteration. Live preview is
 * useful on its own because it shows what the recorded vision data
 * would look like, lets the user spot framing issues, and gives the
 * scene a "robot's-eye" overlay that reads as an ML demo.
 */
const PREVIEW_HZ = 15;
const PREVIEW_INTERVAL_MS = 1000 / PREVIEW_HZ;
const FOV_DEG = 70; // matches a typical Arduino FPV camera FOV

export function RobotPovCamera({
  previewCanvas,
}: {
  previewCanvas: HTMLCanvasElement | null;
}) {
  const { gl, scene } = useThree();
  const robotKind = useStore((s) => s.robot.kind);
  const roverPose = useStore((s) => s.roverPose);
  const armJoints = useStore((s) => s.armJoints);

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
  const pixelBuf = useRef<Uint8Array | null>(null);
  const lastPreviewMs = useRef(0);

  // Resize the offscreen target when the overlay canvas changes size.
  useEffect(() => {
    if (!previewCanvas) return;
    const w = Math.max(1, previewCanvas.width);
    const h = Math.max(1, previewCanvas.height);
    previewTarget.setSize(w, h);
    pixelBuf.current = new Uint8Array(w * h * 4);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }, [previewCanvas, previewTarget, camera]);

  useFrame(() => {
    if (!previewCanvas) return;
    const now = performance.now();
    if (now - lastPreviewMs.current < PREVIEW_INTERVAL_MS) return;
    lastPreviewMs.current = now;

    // Position the camera each frame at the active rig's mount point.
    if (robotKind === 'rover') {
      const pose = roverPose ?? { x: 0, z: 0, heading: 0 };
      // Mount: front of chassis, ~head height. Look along heading.
      const headY = 0.12 + 0.05 + 0.18 + 0.18 / 2;
      const forwardX = Math.sin(pose.heading);
      const forwardZ = Math.cos(pose.heading);
      camera.position.set(
        pose.x + forwardX * 0.36,
        headY,
        pose.z + forwardZ * 0.36,
      );
      camera.lookAt(pose.x + forwardX * 5, headY * 0.4, pose.z + forwardZ * 5);
    } else {
      // Arm POV: position roughly at the wrist roll's tip, looking
      // forward along the gripper. We re-derive the world pose from
      // the joint vector — cheap and self-contained, no scene-graph
      // walks required.
      const j = armJoints ?? [
        Math.PI / 2,
        Math.PI / 2,
        Math.PI / 2,
        Math.PI / 2,
        Math.PI / 2,
        0.5,
      ];
      const L = BRACCIO_LINKS;
      const yaw = j[0];
      const sh = j[1];
      const el = j[2];
      const wp = j[3];
      const baseHeight = L.plateThickness + L.base;
      const ux = Math.sin(sh) * L.shoulder;
      const uy = Math.cos(sh) * L.shoulder;
      const elbowAngle = sh + el;
      const fx = ux + Math.sin(elbowAngle) * L.elbow;
      const fy = uy + Math.cos(elbowAngle) * L.elbow;
      const wristAngle = elbowAngle + wp;
      const wx = fx + Math.sin(wristAngle) * L.wristPitch;
      const wy = fy + Math.cos(wristAngle) * L.wristPitch;
      // Rotate (wx, baseHeight + wy) into world via base yaw.
      const camX = Math.sin(yaw) * wx;
      const camY = baseHeight + wy + L.wristRoll;
      const camZ = Math.cos(yaw) * wx;
      camera.position.set(camX, camY, camZ);
      // Look along the cumulative pitch direction in the rotated plane.
      const lookR = wx + Math.sin(wristAngle) * 0.4;
      const lookY = baseHeight + wy + Math.cos(wristAngle) * 0.4;
      camera.lookAt(Math.sin(yaw) * lookR, lookY, Math.cos(yaw) * lookR);
    }

    // Render scene from the POV camera into the offscreen target,
    // then blit pixels to the overlay canvas via getContext('2d').
    const prevTarget = gl.getRenderTarget();
    gl.setRenderTarget(previewTarget);
    gl.render(scene, camera);
    gl.setRenderTarget(prevTarget);

    const w = previewTarget.width;
    const h = previewTarget.height;
    const buf = pixelBuf.current ?? new Uint8Array(w * h * 4);
    pixelBuf.current = buf;
    gl.readRenderTargetPixels(previewTarget, 0, 0, w, h, buf);

    const ctx = previewCanvas.getContext('2d');
    if (!ctx) return;
    // Flip vertically — WebGL origin is bottom-left, canvas is top-left.
    const flipped = new Uint8ClampedArray(buf.length);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4;
      const dst = y * w * 4;
      flipped.set(buf.subarray(src, src + w * 4), dst);
    }
    const img = new ImageData(flipped, w, h);
    if (
      previewCanvas.width !== w ||
      previewCanvas.height !== h
    ) {
      previewCanvas.width = w;
      previewCanvas.height = h;
    }
    ctx.putImageData(img, 0, 0);
  });

  return null;
}
