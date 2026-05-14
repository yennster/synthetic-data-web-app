import type { CameraTrajectory } from '../store/useStore';

/**
 * Compute a camera position for iteration `i` of `total` along the
 * selected trajectory, orbiting around `target`. Positions are returned
 * in world space; the caller is expected to also point `camTarget` at
 * `target` so the frame stays composed regardless of where the camera
 * lands.
 *
 * Trajectories:
 *   - `circle`     : horizontal ring at constant height (= target.y + height)
 *   - `figure8`    : lemniscate (figure-eight) at constant height
 *   - `arc`        : 180° front arc — same as `circle` but only the front
 *                    half-circle (theta sweeps -π/2 → +π/2)
 *   - `spiral`     : ascending helix from low to high
 *   - `orbit_dome` : helix that also rises in polar angle, sampling the
 *                    upper hemisphere — good for dataset diversity
 *
 * `radius` is the in-plane orbit radius. `height` is the vertical
 * amplitude used by the path (constant for `circle` / `figure8` / `arc`,
 * total rise for `spiral`, and max altitude for `orbit_dome`).
 */
export function sampleCameraTrajectory(opts: {
  trajectory: CameraTrajectory;
  index: number;
  total: number;
  target: [number, number, number];
  radius: number;
  height: number;
}): [number, number, number] {
  const { trajectory, index, total, target, radius, height } = opts;
  const n = Math.max(1, total);
  // Sample in (0, 1] so a single-shot batch (i = 0, n = 1) lands at the
  // start of the path rather than degenerating to phase = 0.5.
  const t = n === 1 ? 0 : index / n;
  const [tx, ty, tz] = target;
  switch (trajectory) {
    case 'circle': {
      const theta = t * Math.PI * 2;
      return [
        tx + Math.cos(theta) * radius,
        ty + height,
        tz + Math.sin(theta) * radius,
      ];
    }
    case 'figure8': {
      // Lemniscate of Gerono: x = r·sin(2θ)/2, z = r·sin(θ).
      const theta = t * Math.PI * 2;
      return [
        tx + (radius * Math.sin(2 * theta)) / 2,
        ty + height,
        tz + radius * Math.sin(theta),
      ];
    }
    case 'arc': {
      // Front-facing 180° sweep: θ goes from -π/2 to +π/2 so the camera
      // arcs in front of the subject without ever pointing from behind.
      const theta = -Math.PI / 2 + t * Math.PI;
      return [
        tx + Math.cos(theta) * radius,
        ty + height,
        tz + Math.sin(theta) * radius,
      ];
    }
    case 'spiral': {
      // Helix: orbit while rising linearly from y = ty to y = ty + height.
      const turns = 2;
      const theta = t * Math.PI * 2 * turns;
      return [
        tx + Math.cos(theta) * radius,
        ty + t * height,
        tz + Math.sin(theta) * radius,
      ];
    }
    case 'orbit_dome': {
      // Camera traces a dome: at t = 0 it's near the equator (low),
      // at t = 1 it's near the zenith (high). Azimuth sweeps multiple
      // turns to cover the dataset evenly.
      const turns = 3;
      const azim = t * Math.PI * 2 * turns;
      // Polar angle from equator (φ = π/2) up to near-zenith (φ = 0.2).
      const polar = Math.PI / 2 - t * (Math.PI / 2 - 0.2);
      const r = radius * Math.sin(polar);
      const y = ty + Math.max(0.1, Math.cos(polar) * Math.max(height, 0.1));
      return [tx + Math.cos(azim) * r, y, tz + Math.sin(azim) * r];
    }
    case 'random':
    default:
      // The random path is handled by the legacy jitter pass; return
      // the target as a harmless fallback so callers that forget to
      // branch still get a coherent result.
      return [tx, ty + height, tz + radius];
  }
}
