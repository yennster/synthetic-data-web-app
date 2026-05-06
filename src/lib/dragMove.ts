import type { ThreeEvent } from '@react-three/fiber';
import { useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

type DragMode = 'xz' | 'y';

/**
 * Build pointer-event handlers that let the user drag a mesh in 3D space.
 *
 *   Shift + drag         → horizontal (XZ) at the object's current Y
 *   Shift + Alt + drag   → vertical (Y), so you can lift things up and let
 *                          physics drop them again
 *
 * Without the Shift modifier, OrbitControls keeps working as normal.
 *
 * Vertical mode uses a camera-facing vertical plane through the object so
 * cursor-up moves the object up regardless of orbit angle. The XZ stays
 * locked while Alt is held so you get pure vertical motion.
 */
export function useDragMove(opts: {
  /** Read current world position of the dragged object. */
  getPosition: () => [number, number, number];
  /** Apply a new position. */
  setPosition: (p: [number, number, number]) => void;
  /** When true, the modifier is active and dragging is allowed. */
  enabled?: boolean;
}): {
  onPointerDown: (e: ThreeEvent<PointerEvent>) => void;
  onPointerMove: (e: ThreeEvent<PointerEvent>) => void;
  onPointerUp: (e: ThreeEvent<PointerEvent>) => void;
} {
  const { getPosition, setPosition, enabled = true } = opts;
  const dragging = useRef(false);
  const mode = useRef<DragMode>('xz');
  const xzPlaneY = useRef(0);
  const vNormal = useRef(new THREE.Vector3());
  const vPoint = useRef(new THREE.Vector3());
  const offset = useRef(new THREE.Vector3());
  const captureTarget = useRef<HTMLElement | null>(null);
  const { controls, camera } = useThree();

  const intersect = (
    ray: THREE.Ray,
    m: DragMode,
  ): THREE.Vector3 | null => {
    if (m === 'xz') {
      const dy = ray.direction.y;
      if (Math.abs(dy) < 1e-6) return null;
      const t = (xzPlaneY.current - ray.origin.y) / dy;
      if (t < 0) return null;
      return ray.origin.clone().addScaledVector(ray.direction, t);
    }
    // Vertical plane — normal lies in XZ (camera-forward projected to ground).
    const denom = vNormal.current.dot(ray.direction);
    if (Math.abs(denom) < 1e-6) return null;
    const diff = vPoint.current.clone().sub(ray.origin);
    const t = vNormal.current.dot(diff) / denom;
    if (t < 0) return null;
    return ray.origin.clone().addScaledVector(ray.direction, t);
  };

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (!enabled) return;
    if (!e.shiftKey) return;
    e.stopPropagation();
    const cur = getPosition();

    if (e.altKey) {
      mode.current = 'y';
      // Plane normal: camera forward projected to the XZ plane, so the plane
      // itself is vertical and faces the camera.
      const camDir = new THREE.Vector3();
      camera.getWorldDirection(camDir);
      camDir.y = 0;
      if (camDir.lengthSq() < 1e-6) return; // top-down view; bail
      camDir.normalize();
      vNormal.current.copy(camDir);
      vPoint.current.set(cur[0], cur[1], cur[2]);
      const hit = intersect(e.ray, 'y');
      if (!hit) return;
      offset.current.set(0, cur[1] - hit.y, 0);
    } else {
      mode.current = 'xz';
      xzPlaneY.current = cur[1];
      const hit = intersect(e.ray, 'xz');
      if (!hit) return;
      offset.current.set(cur[0] - hit.x, 0, cur[2] - hit.z);
    }

    dragging.current = true;
    if (controls) (controls as unknown as { enabled: boolean }).enabled = false;
    const tgt = e.target as HTMLElement | null;
    if (tgt && typeof tgt.setPointerCapture === 'function') {
      try {
        tgt.setPointerCapture(e.pointerId);
        captureTarget.current = tgt;
      } catch {
        // ignore
      }
    }
  };

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!dragging.current) return;
    e.stopPropagation();
    const hit = intersect(e.ray, mode.current);
    if (!hit) return;
    if (mode.current === 'xz') {
      setPosition([
        hit.x + offset.current.x,
        xzPlaneY.current,
        hit.z + offset.current.z,
      ]);
    } else {
      // Y mode: keep X/Z fixed, only update Y.
      const cur = getPosition();
      setPosition([cur[0], hit.y + offset.current.y, cur[2]]);
    }
  };

  const endDrag = (e: ThreeEvent<PointerEvent>) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (controls) (controls as unknown as { enabled: boolean }).enabled = true;
    const tgt = captureTarget.current;
    if (tgt && typeof tgt.releasePointerCapture === 'function') {
      try {
        tgt.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
    captureTarget.current = null;
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
  };
}
