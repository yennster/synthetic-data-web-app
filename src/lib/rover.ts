/**
 * Rover trajectory engine — event-aware paths that drive the chassis
 * through one of three labelled scenarios per recording window:
 *
 *   - `cruise`     normal driving, no contact with any obstacle
 *   - `collision`  rover drives directly into an obstacle mid-window
 *   - `stuck`      one wheel pinned against an obstacle, brief vibration
 *
 * These three labels are the standard Edge Impulse "robot event"
 * dataset (see Edge Impulse's continuous-motion / impact tutorials).
 * Picking one of them — instead of "what shape is the path" — gives a
 * real ML target: the chassis IMU window can't be predicted from the
 * command stream alone, so a model trained on it has actual work to do.
 *
 * Each generator returns a `ParametricPath` keyed on normalized time
 * `t ∈ [0, 1]`. The runner advances `t` so the recording window covers
 * the whole traversal, and the contact detector (in `contact.ts`)
 * watches the rover's chassis disc against the obstacle list each
 * frame — it produces the actual contact events that feed the IMU
 * impulse and the recorded label.
 */

// Re-exported from the store so urlParams + rover.ts share one source.
// The store is the canonical home because the persisted RoverEvent
// state lives there.
import type { RoverEvent } from '../store/useStore';
import { clamp01 } from './math';

export type RoverPose = { x: number; z: number; heading: number };

export type ParametricPath = {
  /** Pose at normalized time `t`. Caller clamps t to [0, 1]. */
  sample: (t: number) => RoverPose;
};

/** Obstacle stored as a circle-on-the-ground for path planning. The
 * scene renders boxes / cones / pillars as before, but the planner
 * only needs a bounding radius for "stay this far away from each one"
 * (`cruise`) or "head straight at one of them" (`collision`). */
export type ObstacleDisc = { x: number; z: number; r: number };

/**
 * Build a path for the requested event. `obstacles` is the live obstacle
 * field at recording time — generators read it to either avoid every
 * disc (cruise) or aim directly at one (collision/stuck). When the
 * field is empty, the generators fall back to a short forward cruise so
 * the rover still moves.
 *
 * `rng` defaults to `Math.random`. Tests pass a seeded RNG to make
 * trajectories deterministic.
 */
export function buildEventPath(
  event: RoverEvent,
  obstacles: readonly ObstacleDisc[],
  rng: () => number = Math.random,
): ParametricPath {
  switch (event) {
    case 'collision':
      return buildCollisionPath(obstacles, rng);
    case 'stuck':
      return buildStuckPath(obstacles, rng);
    case 'cruise':
    default:
      return buildCruisePath(obstacles, rng);
  }
}

/** Pick a smooth path that stays at least `clearance` away from every
 * obstacle. Implementation: sample candidate (start, end) point pairs
 * across a spawn disc until one's straight-line connector clears every
 * obstacle. If the straight-line search fails (very dense obstacle
 * fields), fall back to a circular arc orbiting the origin at a
 * radius outside the obstacle field — that always clears the inner
 * obstacles by construction.
 */
function buildCruisePath(
  obstacles: readonly ObstacleDisc[],
  rng: () => number,
): ParametricPath {
  const SPAWN_R = 4.0;
  const CLEARANCE = 0.55; // chassis half-diagonal + a small margin
  const MAX_TRIES = 80;
  for (let i = 0; i < MAX_TRIES; i++) {
    const a = rng() * Math.PI * 2;
    const b = a + Math.PI + (rng() - 0.5) * 0.6;
    const r1 = SPAWN_R * (0.7 + rng() * 0.3);
    const r2 = SPAWN_R * (0.7 + rng() * 0.3);
    const start = { x: Math.cos(a) * r1, z: Math.sin(a) * r1 };
    const end = { x: Math.cos(b) * r2, z: Math.sin(b) * r2 };
    if (segmentClears(start, end, obstacles, CLEARANCE)) {
      const dx = end.x - start.x;
      const dz = end.z - start.z;
      const heading = Math.atan2(dx, dz);
      return {
        sample: (t) => {
          const u = clamp01(t);
          return {
            x: start.x + dx * u,
            z: start.z + dz * u,
            heading,
          };
        },
      };
    }
  }
  // Fallback: orbit the origin at a radius that's safely outside any
  // obstacle in the field. Equivalent to "go around the whole thing"
  // and provably clears every obstacle so long as the orbit radius
  // exceeds (max obstacle radius + max obstacle distance + clearance).
  let outerR = SPAWN_R;
  for (const o of obstacles) {
    const d = Math.sqrt(o.x * o.x + o.z * o.z) + o.r + CLEARANCE;
    if (d > outerR) outerR = d;
  }
  const startAngle = rng() * Math.PI * 2;
  const sweep = Math.PI / 2 + rng() * Math.PI; // 90°–270° arc
  const ccw = rng() > 0.5 ? 1 : -1;
  return {
    sample: (t) => {
      const u = clamp01(t);
      const a = startAngle + ccw * sweep * u;
      return {
        x: outerR * Math.cos(a),
        z: outerR * Math.sin(a),
        heading: a + (ccw > 0 ? Math.PI / 2 : -Math.PI / 2),
      };
    },
  };
}

