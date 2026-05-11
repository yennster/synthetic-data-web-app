import { describe, expect, it } from 'vitest';
import { motionMjcf } from './motionMjcf';
import type { ObjectKind } from '../../store/useStore';

const ALL_KINDS: ObjectKind[] = [
  'cube',
  'sphere',
  'phone',
  'capsule',
  'cylinder',
  'cone',
  'torus',
  'soda_can',
];

describe('motionMjcf', () => {
  it.each(ALL_KINDS)('emits a free-joint body for kind=%s', (kind) => {
    const xml = motionMjcf(kind);
    // Free joint on the manipulated body — what gives it 6 DOF.
    expect(xml).toContain('<freejoint name="j_obj"/>');
    // IMU site at the body center for accel/gyro readings.
    expect(xml).toContain('<site name="imu"');
    // Mocap hand body — pose is written from JS while grabbed.
    expect(xml).toContain('mocap="true"');
    // Weld constraint — toggled to grab/release.
    expect(xml).toContain('name="grab"');
  });

  it('switches the manipulated geom type based on kind', () => {
    expect(motionMjcf('cube')).toContain('type="box"');
    expect(motionMjcf('sphere')).toContain('type="sphere"');
    expect(motionMjcf('capsule')).toContain('type="capsule"');
    expect(motionMjcf('cylinder')).toContain('type="cylinder"');
    expect(motionMjcf('soda_can')).toContain('type="cylinder"');
  });

  it('declares all four IMU-site sensors', () => {
    const xml = motionMjcf('cube');
    expect(xml).toContain('accelerometer');
    expect(xml).toContain('gyro');
    expect(xml).toContain('framequat');
    expect(xml).toContain('framepos');
  });

  it('starts with the weld disabled so the body free-falls until grabbed', () => {
    const xml = motionMjcf('cube');
    expect(xml).toContain('active="false"');
  });
});
