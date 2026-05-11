import { describe, expect, it } from 'vitest';
import { roverMjcf, type RoverObstacle } from './roverMjcf';

describe('roverMjcf', () => {
  it('emits a chassis body with planar joints + position actuators', () => {
    const xml = roverMjcf();
    expect(xml).toContain('name="chassis"');
    expect(xml).toContain('name="j_x"');
    expect(xml).toContain('name="j_z"');
    expect(xml).toContain('name="j_yaw"');
    expect(xml).toContain('name="a_x"');
    expect(xml).toContain('name="a_z"');
    expect(xml).toContain('name="a_yaw"');
  });

  it('declares accelerometer + gyro + framequat sensors at the IMU site', () => {
    const xml = roverMjcf();
    expect(xml).toContain('name="imu_accel"');
    expect(xml).toContain('name="imu_gyro"');
    expect(xml).toContain('name="imu_quat"');
    expect(xml).toContain('name="imu_pos"');
  });

  it('omits obstacle bodies when none are supplied', () => {
    const xml = roverMjcf();
    expect(xml).not.toContain('name="obs_');
  });

  it('emits one body per obstacle, named from a sanitized id', () => {
    const obstacles: RoverObstacle[] = [
      { id: 'a-b-c', x: 1, z: 2, r: 0.3, height: 0.2 },
      { id: '07e94f53', x: -1, z: 0, r: 0.4, height: 0.2 },
    ];
    const xml = roverMjcf(obstacles);
    // Both obstacles present, dashes stripped.
    expect(xml).toContain('name="obs_abc"');
    expect(xml).toContain('name="obs_07e94f53"');
    // Both positions baked in.
    expect(xml).toContain('pos="1.0000 0.2000 2.0000"');
    expect(xml).toContain('pos="-1.0000 0.2000 0.0000"');
  });

  it('uses cylinder geoms for obstacles (matches the visual columns)', () => {
    const obstacles: RoverObstacle[] = [
      { id: 'x', x: 0, z: 0, r: 0.5, height: 0.2 },
    ];
    const xml = roverMjcf(obstacles);
    // The obstacle body should have a cylinder geom of the right radius.
    expect(xml).toContain('type="cylinder"');
    expect(xml).toContain('size="0.5000');
  });
});
