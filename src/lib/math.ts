/**
 * Small math helpers used across components, lib/, and mujoco/.
 *
 * Centralized so we have one well-tested implementation instead of
 * ~30 open-coded `Math.max(lo, Math.min(hi, v))` blocks scattered
 * across the codebase. None of these throw — they coerce non-finite
 * inputs to a sensible default (typically the lower bound) so a stray
 * `NaN` in the render loop doesn't propagate.
 */

/** Clamp `v` to the closed interval [lo, hi]. NaN / Infinity collapse
 * to `lo` rather than silently leaking through. */
export function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/** Clamp to [0, 1] — the common case for intensity / mix values. */
export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** Linear interpolation: returns `a + (b - a) * t`. `t` is NOT clamped;
 * callers that want clamped behaviour should `clamp01(t)` first. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Smoothstep: cubic Hermite interpolation between 0 and 1 with
 * zero-slope endpoints. Expects `t ∈ [0, 1]`. */
export function smoothstep(t: number): number {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
}

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** Degrees → radians. */
export function degToRad(deg: number): number {
  return deg * DEG_TO_RAD;
}

/** Radians → degrees. */
export function radToDeg(rad: number): number {
  return rad * RAD_TO_DEG;
}

/** Wrap an angle in radians into `(-π, π]`. Useful for delta-angle
 * calculations where the raw difference could exceed π. */
export function wrapAngle(rad: number): number {
  const TWO_PI = Math.PI * 2;
  let a = rad % TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  else if (a <= -Math.PI) a += TWO_PI;
  return a;
}
