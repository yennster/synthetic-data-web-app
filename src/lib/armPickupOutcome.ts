import type { ArmTrajectory } from './armTrajectories';
import type { IngestionMetadataExtras } from './edgeImpulse';

export const ARM_PICKUP_SUCCESS_LIFT_M = 0.02;

export type ArmPickupObservation = {
  targetId: string;
  maxLiftM: number;
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
  return { targetId, maxLiftM: 0, success: false };
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
  if (boundedLift <= baseline.maxLiftM) return baseline;
  return {
    targetId,
    maxLiftM: boundedLift,
    success: baseline.success || boundedLift >= ARM_PICKUP_SUCCESS_LIFT_M,
  };
}

function roundMeters(v: number): number {
  return Math.round(v * 10000) / 10000;
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
  };
}
