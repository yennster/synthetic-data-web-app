import type { ThreeEvent } from '@react-three/fiber';
import { useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * Build pointer-event handlers that let the user drag a mesh anywhere in
 * 3D world space using a single Shift+drag gesture.
 *
 * Implementation: at drag-start we drop a plane through the object that's
 * perpendicular to the camera's gaze direction. The pointer ray is then
 * intersected with that plane each move, giving a 3D world point that
 * tracks under the cursor. Result: pointer-right always moves the object
 * along the camera's local X (right of screen), pointer-up moves it along
 * the camera's local Y (up of screen). Orbit to a side view → vertical
 * mouse motion = world Y. Orbit to top-down → vertical mouse motion =
 * world Z. So the user gets all three axes by combining orbit and drag,
 * which is how every 3D viewport works.
 *
 * Without the Shift modifier, OrbitControls keeps working as normal.
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
  const planeNormal = useRef(new THREE.Vector3());
  const planePoint = useRef(new THREE.Vector3());
  const offset = useRef(new THREE.Vector3());
  const captureTarget = useRef<HTMLElement | null>(null);
  const { controls, camera } = useThree();

  /** Intersect the pointer ray with the drag plane. */
  const intersect = (ray: THREE.Ray): THREE.Vector3 | null => {
    const denom = planeNormal.current.dot(ray.direction);
    if (Math.abs(denom) < 1e-6) return null;
    const diff = planePoint.current.clone().sub(ray.origin);
    const t = planeNormal.current.dot(diff) / denom;
    if (t < 0) return null;
    return ray.origin.clone().addScaledVector(ray.direction, t);
  };

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (!enabled) return;
    if (!e.shiftKey) return;
    e.stopPropagation();
    const cur = getPosition();

    // Plane normal = camera forward (so the plane faces the camera).
    // Passing through the object's current position.
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    if (camDir.lengthSq() < 1e-6) return;
    planeNormal.current.copy(camDir);
    planePoint.current.set(cur[0], cur[1], cur[2]);

    const hit = intersect(e.ray);
    if (!hit) return;
    // Offset between cursor world point and object position so the object
    // doesn't jump under the cursor on the first move.
    offset.current.set(cur[0] - hit.x, cur[1] - hit.y, cur[2] - hit.z);

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
    const hit = intersect(e.ray);
    if (!hit) return;
    setPosition([
      hit.x + offset.current.x,
      hit.y + offset.current.y,
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
