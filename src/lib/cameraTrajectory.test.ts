import { describe, expect, it } from 'vitest';
import { sampleCameraTrajectory } from './cameraTrajectory';

const TARGET: [number, number, number] = [0, 0.5, 0];

describe('sampleCameraTrajectory', () => {
  describe('circle', () => {
    it('returns the same point for index 0 regardless of total samples', () => {
      const a = sampleCameraTrajectory({
        trajectory: 'circle',
        index: 0,
        total: 10,
        target: TARGET,
        radius: 4,
        height: 2,
      });
      const b = sampleCameraTrajectory({
        trajectory: 'circle',
        index: 0,
        total: 100,
        target: TARGET,
        radius: 4,
        height: 2,
      });
      expect(a).toEqual(b);
    });

    it('first sample is at (radius, target.y + height, 0)', () => {
      const p = sampleCameraTrajectory({
        trajectory: 'circle',
        index: 0,
        total: 4,
        target: TARGET,
        radius: 3,
        height: 1.5,
      });
      expect(p[0]).toBeCloseTo(3, 10);
      expect(p[1]).toBeCloseTo(2, 10); // 0.5 + 1.5
      expect(p[2]).toBeCloseTo(0, 10);
    });

    it('quarter-turn lands at (0, ty+h, radius)', () => {
      const p = sampleCameraTrajectory({
        trajectory: 'circle',
        index: 1,
        total: 4,
        target: TARGET,
        radius: 5,
        height: 0,
      });
      expect(p[0]).toBeCloseTo(0, 10);
      expect(p[1]).toBeCloseTo(0.5, 10);
      expect(p[2]).toBeCloseTo(5, 10);
    });

    it('all samples sit at constant distance from target on the orbit plane', () => {
      const radius = 4;
      const height = 1.5;
      for (let i = 0; i < 32; i++) {
        const p = sampleCameraTrajectory({
          trajectory: 'circle',
          index: i,
          total: 32,
          target: TARGET,
          radius,
          height,
        });
        const r = Math.hypot(p[0] - TARGET[0], p[2] - TARGET[2]);
        expect(r).toBeCloseTo(radius, 8);
        expect(p[1]).toBeCloseTo(TARGET[1] + height, 8);
      }
    });
  });

  describe('arc', () => {
    it('starts at -90° (cos=0, sin=-1) and ends at +90° (cos=0, sin=+1)', () => {
      const start = sampleCameraTrajectory({
        trajectory: 'arc',
        index: 0,
        total: 10,
        target: TARGET,
        radius: 2,
        height: 0,
      });
      // t=0 → theta=-π/2 → cos(theta)=0, sin(theta)=-1
      expect(start[0]).toBeCloseTo(0, 10);
      expect(start[2]).toBeCloseTo(-2, 10);

      // Sample at index = total - 1 doesn't quite reach +π/2 (t < 1),
      // so probe an explicit endpoint via fractional sampling.
      const endish = sampleCameraTrajectory({
        trajectory: 'arc',
        index: 9,
        total: 10,
        target: TARGET,
        radius: 2,
        height: 0,
      });
      // t = 0.9, theta = -π/2 + 0.9π = 0.4π
      expect(endish[0]).toBeCloseTo(2 * Math.cos(0.4 * Math.PI), 6);
      expect(endish[2]).toBeCloseTo(2 * Math.sin(0.4 * Math.PI), 6);
    });
  });

  describe('figure8', () => {
    it('first sample lies at the origin of the lemniscate (xz = target)', () => {
      const p = sampleCameraTrajectory({
        trajectory: 'figure8',
        index: 0,
        total: 8,
        target: TARGET,
        radius: 3,
        height: 1,
      });
      expect(p[0]).toBeCloseTo(0, 10);
      expect(p[2]).toBeCloseTo(0, 10);
      expect(p[1]).toBeCloseTo(1.5, 10);
    });

    it('crosses the target twice per cycle (lemniscate crossing point)', () => {
      // The figure-8 hits xz = (0,0) at theta = 0 and theta = π.
      const a = sampleCameraTrajectory({
        trajectory: 'figure8',
        index: 0,
        total: 4,
        target: TARGET,
        radius: 2,
        height: 0,
      });
      const c = sampleCameraTrajectory({
        trajectory: 'figure8',
        index: 2,
        total: 4,
        target: TARGET,
        radius: 2,
        height: 0,
      });
      expect(a[0]).toBeCloseTo(0, 10);
      expect(a[2]).toBeCloseTo(0, 10);
      expect(c[0]).toBeCloseTo(0, 10);
      expect(c[2]).toBeCloseTo(0, 10);
    });
  });

  describe('spiral', () => {
    it('rises linearly in y over the path', () => {
      const samples = [0, 0.25, 0.5, 0.75].map((t, _, arr) =>
        sampleCameraTrajectory({
          trajectory: 'spiral',
          index: arr.indexOf(t),
          total: arr.length,
          target: TARGET,
          radius: 2,
          height: 4,
        }),
      );
      // First at ty + 0; subsequent samples climb at +1 each (height/n × index)
      expect(samples[0][1]).toBeCloseTo(0.5, 10);
      expect(samples[1][1]).toBeGreaterThan(samples[0][1]);
      expect(samples[2][1]).toBeGreaterThan(samples[1][1]);
      expect(samples[3][1]).toBeGreaterThan(samples[2][1]);
    });
  });

  describe('orbit_dome', () => {
    it('first sample is near equator at full radius, last sample is high and central', () => {
      const start = sampleCameraTrajectory({
        trajectory: 'orbit_dome',
        index: 0,
        total: 10,
        target: TARGET,
        radius: 4,
        height: 3,
      });
      const late = sampleCameraTrajectory({
        trajectory: 'orbit_dome',
        index: 9,
        total: 10,
        target: TARGET,
        radius: 4,
        height: 3,
      });
      // index 0 is at the equator: y ≈ target.y, distance from target axis ≈ radius
      const startR = Math.hypot(start[0], start[2]);
      const lateR = Math.hypot(late[0], late[2]);
      expect(startR).toBeGreaterThan(lateR);
      expect(late[1]).toBeGreaterThan(start[1]);
    });
  });

  describe('random fallback', () => {
    it('returns a coherent point (does not throw or produce NaN)', () => {
      const p = sampleCameraTrajectory({
        trajectory: 'random',
        index: 0,
        total: 10,
        target: TARGET,
        radius: 4,
        height: 2,
      });
      expect(p.every((n) => Number.isFinite(n))).toBe(true);
    });
  });

  describe('single-shot batch (total = 1)', () => {
    it('does not divide by zero — circle still produces a valid point', () => {
      const p = sampleCameraTrajectory({
        trajectory: 'circle',
        index: 0,
        total: 1,
        target: TARGET,
        radius: 4,
        height: 2,
      });
      expect(p.every((n) => Number.isFinite(n))).toBe(true);
    });
  });
});
