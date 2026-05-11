import type { BoundingBox } from '../store/useStore';

/**
 * Module-level handoff between the procedural robot runner (which lives
 * outside the R3F canvas, in `RobotPanel`) and the in-canvas POV camera
 * bridge that actually has access to `gl`, `scene`, and the POV
 * PerspectiveCamera (`RobotPovCamera`).
 *
 * The runner needs to capture a frame at specific instants during a
 * trajectory (mid-motion + optionally at-rest). React state can't make
 * that synchronous on its own, so:
 *
 *   1. Runner calls `awaitRobotCapture()` to get a Promise.
 *   2. Runner bumps `robotCaptureSignal` in the store.
 *   3. The bridge component sees the bump on its next `useFrame`, renders
 *      a fresh frame to an offscreen target, and calls `resolveRobotCapture`
 *      with the resulting blob + bounding boxes.
 *   4. Runner's Promise resolves and it can push the result into the
 *      EI upload / local-download bucket.
 *
 * Only one capture can be in flight at a time. The runner serializes its
 * captures per iteration so that's a natural fit.
 */

export type RobotCaptureResult = {
  blob: Blob;
  boxes: BoundingBox[];
  width: number;
  height: number;
};

let pendingResolver: ((c: RobotCaptureResult | null) => void) | null = null;

export function awaitRobotCapture(): Promise<RobotCaptureResult | null> {
  // If a previous capture is still pending (e.g. the bridge missed a
  // signal because the R3F canvas was unmounted), resolve it with null
  // so the previous awaiter doesn't hang.
  pendingResolver?.(null);
  return new Promise((resolve) => {
    pendingResolver = resolve;
  });
}

export function resolveRobotCapture(c: RobotCaptureResult | null): void {
  const resolver = pendingResolver;
  pendingResolver = null;
  resolver?.(c);
}

export function hasPendingRobotCapture(): boolean {
  return pendingResolver !== null;
}
