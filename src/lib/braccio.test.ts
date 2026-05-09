import { describe, expect, it } from 'vitest';
import {
  BRACCIO_LIMITS_RAD,
  BRACCIO_REST_RAD,
  clampBraccio,
  gripperApertureFromServoRad,
  gripperServoRadFromAperture,
} from './braccio';
import { lerpJoints, solveBraccioIk } from './braccioIk';

describe('Braccio joint limits', () => {
  it('rest pose lies inside every published servo limit', () => {
    for (let i = 0; i < 5; i++) {
      const [lo, hi] = BRACCIO_LIMITS_RAD[i];
      expect(BRACCIO_REST_RAD[i]).toBeGreaterThanOrEqual(lo);
      expect(BRACCIO_REST_RAD[i]).toBeLessThanOrEqual(hi);
    }
    // Gripper rest is the normalized 0..1 aperture, not a servo angle.
    expect(BRACCIO_REST_RAD[5]).toBeGreaterThanOrEqual(0);
    expect(BRACCIO_REST_RAD[5]).toBeLessThanOrEqual(1);
  });

  it('clampBraccio saturates out-of-range angles instead of throwing', () => {
    const out = clampBraccio([
      -10, // below base min
      999, // above shoulder max
      -1, // below elbow min
      999, // above wrist pitch max
      -1, // below wrist roll min
      2, // above gripper aperture
    ]);
    for (let i = 0; i < 5; i++) {
      const [lo, hi] = BRACCIO_LIMITS_RAD[i];
      expect(out[i]).toBeGreaterThanOrEqual(lo);
      expect(out[i]).toBeLessThanOrEqual(hi);
    }
    expect(out[5]).toBeLessThanOrEqual(1);
    expect(out[5]).toBeGreaterThanOrEqual(0);
  });

  it('gripper aperture round-trips through servo radians', () => {
    for (const a of [0, 0.25, 0.5, 0.75, 1]) {
      const servo = gripperServoRadFromAperture(a);
      const back = gripperApertureFromServoRad(servo);
      expect(back).toBeCloseTo(a, 5);
    }
  });
});

describe('Braccio IK', () => {
  it('returns joint angles inside the published limits', () => {
    const targets = [
      { x: 0.18, y: 0.06, z: 0.15 },
      { x: -0.2, y: 0.05, z: 0.2 },
      { x: 0, y: 0.3, z: 0.18 },
      { x: 0.25, y: 0.18, z: 0 },
    ];
    for (const t of targets) {
      const j = solveBraccioIk(t);
      for (let i = 0; i < 5; i++) {
        const [lo, hi] = BRACCIO_LIMITS_RAD[i];
        expect(j[i]).toBeGreaterThanOrEqual(lo);
        expect(j[i]).toBeLessThanOrEqual(hi);
      }
      expect(j[5]).toBeGreaterThanOrEqual(0);
      expect(j[5]).toBeLessThanOrEqual(1);
    }
  });

  it('respects the requested gripper aperture', () => {
    const open = solveBraccioIk({ x: 0.18, y: 0.06, z: 0.15 }, 1);
    const closed = solveBraccioIk({ x: 0.18, y: 0.06, z: 0.15 }, 0);
    expect(open[5]).toBe(1);
    expect(closed[5]).toBe(0);
  });

  it('points the base at the target azimuth', () => {
    // Target on +X axis → base yaw should be π/2 (since heading = 0
    // faces +Z and yaw rotates CCW about +Y).
    const j = solveBraccioIk({ x: 0.2, y: 0.1, z: 0 });
    expect(j[0]).toBeCloseTo(Math.PI / 2, 2);
    // Target on +Z axis → base yaw 0.
    const j2 = solveBraccioIk({ x: 0, y: 0.1, z: 0.2 });
    expect(j2[0]).toBeCloseTo(0, 2);
  });

  it('clamps unreachable targets to the nearest reachable pose', () => {
    // Way past the arm's reach — should still produce a valid joint
    // vector instead of NaN / throw.
    const j = solveBraccioIk({ x: 100, y: 100, z: 0 });
    for (let i = 0; i < 5; i++) {
      expect(Number.isFinite(j[i])).toBe(true);
    }
  });
});

describe('lerpJoints', () => {
  it('returns the start pose at t=0 and the end pose at t=1', () => {
    const a: [number, number, number, number, number, number] = [
      0.1, 0.2, 0.3, 0.4, 0.5, 0.5,
    ];
    const b: [number, number, number, number, number, number] = [
      0.5, 0.6, 0.7, 0.8, 0.9, 1.0,
    ];
    const at0 = lerpJoints(a, b, 0);
    const at1 = lerpJoints(a, b, 1);
    for (let i = 0; i < 6; i++) {
      expect(at0[i]).toBeCloseTo(a[i], 6);
      expect(at1[i]).toBeCloseTo(b[i], 6);
    }
  });

  it('interpolates monotonically along each component', () => {
    const a: [number, number, number, number, number, number] = [
      0, 0, 0, 0, 0, 0,
    ];
    const b: [number, number, number, number, number, number] = [
      1, 1, 1, 1, 1, 1,
    ];
    let prev = lerpJoints(a, b, 0)[0];
    for (let i = 1; i <= 10; i++) {
      const cur = lerpJoints(a, b, i / 10)[0];
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = cur;
    }
  });
});
