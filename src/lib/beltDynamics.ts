import type { RapierRigidBody } from '@react-three/rapier';

/**
 * Module-level registry of dynamic rigid bodies that should be carried by an
 * active conveyor belt.
 *
 * Spawned objects register themselves when they mount and deregister when they
 * unmount. The Conveyor's useFrame iterates this set each tick and overrides
 * the Z velocity of any body resting on top of the belt to match the belt
 * speed. This is a deliberate physics shortcut (rapier doesn't model surface
 * velocity natively in the version we're on) — it's stable, debounced by the
 * fixed-timestep solver, and gives the right visual + behavioural result.
 */
export const BELT_TRANSPORTABLES = new Set<RapierRigidBody>();

// Belt geometry — must match the constants in Conveyor.tsx.
export const BELT_LENGTH = 8;
export const BELT_WIDTH = 1.6;
/** Visual thickness of the belt slab. */
export const BELT_HEIGHT = 0.1;
/** Y world position of the top of the belt (where objects sit). The whole
 * conveyor — belt slab, rails, end caps, support legs — is positioned
 * relative to this so the legs stand on the ground (y=0) and the belt sits
 * comfortably above it. */
export const BELT_TOP_Y = 0.5;
/** Collider depth — extends below BELT_TOP_Y so fast-falling objects don't
 * tunnel through the thin visual surface. */
export const BELT_COLLIDER_DEPTH = 0.4;

/**
 * Returns true when the body's translation is within the belt's XZ footprint
 * AND its Y is in a thin band just above the belt surface (so falling objects
 * aren't snapped sideways from outside the belt extent).
 */
export function isOnBelt(t: { x: number; y: number; z: number }): boolean {
  return (
    Math.abs(t.x) < BELT_WIDTH / 2 &&
    Math.abs(t.z) < BELT_LENGTH / 2 &&
    t.y > BELT_TOP_Y - 0.05 &&
    t.y < BELT_TOP_Y + 0.8
  );
}

/**
 * Per-frame UV-offset advance for the conveyor's stripe texture, given the
 * belt's `speed` (m/s of world) and the elapsed `dt` (s) since the last
 * frame.
 *
 * The texture tiles `repeat` times across `length` meters of belt, so one
 * UV unit covers `length / repeat` meters of world. To make the visible
 * stripes scroll at the same world-space speed as the rigid bodies the
 * belt transports, the UV offset has to advance at `speed * repeat /
 * length` per second — the inverse of the world-per-UV ratio. Without
 * this scaling the stripes drift faster than the bodies (the original
 * bug — at the default `repeat=6, length=8` the texture used to slide
 * 1.33× too fast).
 *
 * Pure math, exported separately from the React component so the
 * `belt-texture-tracks-bodies` invariant has direct unit-test coverage
 * and can't silently regress.
 */
export function beltTextureOffsetDelta(
  speed: number,
  dt: number,
  repeat: number,
  length: number,
): number {
  return (speed * dt * repeat) / length;
}

/**
 * Convert a UV-offset advance back into the world-space distance the
 * stripes appear to travel. Inverse of the relationship encoded in
 * `beltTextureOffsetDelta`. Lets a test write `visualScrollDistance(...)
 * === bodyTravelDistance(...)` and have it actually be a check on the
 * speed-matching invariant rather than restating the formula.
 */
export function visualScrollDistance(
  offsetDelta: number,
  repeat: number,
  length: number,
): number {
  return (offsetDelta * length) / repeat;
}
