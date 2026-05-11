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

export type Quat = [number, number, number, number]; // x, y, z, w

/**
 * Build a unit quaternion from an orthonormal right/up/forward basis.
 * Columns of the rotation matrix are the input axes; output is `[x, y, z, w]`
 * for direct use as a Rapier or three.js quaternion.
 *
 * Uses the standard branch-by-largest-trace-component algorithm to stay
 * numerically stable when the trace is small or negative.
 */
export function quatFromBasis(right: Vec3, up: Vec3, forward: Vec3): Quat {
  const m00 = right[0],
    m10 = right[1],
    m20 = right[2];
  const m01 = up[0],
    m11 = up[1],
    m21 = up[2];
  const m02 = forward[0],
    m12 = forward[1],
    m22 = forward[2];
  const trace = m00 + m11 + m22;
  let qx: number, qy: number, qz: number, qw: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    qw = 0.25 / s;
    qx = (m21 - m12) * s;
    qy = (m02 - m20) * s;
    qz = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    qw = (m21 - m12) / s;
    qx = 0.25 * s;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = 0.25 * s;
    qz = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = 0.25 * s;
  }
  return [qx, qy, qz, qw];
}

/**
 * Derive a unit quaternion describing the hand's orientation in camera space
 * from a MediaPipe landmark set. Body-local axes map as:
 *   +Y → palm "up" (wrist 0 → middle MCP 9)
 *   +X → palm "right" (pinky MCP 17 → index MCP 5, orthogonalized against up)
 *   +Z → palm normal (right × up)
 *
 * Coordinate conversion from MediaPipe to camera space negates each component:
 * x (we render the webcam mirrored, so user-right = world +X), y (image y is
 * down, world y is up), z (MediaPipe negative z = toward camera, world +Z =
 * toward viewer).
 *
 * Returns null when the landmarks are degenerate (zero-length palm-up axis,
 * or palm-across collinear with palm-up).
 */
export function handOrientation(lm: readonly Landmark[]): Quat | null {
  const w = lm[0];
  const mcp = lm[9];
  const idx = lm[5];
  const pinky = lm[17];
  if (!w || !mcp || !idx || !pinky) return null;

  const toCam = (p: Landmark): Vec3 => [-(p.x ?? 0), -(p.y ?? 0), -(p.z ?? 0)];
  const wp = toCam(w);
  const mp = toCam(mcp);
  const ip = toCam(idx);
  const pp = toCam(pinky);

  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (v: Vec3): Vec3 | null => {
    const L = Math.hypot(v[0], v[1], v[2]);
    if (L < 1e-8) return null;
    return [v[0] / L, v[1] / L, v[2] / L];
  };

  const up = norm(sub(mp, wp));
  if (!up) return null;

  // Palm-across direction (pinky → index), projected orthogonal to up so
  // the basis stays perpendicular even when MediaPipe's noisy depth makes
  // the raw vector slightly off-axis.
  const acrossRaw = sub(ip, pp);
  const k = dot(acrossRaw, up);
  const right = norm([
    acrossRaw[0] - up[0] * k,
    acrossRaw[1] - up[1] * k,
    acrossRaw[2] - up[2] * k,
  ]);
  if (!right) return null;

  // forward = right × up — right-handed basis (x × y = z).
  const forward: Vec3 = [
    right[1] * up[2] - right[2] * up[1],
    right[2] * up[0] - right[0] * up[2],
    right[0] * up[1] - right[1] * up[0],
  ];

  return quatFromBasis(right, up, forward);
}
