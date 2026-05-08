/**
 * Pure IMU math used by the per-tick sampler in `Scene.tsx`. Kept here so
 * it can be unit-tested directly — the live path mixes Rapier reads with
 * THREE.Vector3 / Quaternion mutation, which is awkward to drive from a
 * test without booting a full r3f scene.
 *
 * A real IMU emits two channels per tick:
 *
 * - **accelerometer** = *proper* acceleration in body-local coordinates,
 *   i.e. `a_inertial − g_world` rotated by the inverse body orientation.
 *   Units: m/s². Stationary-on-the-floor reads (0, +9.81, 0); free-fall
 *   reads (0, 0, 0); a hard impact spikes briefly along the contact axis.
 * - **gyroscope** = body-local angular velocity. Units: rad/s. Stationary
 *   reads (0, 0, 0); a body spinning at 90°/s about its own up-axis reads
 *   (0, ~1.57, 0).
 */

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number]; // (x, y, z, w)

/** Per-sample IMU readings as plain numbers. Matches the runtime sample
 * shape so the helper output can be pushed straight into the store. */
export type ImuReading = {
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
};

/**
 * Compute one IMU sample.
 *
 * - `linvel` is the body's current linear velocity in **world frame**, in
 *   m/s. The live sampler reads this from `body.linvel()` while dynamic,
 *   and falls back to `(curPos − prevPos)/dt` while kinematic.
 * - `prevLinvel` is the world-frame linvel reported on the previous
 *   sample tick (zero on the very first sample).
 * - `angVelWorld` is the world-frame angular velocity in rad/s, derived
 *   from successive body rotations. The live sampler computes it via
 *   `angularVelocityFromQuats(qPrev, qCur, dt)`.
 * - `qCur` is the current body orientation; its inverse maps world-frame
 *   vectors into the body's local frame for the readout.
 * - `gWorld` is the world-frame gravity vector (signed). Default
 *   `(0, −9.81, 0)`.
 * - `dt` is the elapsed time since the previous sample, in seconds.
 *
 * Returns the body-local proper acceleration `(ax, ay, az)` and the
 * body-local angular velocity `(gx, gy, gz)`.
 */
export function computeImuReading(opts: {
  linvel: Vec3;
  prevLinvel: Vec3;
  angVelWorld: Vec3;
  qCur: Quat;
  dt: number;
  gWorld?: Vec3;
}): ImuReading {
  const g = opts.gWorld ?? ([0, -9.81, 0] as const);
  const inv = 1 / Math.max(opts.dt, 1e-9);

  // a_inertial = (linvel − prevLinvel) / dt — single numerical
  // differentiation.
  const aix = (opts.linvel[0] - opts.prevLinvel[0]) * inv;
  const aiy = (opts.linvel[1] - opts.prevLinvel[1]) * inv;
  const aiz = (opts.linvel[2] - opts.prevLinvel[2]) * inv;

  // a_proper (world frame) = a_inertial − g_world.
  const apxW = aix - g[0];
  const apyW = aiy - g[1];
  const apzW = aiz - g[2];

  // Rotate proper acceleration and angular velocity into body-local frame
  // by applying the inverse of the current orientation.
  const [bxA, byA, bzA] = applyInverseQuat(apxW, apyW, apzW, opts.qCur);
  const [bxG, byG, bzG] = applyInverseQuat(
    opts.angVelWorld[0],
    opts.angVelWorld[1],
    opts.angVelWorld[2],
    opts.qCur,
  );

  return { ax: bxA, ay: byA, az: bzA, gx: bxG, gy: byG, gz: bzG };
}

/**
 * Rotate `(x, y, z)` by the inverse of quaternion `q = (qx, qy, qz, qw)`.
 * Equivalent to THREE.Vector3.applyQuaternion(q.invert()), inlined to
 * avoid any THREE dependency in this pure module.
 */
function applyInverseQuat(
  x: number,
  y: number,
  z: number,
  q: Quat,
): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  // Inverse of a unit quaternion is its conjugate: (−qx, −qy, −qz, qw).
  const ix = -qx;
  const iy = -qy;
  const iz = -qz;
  const iw = qw;

  // v' = q⁻¹ * v * q (with v promoted to a pure quaternion (x, y, z, 0)).
  // First: t = q⁻¹ * v
  const tx = iw * x + iy * z - iz * y;
  const ty = iw * y + iz * x - ix * z;
  const tz = iw * z + ix * y - iy * x;
  const tw = -ix * x - iy * y - iz * z;
  // Then: v' = t * q
  const rx = tx * qw + tw * qx + ty * qz - tz * qy;
  const ry = ty * qw + tw * qy + tz * qx - tx * qz;
  const rz = tz * qw + tw * qz + tx * qy - ty * qx;
  return [rx, ry, rz];
}
