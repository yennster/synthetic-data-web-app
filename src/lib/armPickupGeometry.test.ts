import { describe, expect, it } from 'vitest';
import {
  BRACCIO_GRIPPER_MIN_TIP_Y,
  floorSafePickupTipY,
} from './armPickupGeometry';

describe('arm pickup geometry helpers', () => {
  it('keeps floor-resting objects from commanding the gripper through the floor', () => {
    expect(floorSafePickupTipY(0.015, 0.015)).toBe(
      BRACCIO_GRIPPER_MIN_TIP_Y,
    );
  });

  it('uses the object bottom when it is already above the finger floor clearance', () => {
    expect(floorSafePickupTipY(0.1, 0.02)).toBeCloseTo(0.08);
  });
});
