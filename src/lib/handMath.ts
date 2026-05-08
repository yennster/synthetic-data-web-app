// Pure math used by hand tracking — no MediaPipe runtime imports, so this
// module is safe to test in a Node environment. The MediaPipe-dependent
// loader lives in handTracking.ts and re-exports these helpers.

/** Minimal landmark shape: just what the math needs. MediaPipe's
 * NormalizedLandmark is a superset. */
export type Landmark = { x: number; y: number; z?: number };

/**
 * Pinch strength based on thumb-tip (4) vs index-tip (8) distance, normalized
 * by hand size (wrist 0 to middle MCP 9). 0 = open hand, 1 = closed pinch.
 */
export function computePinchStrength(lm: readonly Landmark[]): number {
  const t = lm[4];
  const i = lm[8];
  const w = lm[0];
  const mcp = lm[9];
  const dist = Math.hypot(t.x - i.x, t.y - i.y, (t.z ?? 0) - (i.z ?? 0));
  const handSize =
    Math.hypot(w.x - mcp.x, w.y - mcp.y, (w.z ?? 0) - (mcp.z ?? 0)) || 0.1;
  const ratio = dist / handSize; // ~1.0 = open, ~0.2 = pinched
  // Map: ratio 0.15 -> 1.0 (closed), 0.6 -> 0.0 (open)
  const v = 1 - (ratio - 0.15) / 0.45;
  return Math.max(0, Math.min(1, v));
}

/** Midpoint of the thumb tip (4) and index tip (8). */
export function pinchCentroid(lm: readonly Landmark[]): {
  x: number;
  y: number;
  z: number;
} {
  const t = lm[4];
  const i = lm[8];
  return {
    x: (t.x + i.x) / 2,
    y: (t.y + i.y) / 2,
    z: ((t.z ?? 0) + (i.z ?? 0)) / 2,
  };
}

/**
 * Distance from wrist (0) to middle-finger MCP (9) in image-normalized units
 * (0..1). The two landmarks both sit on the palm, so their separation is
 * roughly invariant under finger pose changes — making this a stable proxy
 * for camera-distance: hand close to camera ⇒ bigger distance.
 *
 * Used as the depth signal for moving objects in motion mode, where
 * MediaPipe's per-landmark `z` is too noisy to be useful. Typical observed
 * range is ~0.06 (arm extended) to ~0.22 (hand near the lens).
 */
export function handSize(lm: readonly Landmark[]): number {
  const w = lm[0];
  const mcp = lm[9];
  return Math.hypot(w.x - mcp.x, w.y - mcp.y);
}

export type Vec3 = readonly [number, number, number];

/**
 * Map a hand-space target (right / up / toward-camera offsets) into world
 * space, anchored at `anchor`. `right`, `up`, `back` are the world-space
 * basis vectors for those axes — typically extracted from the camera's
 * `matrixWorld`. Pure math so we can unit-test the orbit-aware mapping
 * that drives the manipulated body in motion mode.
 */
export function cameraRelativeToWorld(
  target: Vec3,
  anchor: Vec3,
  right: Vec3,
  up: Vec3,
  back: Vec3,
): [number, number, number] {
  const [tx, ty, tz] = target;
  return [
    anchor[0] + right[0] * tx + up[0] * ty + back[0] * tz,
    anchor[1] + right[1] * tx + up[1] * ty + back[1] * tz,
    anchor[2] + right[2] * tx + up[2] * ty + back[2] * tz,
  ];
}
