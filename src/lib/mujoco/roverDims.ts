/**
 * Shared rover geometry constants — read by both the visual rig
 * (`Rover.tsx`) and the MJCF (`roverMjcf.ts`) so the rendered mesh and
 * the simulated body agree on dimensions. Editing either one in
 * isolation produces a visible mismatch (sensors floating above the
 * chassis, lidar beams emitted from the wrong height, etc.), so any
 * tweak should land here.
 */

export const ROVER_DIMS = {
  chassis: { w: 0.5, h: 0.18, d: 0.7 },
  wheelR: 0.12,
  wheelT: 0.07,
  rideHeight: 0.05,
  headSize: 0.18,
  /** Bounding-circle radius used by contact detection. Slightly larger
   * than the chassis half-diagonal so the contact event triggers a hair
   * before geometric overlap, matching how a real bumper switch fires. */
  chassisDiscR: 0.36,
} as const;
