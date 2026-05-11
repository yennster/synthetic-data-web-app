import type { ArmTrajectory } from './armTrajectories';
import type { IngestionMetadataExtras } from './edgeImpulse';

export const ARM_PICKUP_SUCCESS_LIFT_M = 0.02;
export const ARM_PICKUP_MAX_TILT_DEG = 40;
export const ARM_PICKUP_MIN_DRIFT_TOLERANCE_M = 0.03;
export const ARM_PICKUP_MAX_DRIFT_TOLERANCE_M = 0.08;

export type ArmPickupFailureReason = 'target_tipped' | 'target_drifted';

export type ArmPickupGraspAssessment = {
  graspable: boolean;
  reason: ArmPickupFailureReason | null;
  tiltDeg: number;
  horizontalDriftM: number;
  driftToleranceM: number;
};

export type ArmPickupObservation = {
  targetId: string;
  maxLiftM: number;
  maxTiltDeg: number;
  maxHorizontalDriftM: number;
  graspableAtClose: boolean | null;
  failureReason: ArmPickupFailureReason | null;
  success: boolean;
};

export type ArmPickupTargetMetadata = {
  id: string | null;
  type: 'primitive' | 'asset' | 'fallback' | 'unknown';
  kind?: string;
  label?: string;
  name?: string;
};

export function createArmPickupObservation(
  targetId: string | null,
): ArmPickupObservation | null {
  if (!targetId) return null;
  return {
    targetId,
    maxLiftM: 0,
    maxTiltDeg: 0,
    maxHorizontalDriftM: 0,
    graspableAtClose: null,
    failureReason: null,
    success: false,
  };
}

function liftMeansSuccess(
  liftM: number,
  observation: Pick<ArmPickupObservation, 'failureReason'>,
): boolean {
  return !observation.failureReason && liftM >= ARM_PICKUP_SUCCESS_LIFT_M;
}

export function updateArmPickupObservation(
  current: ArmPickupObservation | null,
  targetId: string,
  liftM: number,
): ArmPickupObservation {
  const boundedLift = Number.isFinite(liftM) ? Math.max(0, liftM) : 0;
  const baseline =
    current && current.targetId === targetId
      ? current
      : createArmPickupObservation(targetId)!;
  if (boundedLift <= baseline.maxLiftM && !baseline.success) return baseline;
  const maxLiftM = Math.max(baseline.maxLiftM, boundedLift);
  return {
    ...baseline,
    targetId,
    maxLiftM,
    success: baseline.success || liftMeansSuccess(maxLiftM, baseline),
  };
}

export function updateArmPickupGraspAssessment(
  current: ArmPickupObservation | null,
  targetId: string,
  assessment: ArmPickupGraspAssessment,
): ArmPickupObservation {
  const baseline =
    current && current.targetId === targetId
      ? current
      : createArmPickupObservation(targetId)!;
  const failed = baseline.failureReason ?? assessment.reason;
  return {
    ...baseline,
    targetId,
    maxTiltDeg: Math.max(baseline.maxTiltDeg, assessment.tiltDeg),
    maxHorizontalDriftM: Math.max(
      baseline.maxHorizontalDriftM,
      assessment.horizontalDriftM,
    ),
    graspableAtClose:
      baseline.graspableAtClose === false
        ? false
        : assessment.graspable,
    failureReason: failed,
    success: failed ? false : baseline.success,
  };
}

function roundMeters(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function roundDegrees(v: number): number {
  return Math.round(v * 10) / 10;
}

function clampUnit(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

function normalizedQuat(
  q: readonly [number, number, number, number],
): [number, number, number, number] {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!Number.isFinite(len) || len <= 1e-9) return [1, 0, 0, 0];
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

export function armPickupDriftTolerance(
  halfExtents: readonly [number, number, number],
): number {
  const footprintRadius = Math.max(halfExtents[0], halfExtents[2]);
  return Math.max(
    ARM_PICKUP_MIN_DRIFT_TOLERANCE_M,
    Math.min(
      ARM_PICKUP_MAX_DRIFT_TOLERANCE_M,
      footprintRadius + ARM_PICKUP_MIN_DRIFT_TOLERANCE_M,
    ),
  );
}

export function assessArmPickupGrasp(
  pose: {
    pos: readonly [number, number, number];
    quat: readonly [number, number, number, number];
  },
  startCenter: readonly [number, number, number],
  halfExtents: readonly [number, number, number],
): ArmPickupGraspAssessment {
  const [w, x, y, z] = normalizedQuat(pose.quat);
  const localUpDotWorldUp = 1 - 2 * (x * x + z * z);
  const tiltDeg =
    Math.acos(clampUnit(localUpDotWorldUp)) * (180 / Math.PI);
  const horizontalDriftM = Math.hypot(
    pose.pos[0] - startCenter[0],
    pose.pos[2] - startCenter[2],
  );
  const driftToleranceM = armPickupDriftTolerance(halfExtents);
  let reason: ArmPickupFailureReason | null = null;
  if (tiltDeg > ARM_PICKUP_MAX_TILT_DEG) reason = 'target_tipped';
  else if (horizontalDriftM > driftToleranceM) reason = 'target_drifted';
  return {
    graspable: !reason,
    reason,
    tiltDeg,
    horizontalDriftM,
    driftToleranceM,
  };
}

export function buildArmPickupMetadata(
  trajectory: ArmTrajectory,
  target: ArmPickupTargetMetadata,
  observation: ArmPickupObservation | null,
): IngestionMetadataExtras {
  if (trajectory !== 'pick_place') return {};
  const observationMatches =
    !!target.id && observation?.targetId === target.id ? observation : null;
  const hasSceneTarget = target.type === 'primitive' || target.type === 'asset';
  const pickupMaxLiftM = observationMatches?.maxLiftM ?? 0;
  return {
    arm_target_type: target.type,
    arm_target_kind: target.kind,
    arm_target_label: target.label,
    arm_target_name: target.name,
    pickup_attempted: hasSceneTarget,
    pickup_success: hasSceneTarget && !!observationMatches?.success,
    pickup_max_lift_m: roundMeters(pickupMaxLiftM),
    pickup_success_threshold_m: ARM_PICKUP_SUCCESS_LIFT_M,
    pickup_graspable: observationMatches?.graspableAtClose ?? undefined,
    pickup_failure_reason: observationMatches?.failureReason ?? undefined,
    pickup_max_tilt_deg: observationMatches
      ? roundDegrees(observationMatches.maxTiltDeg)
      : undefined,
    pickup_max_horizontal_drift_m: observationMatches
      ? roundMeters(observationMatches.maxHorizontalDriftM)
      : undefined,
  };
}
