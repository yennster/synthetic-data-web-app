import { describe, expect, it } from 'vitest';
import {
  BRACCIO_ACTUATOR_NAMES,
  BRACCIO_GRIP_ACTUATOR_NAMES,
  BRACCIO_JOINT_NAMES,
  BRACCIO_MJCF,
  BRACCIO_TARGET,
  apertureToFingerSlide,
  braccioMjcf,
} from './braccioMjcf';
import { BRACCIO_LINKS } from '../braccio';

describe('BRACCIO_MJCF', () => {
  it('declares all five servo joints from the published Braccio spec', () => {
    for (const name of BRACCIO_JOINT_NAMES) {
      expect(BRACCIO_MJCF).toContain(`name="${name}"`);
    }
  });

  it('declares position actuators for every joint, including the gripper fingers', () => {
    for (const name of [
      ...BRACCIO_ACTUATOR_NAMES,
      ...BRACCIO_GRIP_ACTUATOR_NAMES,
    ]) {
      expect(BRACCIO_MJCF).toContain(`name="${name}"`);
    }
  });

  it('includes the pickup target as a free-joint body for real grasping', () => {
    expect(BRACCIO_MJCF).toContain(`name="${BRACCIO_TARGET.body}"`);
    expect(BRACCIO_MJCF).toContain(`name="${BRACCIO_TARGET.joint}"`);
    expect(BRACCIO_MJCF).toContain('<freejoint');
  });

  it('can resize the pickup target box for imported assets', () => {
    const xml = braccioMjcf({ halfExtents: [0.02, 0.06, 0.015] });
    expect(xml).toContain('size="0.0200 0.0600 0.0150"');
    expect(xml).toContain('<body name="target" pos="0.18 0.0600 0.12">');
  });

  it('puts the IMU site at the end-effector with all four IMU sensors', () => {
    expect(BRACCIO_MJCF).toContain('<site name="imu"');
    expect(BRACCIO_MJCF).toContain('name="imu_accel"');
    expect(BRACCIO_MJCF).toContain('name="imu_gyro"');
    expect(BRACCIO_MJCF).toContain('name="imu_quat"');
    expect(BRACCIO_MJCF).toContain('name="ee_pos"');
  });
});

describe('apertureToFingerSlide', () => {
  it('returns 0 when the gripper is fully closed', () => {
    expect(apertureToFingerSlide(0)).toBe(0);
  });

  it('returns half the gripper width when fully open', () => {
    expect(apertureToFingerSlide(1)).toBeCloseTo(
      BRACCIO_LINKS.gripperWidth / 2,
      9,
    );
  });

  it('clamps values outside [0, 1] to the spec range', () => {
    expect(apertureToFingerSlide(-1)).toBe(0);
    expect(apertureToFingerSlide(2)).toBeCloseTo(
      BRACCIO_LINKS.gripperWidth / 2,
      9,
    );
  });
});
