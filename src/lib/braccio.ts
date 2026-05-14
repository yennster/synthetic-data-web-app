/**
 * Arduino TinkerKit Braccio kinematic spec.
 *
 * Source: Arduino's published Braccio documentation
 * (https://store.arduino.cc/products/tinkerkit-braccio-robot and the
 * accompanying Braccio Arduino library, which exposes per-servo angle
 * limits in degrees). The arm has six servos, M1–M6:
 *
 *   M1  Base yaw                0°–180°
 *   M2  Shoulder pitch         15°–165°
 *   M3  Elbow pitch             0°–180°
 *   M4  Wrist pitch             0°–180°
 *   M5  Wrist roll              0°–180°
 *   M6  Gripper aperture       10°–73°  (10° = closed, 73° = open)
 *
 * Internally we represent every joint angle in radians, with the Braccio's
 * home pose set to a stable presentation/capture stance. The gripper is
 * mapped to a normalized 0..1 aperture for visual rendering — 0 = fully
 * closed (servo angle 10°), 1 = fully open (servo angle 73°).
 *
 * Link lengths are taken from Arduino's published Braccio CAD; values
 * here are in meters and approximate enough for synthesizing IMU
 * trajectories. A real engineering pipeline would calibrate these per
 * physical arm — but the goal here is plausible synthetic data, not
 * sub-millimeter accuracy.
 */

import { clamp, clamp01 } from './math';

// Compact alias for the literal degree-to-radian conversions in the
// BRACCIO_LIMITS_RAD table below. Kept local because the table reads
// more naturally as `15 * DEG` than `degToRad(15)`.
const DEG = Math.PI / 180;

/** Servo angle limits in radians, indexed [min, max] per joint. The
 * gripper entry is in the same servo-angle space; conversion to the
 * 0..1 visual aperture uses `gripperApertureFromServoRad`. */
export const BRACCIO_LIMITS_RAD: ReadonlyArray<readonly [number, number]> = [
  [0 * DEG, 180 * DEG], // M1 base
  [15 * DEG, 165 * DEG], // M2 shoulder
  [0 * DEG, 180 * DEG], // M3 elbow
  [0 * DEG, 180 * DEG], // M4 wrist pitch
  [0 * DEG, 180 * DEG], // M5 wrist roll
  [10 * DEG, 73 * DEG], // M6 gripper
];

/** Rest/home pose. Joints 0..4 are servo-radians; joint 5 is normalized
 * aperture (0..1). The rig component swaps in this rest pose whenever
 * `armJoints` in the store is null. */
export const BRACCIO_REST_RAD: [number, number, number, number, number, number] = [
  70 * DEG,
  15 * DEG,
  50 * DEG,
  90 * DEG,
  180 * DEG,
  1,
];

/** Link lengths in meters. Approximate — see file header. */
export const BRACCIO_LINKS = {
  /** Mounting plate (cosmetic disc the base sits on). */
  plateRadius: 0.08,
  plateThickness: 0.015,
  /** M1 base servo column height. */
  base: 0.071,
  /** M2 → M3 upper-arm length. */
  shoulder: 0.125,
  /** M3 → M4 forearm length. */
  elbow: 0.125,
  /** M4 → M5 wrist pitch link. */
  wristPitch: 0.06,
  /** M5 wrist-roll cylinder length (gripper carrier offset). */
  wristRoll: 0.05,
  /** Lateral spread between the two parallel-jaw fingers at full open. */
  gripperWidth: 0.06,
  /** Finger length below the carrier plate. */
  fingerLength: 0.05,
} as const;

/**
 * Convert a gripper servo angle (radians) into a normalized aperture
 * for rendering. Linear map across the published 10°–73° range.
 */
export function gripperApertureFromServoRad(servoRad: number): number {
  const [lo, hi] = BRACCIO_LIMITS_RAD[5];
  if (hi === lo) return 0;
  const t = (servoRad - lo) / (hi - lo);
  return clamp01(t);
}

/** Inverse of `gripperApertureFromServoRad` — for joint trajectories that
 * want to reason in 0..1 aperture space and emit the matching servo
 * angle. */
export function gripperServoRadFromAperture(aperture: number): number {
  const [lo, hi] = BRACCIO_LIMITS_RAD[5];
  return lo + clamp01(aperture) * (hi - lo);
}

/**
 * Clamp a six-joint vector to the published Braccio servo limits. Joints
 * 0..4 are clamped against `BRACCIO_LIMITS_RAD`; joint 5 is treated as
 * a normalized aperture and clamped to [0, 1].
 */
export function clampBraccio(
  joints: [number, number, number, number, number, number],
): [number, number, number, number, number, number] {
  const out: [number, number, number, number, number, number] = [
    0, 0, 0, 0, 0, 0,
  ];
  for (let i = 0; i < 5; i++) {
    const [lo, hi] = BRACCIO_LIMITS_RAD[i];
    out[i] = clamp(joints[i], lo, hi);
  }
  out[5] = clamp01(joints[5]);
  return out;
}
