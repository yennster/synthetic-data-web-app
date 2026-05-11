import * as THREE from 'three';

/**
 * Cast `bins` evenly-spaced rays in the horizontal plane around `origin`,
 * each capped at `maxRange`, and return the hit distance per bin.
 *
 * Bin 0 points along the rover's forward axis (+Z in the rover's local
 * frame, rotated by `heading` into world space) and bins sweep CCW about
 * +Y. Bins that don't hit anything within `maxRange` are clamped to that
 * value — same semantics as a real ToF sensor reporting "no return."
 *
 * `target` is the three.js node (typically the obstacles group) the rays
 * intersect against. The rover's own meshes must NOT be inside `target`,
 * or every beam reports a near-zero hit on the chassis.
 *
 * Internally we re-use a single `Raycaster` and scratch vectors per call;
 * caller ownership is irrelevant since `intersectObject` returns fresh
 * arrays. This keeps allocation off the hot path when called every frame.
 */
const ray = new THREE.Raycaster();
const dirVec = new THREE.Vector3();
const originVec = new THREE.Vector3();

type LidarOptions = {
  origin: { x: number; y: number; z: number };
  /** Forward yaw in radians; bin 0 is along this direction. */
  heading: number;
  bins: number;
  maxRange: number;
  /** Scene subtree to scan against (e.g., a `<group>` ref containing
   * obstacles). Recursed by the raycaster. */
  target: THREE.Object3D;
};

export function scanLidar({
  origin,
  heading,
  bins,
  maxRange,
  target,
}: LidarOptions): number[] {
  originVec.set(origin.x, origin.y, origin.z);
  ray.near = 0.01;
  ray.far = maxRange;
  const out: number[] = new Array(bins);
  for (let i = 0; i < bins; i++) {
    const theta = heading + (i / bins) * Math.PI * 2;
    dirVec.set(Math.sin(theta), 0, Math.cos(theta));
    ray.set(originVec, dirVec);
    const hits = ray.intersectObject(target, true);
    out[i] = hits.length > 0 && hits[0].distance <= maxRange
      ? hits[0].distance
      : maxRange;
  }
  return out;
}
