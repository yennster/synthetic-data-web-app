/**
 * Inverse kinematics for the Arduino TinkerKit Braccio.
 *
 * The Braccio has a base yaw + a planar 3-link chain in the vertical
 * plane (shoulder-pitch, elbow-pitch, wrist-pitch), plus a wrist-roll
 * and gripper at the tip. Solving for an end-effector world position
 * decomposes into:
 *
 *   1. Pick base yaw so the arm plane points at the target. Trivial —
 *      atan2 of the target's xz.
 *   2. Reduce to 2-link planar IK (shoulder + elbow) for the wrist
 *      pitch position, with the wrist-pitch link compensated as a
 *      desired tip-down approach so the gripper points at the floor.
 *   3. Wrist roll is left at neutral (90° servo) by default — callers
 *      can override.
 *
 * The solution clamps to the published servo limits (`BRACCIO_LIMITS_RAD`),
 * so unreachable targets resolve to the closest reachable configuration
 * rather than throwing. This is what an Arduino sketch would do on the
 * physical arm — saturating into the joint-limit cone instead of
 * faulting.
 *
 * Coordinate convention matches `BraccioArm.tsx`: the arm sits at the
 * origin, base servo rotates about +Y. Targets are in the same world
 * frame; we add the plate height offset internally so callers can pass
 * raw world coordinates.
 */

import { BRACCIO_LIMITS_RAD, BRACCIO_LINKS } from './braccio';

/** Solver output: six joint values in the same order the rig expects.
 * Joints 0..4 are servo radians (clamped to spec limits); joint 5 is
 * the normalized aperture (0..1) the rig translates back into a servo
 * angle for rendering. */
export type BraccioJointVector = [
  number,
  number,
  number,
  number,
  number,
  number,
];

/**
 * Solve for joint angles that place the gripper tip at `target` (world
 * coordinates) with a tip-down approach (the gripper points
 * approximately at the floor). Output is clamped to servo limits.
 *
 * `aperture` is the normalized 0..1 gripper opening to bake into the
 * output vector — defaults to 0.5 (half-open), the Braccio "neutral"
 * gripper pose.
 *
 * The solver isn't analytical for the over-constrained case (we have
 * 3 in-plane DOF and 2 constraints — tip position — with a third
 * ("approach angle") supplied below). It treats wrist-pitch as a free
 * "approach pitch" we set so the gripper points downward, then solves
 * the remaining shoulder/elbow analytically as a 2-link planar IK.
 */
export function solveBraccioIk(
  target: { x: number; y: number; z: number },
  aperture = 0.5,
): BraccioJointVector {
  const L = BRACCIO_LINKS;
  // 1) Base yaw so the arm plane points at the target's xz.
  let yaw = Math.atan2(target.x, target.z);

  // 2) Reduce to planar IK in the rotated chain frame. Project target
  // onto that plane: (radial, height).
  const radial = Math.sqrt(target.x * target.x + target.z * target.z);
  const baseHeight = L.plateThickness + L.base;
  // Wrist offset back along the approach: the wrist-pitch joint sits
  // (wristPitch + wristRoll + fingerLength) above the gripper tip
  // when the approach is straight down, so subtract that vertical
  // offset to get the wrist-pitch joint position we solve for.
  const wristToTip = L.wristPitch + L.wristRoll + L.fingerLength;
  const wristR = radial; // tip-down approach: wrist sits directly above tip
  const wristH = target.y - baseHeight + wristToTip;

  // 3) 2-link planar IK on shoulder/elbow for (wristR, wristH).
  const a = L.shoulder;
  const b = L.elbow;
  let r = Math.sqrt(wristR * wristR + wristH * wristH);
  // Clamp to the reachable annulus.
  const rMin = Math.abs(a - b) + 1e-3;
  const rMax = a + b - 1e-3;
  r = Math.max(rMin, Math.min(rMax, r));
  const cosElbow = (a * a + b * b - r * r) / (2 * a * b);
  // Elbow angle in the chain (180° = straight).
  const elbowFlex = Math.acos(Math.max(-1, Math.min(1, cosElbow)));
  // We want the elbow to bend "up" (the typical Braccio pose) — pick
  // the negative flex so accumulated pitch raises the forearm.
  // Joint 2 (elbow) in our rig adds to joint 1 (shoulder); the angle
  // between the arms is π − elbowFlex, so the elbow joint value is:
  const elbowJoint = Math.PI - elbowFlex;
  // Shoulder pitch: angle to wrist target − offset of forearm from
  // upper arm.
  const phi = Math.atan2(wristR, wristH);
  const cosShoulderOffset = (a * a + r * r - b * b) / (2 * a * r);
  const shoulderOffset = Math.acos(
    Math.max(-1, Math.min(1, cosShoulderOffset)),
  );
  const shoulderJoint = phi - shoulderOffset;

  // 4) Wrist pitch: keep the gripper tip pointing toward the floor.
  // Cumulative pitch at wrist-pitch joint = shoulderJoint + elbowJoint.
  // We want the wrist pitch to bend the gripper by (π − cumulative)
  // so the gripper axis ends up vertical.
  const cumulative = shoulderJoint + elbowJoint;
  const wristPitchJoint = Math.PI - cumulative;

  // 5) Wrist roll left at neutral (90°).
  const wristRoll = Math.PI / 2;

  // Clamp every joint to its published servo limit.
  const out: BraccioJointVector = [
    yaw,
    shoulderJoint,
    elbowJoint,
    wristPitchJoint,
    wristRoll,
    aperture,
  ];
  for (let i = 0; i < 5; i++) {
    const [lo, hi] = BRACCIO_LIMITS_RAD[i];
    out[i] = Math.max(lo, Math.min(hi, out[i]));
  }
  out[5] = Math.max(0, Math.min(1, out[5]));
  return out;
}

/**
 * Cosine-easing interpolation between two joint vectors. Used by the
 * arm runner to drive smooth motion between IK keyframes (approach,
 * pre-grasp, grasp, lift, place). Each component eases independently —
 * fine for a 6-joint arm where coordinate-frame coupling between
 * joints is already baked into the IK solutions on either end.
 */
export function lerpJoints(
  a: BraccioJointVector,
  b: BraccioJointVector,
  t: number,
): BraccioJointVector {
  const u = Math.max(0, Math.min(1, t));
  // Cosine ease so each waypoint blends smoothly into the next without
  // needing a higher-order spline.
  const e = (1 - Math.cos(u * Math.PI)) * 0.5;
  return [
    a[0] + (b[0] - a[0]) * e,
    a[1] + (b[1] - a[1]) * e,
    a[2] + (b[2] - a[2]) * e,
    a[3] + (b[3] - a[3]) * e,
    a[4] + (b[4] - a[4]) * e,
    a[5] + (b[5] - a[5]) * e,
  ];
}
