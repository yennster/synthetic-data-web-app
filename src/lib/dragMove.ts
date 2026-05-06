import type { ThreeEvent } from '@react-three/fiber';
import { useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * Build pointer-event handlers for moving objects in 3D with the mouse.
 *
 * Modifier matrix:
 *   Shift + drag                            → camera-aligned plane
 *                                             (full XYZ via orbit)
 *   Shift + (Alt|Option|Ctrl|Cmd) + drag    → depth mode: cursor's vertical
 *                                             motion pushes the object along
 *                                             the camera's gaze. Cursor up =
 *                                             closer, cursor down = farther.
 *                                             Press/release the modifier
 *                                             freely mid-drag — the gesture
 *                                             re-anchors so there's no snap.
 *   Shift + drag + wheel                    → push/pull along camera gaze
 *                                             (mouse-only shortcut)
 *
 * Mac note: Alt and Option are the same physical key. We also accept Ctrl
 * and Cmd as depth modifiers so it doesn't matter which one the user
 * reaches for first.
 *
 * Plane intersection: at drag-start we drop a plane through the object
 * that's perpendicular to the camera's gaze direction. The pointer ray is
 * intersected with that plane each move, giving a 3D world point that
 * tracks under the cursor.
 *
 * Components with physics bodies should pass onDragStart/onDragEnd to flip
 * the body to kinematic during the drag, otherwise gravity integrates
 * between pointer samples and the object visibly drops between cursor
 * updates.
 *
 * Without the Shift modifier, OrbitControls keeps working as normal.
 */

// Wheel sensitivity. Values around 0.008 give:
//   trackpad two-finger scroll (deltaY ≈ 4 per event) → ~1 m/s
//   mouse wheel notch (deltaY ≈ 100 per notch)        → ~0.8 m/notch
const WHEEL_STEP = 0.008;

export function useDragMove(opts: {
  /** Read current world position of the dragged object. */
  getPosition: () => [number, number, number];
  /** Apply a new position. */
  setPosition: (p: [number, number, number]) => void;
  /** When true, the modifier is active and dragging is allowed. */
  enabled?: boolean;
  /** Called once when a drag actually starts (after modifier check). Components
   * with physics bodies use this to switch the body to kinematic so gravity
   * doesn't pull it down between drag samples. */
  onDragStart?: () => void;
  /** Called once when the drag releases. */
  onDragEnd?: () => void;
}): {
  onPointerDown: (e: ThreeEvent<PointerEvent>) => void;
  onPointerMove: (e: ThreeEvent<PointerEvent>) => void;
  onPointerUp: (e: ThreeEvent<PointerEvent>) => void;
} {
  const { getPosition, setPosition, enabled = true, onDragStart, onDragEnd } = opts;
  const dragging = useRef(false);
  const planeNormal = useRef(new THREE.Vector3());
  const planePoint = useRef(new THREE.Vector3());
  const offset = useRef(new THREE.Vector3());
  const captureTarget = useRef<HTMLElement | null>(null);
  const wheelHandlerRef = useRef<((e: WheelEvent) => void) | null>(null);
  // Depth-mode (Alt-held) state. We track when Alt transitions on/off so we
  // can re-anchor the in-plane offset and avoid snap on release.
  const altActive = useRef(false);
  const lastClientY = useRef(0);
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
    onDragStart?.();

    // Pointer capture so cursor motion is delivered even if the cursor
    // leaves the mesh's bounds.
    const tgt = e.target as HTMLElement | null;
    if (tgt && typeof tgt.setPointerCapture === 'function') {
      try {
        tgt.setPointerCapture(e.pointerId);
        captureTarget.current = tgt;
      } catch {
        // ignore
      }
    }

    // Window-level wheel listener for the duration of the drag. Translates
    // the object along the camera's gaze direction; works for mouse wheel,
    // trackpad two-finger scroll, and trackpad pinch (which also produces
    // wheel events with ctrlKey set).
    const handler = (we: WheelEvent) => {
      if (!dragging.current) return;
      we.preventDefault();
      we.stopPropagation();
      // Some browsers/trackpads report deltaY in line units (deltaMode=1)
      // or page units (deltaMode=2); normalise to pixels.
      const dyPx =
        we.deltaMode === 1
          ? we.deltaY * 16
          : we.deltaMode === 2
            ? we.deltaY * 100
            : we.deltaY;
      const step = dyPx * WHEEL_STEP;
      // Shift the drag plane along its normal and translate the object by
      // the same amount, so the plane and the object stay in sync. Future
      // pointermove events keep tracking correctly without snapping.
      planePoint.current.addScaledVector(planeNormal.current, step);
      const c = getPosition();
      setPosition([
        c[0] + planeNormal.current.x * step,
        c[1] + planeNormal.current.y * step,
        c[2] + planeNormal.current.z * step,
      ]);
    };
    wheelHandlerRef.current = handler;
    window.addEventListener('wheel', handler, { passive: false });
  };

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!dragging.current) return;
    e.stopPropagation();
    // Treat Alt/Option, Ctrl, and Cmd all as the depth modifier so Mac
    // users have a working key regardless of which they reach for.
    // Windows/Linux users keep Alt as before.
    const altNow = e.altKey || e.ctrlKey || e.metaKey;
    const cy = e.nativeEvent.clientY;

    // --- mode transitions ---
    if (altNow && !altActive.current) {
      // Alt just pressed: enter depth mode. Snapshot the current cursor Y
      // so subsequent moves can compute a delta. Don't move the object on
      // the transition frame — it would snap.
      altActive.current = true;
      lastClientY.current = cy;
      return;
    }
    if (!altNow && altActive.current) {
      // Alt just released: re-anchor the drag plane and offset to the
      // object's current position so subsequent in-plane motion picks up
      // smoothly without snapping back to where the drag started.
      altActive.current = false;
      const cur = getPosition();
      planePoint.current.set(cur[0], cur[1], cur[2]);
      const hit = intersect(e.ray);
      if (hit) {
        offset.current.set(cur[0] - hit.x, cur[1] - hit.y, cur[2] - hit.z);
      }
      return;
    }

    if (altNow) {
      // Depth mode: cursor's vertical screen motion pushes the object along
      // the camera's gaze direction. Up = closer (toward viewer), down =
      // farther. ~1m per 100px of cursor motion.
      const dy = cy - lastClientY.current;
      lastClientY.current = cy;
      const step = dy * 0.01;
      planePoint.current.addScaledVector(planeNormal.current, step);
      const c = getPosition();
      setPosition([
        c[0] + planeNormal.current.x * step,
        c[1] + planeNormal.current.y * step,
        c[2] + planeNormal.current.z * step,
      ]);
      return;
    }

    // Plain in-plane drag.
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
    altActive.current = false;
    if (controls) (controls as unknown as { enabled: boolean }).enabled = true;
    onDragEnd?.();

    if (wheelHandlerRef.current) {
      window.removeEventListener('wheel', wheelHandlerRef.current);
      wheelHandlerRef.current = null;
    }

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