/** Pick the closest-aimable obstacle and drive a short straight path
 * from a launch point toward and past its center, so the contact
 * detector trips midway through the recording. The launch is offset
 * along the heading line so the impact lands well inside the window
 * (~60 % of the way through). */
function buildCollisionPath(
  obstacles: readonly ObstacleDisc[],
  rng: () => number,
): ParametricPath {
  if (obstacles.length === 0) return buildCruisePath(obstacles, rng);
  const target = obstacles[Math.floor(rng() * obstacles.length)];
  const angle = rng() * Math.PI * 2;
  const launchDist = 2.5 + rng() * 0.8; // 2.5–3.3 m from target
  const overshoot = 0.6; // travel past the center so contact is mid-window
  const start = {
    x: target.x + Math.cos(angle) * launchDist,
    z: target.z + Math.sin(angle) * launchDist,
  };
  const heading = Math.atan2(target.x - start.x, target.z - start.z);
  const end = {
    x: target.x - Math.cos(angle) * overshoot,
    z: target.z - Math.sin(angle) * overshoot,
  };
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  return {
    sample: (t) => {
      const u = clamp01(t);
      return {
        x: start.x + dx * u,
        z: start.z + dz * u,
        heading,
      };
    },
  };
}

/** Place the rover with one wheel pinned against an obstacle and
 * "drive in place" — the kinematic pose oscillates by a few cm with
 * bounded heading jitter, simulating a robot trying to push past
 * something it can't move. The contact detector sees the rover
 * permanently overlapping the obstacle, so the recorded sample is
 * one continuous in-contact window with a vibration signature. */
function buildStuckPath(
  obstacles: readonly ObstacleDisc[],
  rng: () => number,
): ParametricPath {
  if (obstacles.length === 0) return buildCruisePath(obstacles, rng);
  const target = obstacles[Math.floor(rng() * obstacles.length)];
  const approach = rng() * Math.PI * 2;
  // Pin the rover's chassis disc deep enough into the obstacle that
  // the vibration oscillation never breaks contact. Default chassis
  // radius is 0.36; with a 4 cm vibration amplitude we need at least
  // ~5 cm of static overlap to keep `detectContact` firing every tick.
  const pinDist = target.r + 0.26;
  const center = {
    x: target.x - Math.cos(approach) * pinDist,
    z: target.z - Math.sin(approach) * pinDist,
  };
  const heading = Math.atan2(target.x - center.x, target.z - center.z);
  const ampX = 0.03;
  const ampZ = 0.03;
  const freq = 5 + rng() * 3;
  const headingJitter = 0.05;
  return {
    sample: (t) => {
      const phase = t * 2 * Math.PI * freq;
      return {
        x: center.x + Math.sin(phase) * ampX,
        z: center.z + Math.cos(phase * 1.13) * ampZ,
        heading: heading + Math.sin(phase * 0.7) * headingJitter,
      };
    },
  };
}

/** True if the segment from `a` to `b` stays at least `clearance` away
 * from every obstacle. Used by `cruise` path acceptance. */
function segmentClears(
  a: { x: number; z: number },
  b: { x: number; z: number },
  obstacles: readonly ObstacleDisc[],
  clearance: number,
): boolean {
  for (const o of obstacles) {
    if (pointToSegmentDist(o, a, b) < o.r + clearance) return false;
  }
  return true;
}

function pointToSegmentDist(
  p: { x: number; z: number },
  a: { x: number; z: number },
  b: { x: number; z: number },
): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const apx = p.x - a.x;
  const apz = p.z - a.z;
  const ab2 = abx * abx + abz * abz;
  if (ab2 < 1e-9) {
    const dx = p.x - a.x;
    const dz = p.z - a.z;
    return Math.sqrt(dx * dx + dz * dz);
  }
  let t = (apx * abx + apz * abz) / ab2;
  t = clamp01(t);
  const cx = a.x + abx * t;
  const cz = a.z + abz * t;
  const dx = p.x - cx;
  const dz = p.z - cz;
  return Math.sqrt(dx * dx + dz * dz);
}

