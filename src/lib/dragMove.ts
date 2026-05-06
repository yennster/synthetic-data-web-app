import type { ThreeEvent } from '@react-three/fiber';
import { useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * Build pointer-event handlers that let the user drag a mesh on the
 * horizontal plane at its current Y. Activated by Shift+click+drag — without
 * the modifier, OrbitControls keeps working as normal.
 *
 * Optional `setY` is passed when the asset position has a Y component the
 * user might want to adjust with Alt+Shift+drag (vertical mode). For now
 * the basic case is XZ on the object's current Y.
 *
 * The hook keeps the drag plane Y at the value at drag-start so the object
 * doesn't snap to the ground when released — it just tracks the cursor's
 * intersection with the plane.
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
  const planeY = useRef(0);
  const offset = useRef(new THREE.Vector3());
  const captureTarget = useRef<HTMLElement | null>(null);
  const { controls } = useThree();

  const intersectPlane = (e: ThreeEvent<PointerEvent>): THREE.Vector3 | null => {
    const ray = e.ray;
    const dy = ray.direction.y;
    if (Math.abs(dy) < 1e-6) return null;
    const t = (planeY.current - ray.origin.y) / dy;
    if (t < 0) return null;
    return ray.origin.clone().addScaledVector(ray.direction, t);
  };

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (!enabled) return;
    if (!e.shiftKey) return;
    e.stopPropagation();
    const cur = getPosition();
    planeY.current = cur[1];
    const hit = intersectPlane(e);
    if (!hit) return;
    // Offset between the object's centre and the click point so the object
    // doesn't jump under the cursor on first move.
    offset.current.set(cur[0] - hit.x, 0, cur[2] - hit.z);
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
    const hit = intersectPlane(e);
    if (!hit) return;
    setPosition([
      hit.x + offset.current.x,
      planeY.current,
      hit.z + offset.current.z,
    ]);
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
