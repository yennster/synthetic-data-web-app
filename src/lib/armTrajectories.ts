/**
 * Arm trajectory engine — produces parametric joint-space paths for
 * the Braccio arm that the controller drives in step with the
 * recording window. Each generator returns a closure mapping
 * normalized time `t ∈ [0, 1]` to a 6-joint vector, using the IK
 * helper in `braccioIk.ts` to pin keyframes to specific end-effector
 * poses where it matters.
 *
 * The five trajectory classes line up with the canonical Edge Impulse
 * "robotic-arm motion" dataset:
 *
 *   - `pick_place`   approach a scene object, close the gripper, lift,
 *                    move to a destination, open. The flagship demo.
 *   - `sweep`        base servo sweeps left-right at a fixed shoulder /
 *                    elbow — clear scanning motion signature.
 *   - `wave`         wrist-pitch oscillates at fixed shoulder / elbow.
 *   - `random_pose`  interpolate between two random reachable joint
 *                    vectors. Useful for "general motion" baseline.
 *   - `draw_circle`  end-effector traces a circle in a horizontal plane
 *                    (planar IK) — shows IK quality in the recorded
 *                    accelerometer signature.
 *
 * Targets for `pick_place` are passed in as world-space points so the
 * runner can choose whichever scene object it likes (or pick a random
 * placeholder when no scene objects exist).
 */

import {
  BRACCIO_LIMITS_RAD,
  BRACCIO_REST_RAD,
} from './braccio';
import {
  lerpJoints,
  solveBraccioIk,
  type BraccioJointVector,
} from './braccioIk';

export type ArmTrajectory =
  | 'pick_place'
  | 'sweep'
  | 'wave'
  | 'random_pose'
  | 'draw_circle';

export const ALL_ARM_TRAJECTORIES: ArmTrajectory[] = [
  'pick_place',
  'sweep',
  'wave',
  'random_pose',
  'draw_circle',
];

export type ArmParametricPath = {
  sample: (t: number) => BraccioJointVector;
};

/** Pick-and-place keyframes anchored on a target world position (the
 * scene object) and a destination point. The recording window covers
 * the full sequence:
 *
 *   t = 0.00   rest pose (gripper open, half-aperture)
 *   t = 0.25   above target with gripper open
 *   t = 0.40   on target (slightly lower) — gripper still open
 *   t = 0.50   close gripper
 *   t = 0.65   lift back to "above"
 *   t = 0.85   move to destination
 *   t = 1.00   open gripper, return to rest
 *
 * The runner uses constant-time `t` so the timing of grasp/release is
 * consistent across the batch — important so a classifier trained on
 * the IMU window can lock onto where in the trace each phase happens.
 */
export function buildPickPlace(
  pickup: { x: number; y: number; z: number },
  drop: { x: number; y: number; z: number },
): ArmParametricPath {
  const rest: BraccioJointVector = [...BRACCIO_REST_RAD];
  // "Above" hovers 6 cm above the target so the arm doesn't crash
  // through whatever it's grasping.
  const above = solveBraccioIk(
    { x: pickup.x, y: pickup.y + 0.06, z: pickup.z },
    1, // open
  );
  const onTarget = solveBraccioIk(pickup, 1);
  const grasped = solveBraccioIk(pickup, 0); // closed
  const lifted = solveBraccioIk(
    { x: pickup.x, y: pickup.y + 0.06, z: pickup.z },
    0,
  );
  const aboveDrop = solveBraccioIk(
    { x: drop.x, y: drop.y + 0.06, z: drop.z },
    0,
  );
  const released = solveBraccioIk(
    { x: drop.x, y: drop.y + 0.06, z: drop.z },
    1,
  );

  const segments: { until: number; to: BraccioJointVector }[] = [
    { until: 0.25, to: above },
    { until: 0.4, to: onTarget },
    { until: 0.5, to: grasped },
    { until: 0.65, to: lifted },
    { until: 0.85, to: aboveDrop },
    { until: 0.95, to: released },
    { until: 1.0, to: rest },
  ];

  return {
    sample: (t) => {
      const u = Math.max(0, Math.min(1, t));
      let prevTime = 0;
      let prev = rest;
      for (const seg of segments) {
        if (u <= seg.until) {
          const span = Math.max(1e-3, seg.until - prevTime);
          const localT = (u - prevTime) / span;
          return lerpJoints(prev, seg.to, localT);
        }
        prevTime = seg.until;
        prev = seg.to;
      }
      return rest;
    },
  };
}

