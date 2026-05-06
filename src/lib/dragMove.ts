import type { ThreeEvent } from '@react-three/fiber';
import { useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * Build pointer-event handlers that let the user drag a mesh anywhere in
 * 3D world space using a single Shift+drag gesture.
 *
 * Plane intersection: at drag-start we drop a plane through the object that's
 * perpendicular to the camera's gaze direction. The pointer ray is intersected
 * with that plane each move, giving a 3D world point that tracks under the
 * cursor.
 *
 * Result:
 *   - Cursor right → object moves along camera's right
 *   - Cursor up    → object moves along camera's up
 *   - Mouse wheel  → object moves along camera's gaze (closer / farther)
 *
 * Combine with orbit and you have full XYZ control without ever leaving the
 * Shift+drag gesture: orbit to expose the axis you want, drag for the
 * in-plane component, scroll for the depth component.
 *
 * Without the Shift modifier, OrbitControls keeps working as normal — wheel
 * is its zoom, drag is its orbit/pan.
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
  onWheel: (e: ThreeEvent<WheelEvent>) => void;
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

    // Plane normal = camera forward (so the plane faces the camera),
    // passing through the object's current position.
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

  /**
   * While a drag is in progress, scrolling the mouse wheel pushes the drag
   * plane along the camera's gaze direction. The cursor keeps hitting the
   * plane in the same screen-space position, so the object slides forward
   * (away from camera) or backward (toward camera) by exactly the plane
   * shift. Combined with cursor motion you get a full 3DOF translation
   * gesture without ever leaving Shift+drag.
   *
   * Scroll up   = deltaY < 0 = object moves toward the camera (closer)
   * Scroll down = deltaY > 0 = object moves away from the camera (farther)
   */
  const onWheel = (e: ThreeEvent<WheelEvent>) => {
    if (!dragging.current) return;
    e.stopPropagation();
    e.nativeEvent.preventDefault?.();

    // 0.003 per pixel of deltaY → ~0.3m per typical wheel notch (deltaY≈100).
    const step = e.nativeEvent.deltaY * 0.003;
    planePoint.current.addScaledVector(planeNormal.current, step);

    const hit = intersect(e.ray);
    if (!hit) return;
    setPosition([
      hit.x + offset.current.x,
      hit.y + offset.current.y,
      hit.z + offset.current.z,
    ]);
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onWheel,
  };
}
