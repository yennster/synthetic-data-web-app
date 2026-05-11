import { describe, expect, it } from 'vitest';
import {
  ARM_PICKUP_SUCCESS_LIFT_M,
  buildArmPickupMetadata,
  createArmPickupObservation,
  updateArmPickupObservation,
} from './armPickupOutcome';

describe('arm pickup outcome helpers', () => {
  it('tracks max lift and marks pickup success past the threshold', () => {
    let observation = createArmPickupObservation('target-a');
    expect(observation).toEqual({
      targetId: 'target-a',
      maxLiftM: 0,
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
    expect(meta.arm_target_type).toBe('asset');
    expect(meta.arm_target_label).toBe('soda');
    expect(meta.arm_target_name).toBe('soda.usdz');
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
