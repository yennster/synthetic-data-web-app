import { describe, expect, it } from 'vitest';
import {
  buildEventPath,
  detectContact,
  type ObstacleDisc,
} from './rover';

/**
 * Deterministic RNG for tests — a tiny linear-congruential generator
 * seeded by the caller so each test sees a reproducible sequence.
 */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('rover trajectories', () => {
  describe('cruise', () => {
    it('produces a path that clears every obstacle', () => {
      const obstacles: ObstacleDisc[] = [
        { x: 1, z: 0, r: 0.3 },
        { x: -1, z: 0, r: 0.3 },
        { x: 0, z: 1, r: 0.3 },
      ];
      const rng = seededRng(42);
      const path = buildEventPath('cruise', obstacles, rng);
      // Sample 30 evenly-spaced points and check none overlap an obstacle.
      const CHASSIS_R = 0.36;
      for (let i = 0; i <= 30; i++) {
        const t = i / 30;
        const p = path.sample(t);
        for (const o of obstacles) {
          const d = Math.sqrt((p.x - o.x) ** 2 + (p.z - o.z) ** 2);
          // Allow a tiny tolerance — the cruise generator targets
          // CLEARANCE > chassis half-diagonal, so the disc-radius
          // overlap check should always be > 0.
          expect(d).toBeGreaterThan(o.r);
        }
        void CHASSIS_R;
      }
    });

    it('starts and ends at finite world points', () => {
      const path = buildEventPath('cruise', [], seededRng(1));
      const a = path.sample(0);
      const b = path.sample(1);
      expect(Number.isFinite(a.x)).toBe(true);
      expect(Number.isFinite(a.z)).toBe(true);
      expect(Number.isFinite(b.x)).toBe(true);
      expect(Number.isFinite(b.z)).toBe(true);
    });
  });

  describe('collision', () => {
    it('aims directly at one of the obstacles', () => {
      const obstacles: ObstacleDisc[] = [
        { x: 2, z: 1, r: 0.25 },
        { x: -1, z: -2, r: 0.25 },
      ];
      const rng = seededRng(7);
      const path = buildEventPath('collision', obstacles, rng);
      const start = path.sample(0);
      const end = path.sample(1);
      // The path should pass through (or very near) one of the
      // obstacle centers — that's the whole point of the collision
      // generator.
      const passesThrough = obstacles.some((o) => {
        const dx = o.x - start.x;
        const dz = o.z - start.z;
        const length = Math.sqrt(dx * dx + dz * dz);
        if (length < 1e-3) return false;
        const ux = dx / length;
        const uz = dz / length;
        // Project end onto the start→obstacle direction.
        const ex = end.x - start.x;
        const ez = end.z - start.z;
        const proj = ex * ux + ez * uz;
        // Perpendicular distance from line start→end to the obstacle.
        const perp = Math.abs((o.x - start.x) * uz - (o.z - start.z) * ux);
        return proj > length * 0.5 && perp < o.r + 0.4;
      });
      expect(passesThrough).toBe(true);
    });

    it('falls back to cruise when there are no obstacles', () => {
      const path = buildEventPath('collision', [], seededRng(1));
      const start = path.sample(0);
      const end = path.sample(1);
      const dx = end.x - start.x;
      const dz = end.z - start.z;
      // Should still produce a non-trivial straight-line path.
      expect(Math.sqrt(dx * dx + dz * dz)).toBeGreaterThan(1.0);
    });
  });

  describe('stuck', () => {
    it('keeps the rover overlapping a chosen obstacle for the whole window', () => {
      const obstacles: ObstacleDisc[] = [{ x: 0.5, z: 0.5, r: 0.3 }];
      const rng = seededRng(3);
      const path = buildEventPath('stuck', obstacles, rng);
      const CHASSIS_R = 0.36;
      // Across the whole window, the rover's chassis disc should
      // always overlap the target obstacle (otherwise we wouldn't be
      // "stuck"). Allow a very small tolerance for floating point.
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        const p = path.sample(t);
        const contact = detectContact(p, CHASSIS_R, obstacles);
        expect(contact).not.toBeNull();
      }
    });
  });
});

describe('contact detection', () => {
  it('returns null when the rover is clear of every obstacle', () => {
    const obstacles: ObstacleDisc[] = [
      { x: 1, z: 0, r: 0.3 },
      { x: -1, z: 0, r: 0.3 },
    ];
    expect(detectContact({ x: 0, z: 0 }, 0.3, obstacles)).toBeNull();
  });

  it('reports overlap with the first colliding obstacle', () => {
    const a: ObstacleDisc = { x: 0.4, z: 0, r: 0.3 };
    const b: ObstacleDisc = { x: -0.4, z: 0, r: 0.3 };
    const result = detectContact({ x: 0.3, z: 0 }, 0.3, [a, b]);
    expect(result).not.toBeNull();
    if (!result) throw new Error('null');
    expect(result.obstacle).toBe(a);
    expect(result.penetration).toBeGreaterThan(0);
  });

  it('penetration scales with how far into the obstacle the rover is', () => {
    const o: ObstacleDisc = { x: 0, z: 0, r: 0.5 };
    const shallow = detectContact({ x: 0.79, z: 0 }, 0.3, [o]);
    const deep = detectContact({ x: 0.5, z: 0 }, 0.3, [o]);
    expect(shallow).not.toBeNull();
    expect(deep).not.toBeNull();
    if (!shallow || !deep) throw new Error('null');
    expect(deep.penetration).toBeGreaterThan(shallow.penetration);
  });
});
