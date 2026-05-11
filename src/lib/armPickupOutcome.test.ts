import { describe, expect, it } from 'vitest';
import {
  ARM_PICKUP_SUCCESS_LIFT_M,
  ARM_PICKUP_MAX_TILT_DEG,
  assessArmPickupGrasp,
  buildArmPickupMetadata,
  createArmPickupObservation,
  updateArmPickupGraspAssessment,
  updateArmPickupObservation,
} from './armPickupOutcome';

describe('arm pickup outcome helpers', () => {
  it('tracks max lift and marks pickup success past the threshold', () => {
    let observation = createArmPickupObservation('target-a');
    expect(observation).toEqual({
      targetId: 'target-a',
      maxLiftM: 0,
      maxTiltDeg: 0,
      maxHorizontalDriftM: 0,
      graspableAtClose: null,
      failureReason: null,
      success: false,
    });

    observation = updateArmPickupObservation(
      observation,
      'target-a',
      ARM_PICKUP_SUCCESS_LIFT_M / 2,
    );
    expect(observation.maxLiftM).toBeCloseTo(ARM_PICKUP_SUCCESS_LIFT_M / 2);
    expect(observation.success).toBe(false);

    observation = updateArmPickupObservation(
      observation,
      'target-a',
      ARM_PICKUP_SUCCESS_LIFT_M + 0.001,
    );
    expect(observation.maxLiftM).toBeCloseTo(
      ARM_PICKUP_SUCCESS_LIFT_M + 0.001,
    );
    expect(observation.success).toBe(true);

    observation = updateArmPickupObservation(observation, 'target-a', 0.001);
    expect(observation.maxLiftM).toBeCloseTo(
      ARM_PICKUP_SUCCESS_LIFT_M + 0.001,
    );
  });

  it('rejects pickup success when the object has tipped before grasp', () => {
    let observation = updateArmPickupGraspAssessment(
      createArmPickupObservation('target-a'),
      'target-a',
      {
        graspable: false,
        reason: 'target_tipped',
        tiltDeg: ARM_PICKUP_MAX_TILT_DEG + 15,
        horizontalDriftM: 0.004,
        driftToleranceM: 0.03,
      },
    );
    observation = updateArmPickupObservation(
      observation,
      'target-a',
      ARM_PICKUP_SUCCESS_LIFT_M + 0.02,
    );

    expect(observation.success).toBe(false);
    expect(observation.graspableAtClose).toBe(false);
    expect(observation.failureReason).toBe('target_tipped');
    expect(observation.maxTiltDeg).toBe(ARM_PICKUP_MAX_TILT_DEG + 15);
  });

  it('assesses tipped and drifted target poses as ungraspable', () => {
    const standing = assessArmPickupGrasp(
      { pos: [0.1, 0.03, 0.1], quat: [1, 0, 0, 0] },
      [0.1, 0.03, 0.1],
      [0.015, 0.03, 0.015],
    );
    expect(standing.graspable).toBe(true);
    expect(standing.reason).toBeNull();
    expect(standing.tiltDeg).toBeCloseTo(0);

    const tipped = assessArmPickupGrasp(
      {
        pos: [0.1, 0.03, 0.1],
        quat: [Math.SQRT1_2, Math.SQRT1_2, 0, 0],
      },
      [0.1, 0.03, 0.1],
      [0.015, 0.03, 0.015],
    );
    expect(tipped.graspable).toBe(false);
    expect(tipped.reason).toBe('target_tipped');
    expect(tipped.tiltDeg).toBeGreaterThan(ARM_PICKUP_MAX_TILT_DEG);

    const drifted = assessArmPickupGrasp(
      { pos: [0.2, 0.03, 0.1], quat: [1, 0, 0, 0] },
      [0.1, 0.03, 0.1],
      [0.015, 0.03, 0.015],
    );
    expect(drifted.graspable).toBe(false);
    expect(drifted.reason).toBe('target_drifted');
  });

  it('emits pick-and-place metadata for the recorded sample', () => {
    const observation = updateArmPickupObservation(
      createArmPickupObservation('asset-1'),
      'asset-1',
      0.03123,
    );
    const meta = buildArmPickupMetadata(
      'pick_place',
      {
        id: 'asset-1',
        type: 'asset',
        label: 'soda',
        name: 'soda.usdz',
      },
      observation,
    );

    expect(meta.pickup_attempted).toBe(true);
    expect(meta.pickup_success).toBe(true);
    expect(meta.pickup_max_lift_m).toBe(0.0312);
    expect(meta.pickup_success_threshold_m).toBe(ARM_PICKUP_SUCCESS_LIFT_M);
    expect(meta.pickup_graspable).toBeUndefined();
    expect(meta.pickup_failure_reason).toBeUndefined();
    expect(meta.arm_target_type).toBe('asset');
    expect(meta.arm_target_label).toBe('soda');
    expect(meta.arm_target_name).toBe('soda.usdz');
  });

  it('adds failure metadata when the grasp was rejected', () => {
    const observation = updateArmPickupGraspAssessment(
      createArmPickupObservation('asset-1'),
      'asset-1',
      {
        graspable: false,
        reason: 'target_tipped',
        tiltDeg: 72.25,
        horizontalDriftM: 0.006,
        driftToleranceM: 0.03,
      },
    );
    const meta = buildArmPickupMetadata(
      'pick_place',
      { id: 'asset-1', type: 'asset' },
      observation,
    );

    expect(meta.pickup_success).toBe(false);
    expect(meta.pickup_graspable).toBe(false);
    expect(meta.pickup_failure_reason).toBe('target_tipped');
    expect(meta.pickup_max_tilt_deg).toBe(72.3);
    expect(meta.pickup_max_horizontal_drift_m).toBe(0.006);
  });

  it('omits pickup fields for non-pick-place arm trajectories', () => {
    expect(
      buildArmPickupMetadata(
        'wave',
        { id: null, type: 'fallback' },
        null,
      ),
    ).toEqual({});
  });
});