export function buildSweep(): ArmParametricPath {
  // Base yaw oscillates across most of its range; shoulder/elbow stay
  // at a "looking forward" posture.
  const [yawLo, yawHi] = BRACCIO_LIMITS_RAD[0];
  const yawCenter = (yawLo + yawHi) / 2;
  const yawAmp = (yawHi - yawLo) * 0.4;
  const base: BraccioJointVector = [
    yawCenter,
    Math.PI / 2, // shoulder upright
    Math.PI / 2,
    Math.PI / 2,
    Math.PI / 2,
    0.5,
  ];
  return {
    sample: (t) => {
      const u = Math.max(0, Math.min(1, t));
      const yaw = yawCenter + Math.sin(u * 2 * Math.PI) * yawAmp;
      return [yaw, base[1], base[2], base[3], base[4], base[5]];
    },
  };
}

export function buildWave(): ArmParametricPath {
  const base: BraccioJointVector = [
    Math.PI / 2,
    Math.PI / 2,
    Math.PI / 2,
    Math.PI / 2,
    Math.PI / 2,
    0.5,
  ];
  const [wpLo, wpHi] = BRACCIO_LIMITS_RAD[3];
  const wpCenter = (wpLo + wpHi) / 2;
  const wpAmp = (wpHi - wpLo) * 0.4;
  return {
    sample: (t) => {
      const u = Math.max(0, Math.min(1, t));
      const wp = wpCenter + Math.sin(u * 2 * Math.PI * 2) * wpAmp; // 2 cycles
      return [base[0], base[1], base[2], wp, base[4], base[5]];
    },
  };
}

export function buildRandomPose(rng: () => number = Math.random): ArmParametricPath {
  // Two reachable random joint vectors interpolated end-to-end.
  const sample = (): BraccioJointVector => [
    randomInRange(BRACCIO_LIMITS_RAD[0], rng),
    randomInRange(BRACCIO_LIMITS_RAD[1], rng),
    randomInRange(BRACCIO_LIMITS_RAD[2], rng),
    randomInRange(BRACCIO_LIMITS_RAD[3], rng),
    randomInRange(BRACCIO_LIMITS_RAD[4], rng),
    rng(),
  ];
  const a = sample();
  const b = sample();
  return { sample: (t) => lerpJoints(a, b, t) };
}

function randomInRange(
  range: readonly [number, number],
  rng: () => number,
): number {
  return range[0] + rng() * (range[1] - range[0]);
}

/**
 * End-effector traces a horizontal circle of radius `radius` at height
 * `height`, centered on (cx, cz). Each `t` is the angular phase. Uses
 * IK so the joint signature reflects real linkage motion (not just one
 * joint sweeping).
 */
export function buildDrawCircle(opts?: {
  cx?: number;
  cz?: number;
  height?: number;
  radius?: number;
  ccw?: boolean;
}): ArmParametricPath {
  const cx = opts?.cx ?? 0;
  const cz = opts?.cz ?? 0.18;
  const height = opts?.height ?? 0.18;
  const radius = opts?.radius ?? 0.08;
  const dir = opts?.ccw === false ? -1 : 1;
  return {
    sample: (t) => {
      const phi = dir * t * 2 * Math.PI;
      return solveBraccioIk(
        {
          x: cx + Math.cos(phi) * radius,
          y: height,
          z: cz + Math.sin(phi) * radius,
        },
        0.5,
      );
    },
  };
}

/** Pick the trajectory builder for the given class. Caller passes the
 * `pickup` / `drop` world points for `pick_place`; ignored for the
 * other classes. When no targets are supplied, `pick_place` falls
 * back to a deterministic placeholder so the runner doesn't crash. */
export function buildArmTrajectory(
  trajectory: ArmTrajectory,
  opts?: {
    pickup?: { x: number; y: number; z: number };
    drop?: { x: number; y: number; z: number };
    rng?: () => number;
  },
): ArmParametricPath {
  switch (trajectory) {
    case 'pick_place': {
      const pickup = opts?.pickup ?? { x: 0.18, y: 0.05, z: 0.12 };
      const drop = opts?.drop ?? { x: -0.18, y: 0.05, z: 0.12 };
      return buildPickPlace(pickup, drop);
    }
    case 'sweep':
      return buildSweep();
    case 'wave':
      return buildWave();
    case 'random_pose':
      return buildRandomPose(opts?.rng);
    case 'draw_circle':
      return buildDrawCircle();
  }
}
