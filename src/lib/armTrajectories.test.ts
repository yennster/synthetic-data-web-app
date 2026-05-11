import { describe, expect, it } from 'vitest';
import {
  ALL_ARM_TRAJECTORIES,
  buildArmTrajectory,
  buildPickPlace,
} from './armTrajectories';
import { BRACCIO_LIMITS_RAD } from './braccio';

function checkInLimits(j: readonly number[]): void {
  for (let i = 0; i < 5; i++) {
    const [lo, hi] = BRACCIO_LIMITS_RAD[i];
    expect(j[i]).toBeGreaterThanOrEqual(lo);
    expect(j[i]).toBeLessThanOrEqual(hi);
  }
  expect(j[5]).toBeGreaterThanOrEqual(0);
  expect(j[5]).toBeLessThanOrEqual(1);
}

describe('arm trajectories', () => {
  it('every class produces in-limit joint vectors across [0, 1]', () => {
    for (const cls of ALL_ARM_TRAJECTORIES) {
      const path = buildArmTrajectory(cls, {
        pickup: { x: 0.18, y: 0.06, z: 0.12 },
        drop: { x: -0.18, y: 0.06, z: 0.12 },
      });
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        checkInLimits(path.sample(t));
      }
    }
  });

  describe('pick_place', () => {
    it('opens the gripper at the start and end and closes mid-window', () => {
      const path = buildPickPlace(
        { x: 0.18, y: 0.06, z: 0.12 },
        { x: -0.18, y: 0.06, z: 0.12 },
      );
      // Start at rest (half-open).
      const start = path.sample(0);
      expect(start[5]).toBeGreaterThan(0.4);
      // Mid-grasp at t≈0.5: gripper should be ~closed.
      const mid = path.sample(0.55);
      expect(mid[5]).toBeLessThan(0.2);
      // End at rest (half-open again).
      const end = path.sample(1);
      expect(end[5]).toBeGreaterThan(0.4);
    });

    it('targets the requested pickup and drop azimuths', () => {
      // Pickup on +X axis, drop on -X axis.
      const path = buildPickPlace(
        { x: 0.2, y: 0.05, z: 0 },
        { x: -0.2, y: 0.05, z: 0 },
      );
      // At t=0.4 the arm is over the pickup → base yaw ≈ π/2.
      const onTarget = path.sample(0.4);
      expect(onTarget[0]).toBeCloseTo(Math.PI / 2, 1);
      // At t=0.85 the arm is over the drop → base yaw ≈ -π/2 or 3π/2.
      // Allow either form; what matters is the arm is rotated to the
      // opposite hemisphere.
      const onDrop = path.sample(0.85);
      const dropYaw = onDrop[0];
      // Drop targets x=-0.2,z=0 → atan2(-0.2, 0) = -π/2. The IK
      // clamps to base limits [0, π], so it lands at the closest legal
      // angle — exactly 0 in this case (pointing at +Z, the boundary
      // closest to -π/2). What we really care about is "different from
      // the pickup yaw" — so test that.
      expect(Math.abs(dropYaw - onTarget[0])).toBeGreaterThan(0.5);
    });
  });

  describe('sweep', () => {
    it('only varies the base yaw, leaving other joints constant', () => {
      const path = buildArmTrajectory('sweep');
      const a = path.sample(0.0);
      const b = path.sample(0.25);
      const c = path.sample(0.5);
      // Yaw varies across the window.
      expect(a[0]).not.toBeCloseTo(b[0], 2);
      expect(b[0]).not.toBeCloseTo(c[0], 2);
      // Shoulder + elbow + wrist + roll constant.
      for (let i = 1; i < 5; i++) {
        expect(a[i]).toBeCloseTo(b[i], 6);
        expect(b[i]).toBeCloseTo(c[i], 6);
      }
    });

    it('pins non-yaw joints to the supplied home pose', () => {
      // Regression: the original sweep hardcoded shoulder/elbow/wrist
      // to π/2, which on the floor-mounted base drove the forearm
      // through the floor. The fix passes `home` through so the
      // joints stay reachable.
      const home: [number, number, number, number, number, number] = [
        1.0, 0.3, 0.9, 1.6, 3.1, 0.8,
      ];
      const path = buildArmTrajectory('sweep', { home });
      const mid = path.sample(0.42);
      expect(mid[1]).toBeCloseTo(home[1], 9);
      expect(mid[2]).toBeCloseTo(home[2], 9);
      expect(mid[3]).toBeCloseTo(home[3], 9);
      expect(mid[4]).toBeCloseTo(home[4], 9);
      expect(mid[5]).toBeCloseTo(home[5], 9);
    });
  });

  describe('wave', () => {
    it('only varies wrist pitch, leaving other joints at home', () => {
      const home: [number, number, number, number, number, number] = [
        0.9, 0.4, 1.0, 1.5, 3.0, 0.6,
      ];
      const path = buildArmTrajectory('wave', { home });
      // Sample at t=0 (sin = 0) and t=0.125 (sin = 1) so the wrist-
      // pitch term is at its trough vs peak rather than two phases of
      // the same zero crossing.
      const a = path.sample(0.0);
      const b = path.sample(0.125);
      expect(a[3]).not.toBeCloseTo(b[3], 2);
      // Everything except wrist-pitch should be pinned to home.
      for (const i of [0, 1, 2, 4, 5]) {
        expect(a[i]).toBeCloseTo(home[i], 9);
        expect(b[i]).toBeCloseTo(home[i], 9);
      }
    });
  });
});
