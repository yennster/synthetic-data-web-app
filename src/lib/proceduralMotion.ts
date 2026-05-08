/**
 * Pure helpers used by the procedural-motion runner in `MotionPanel.tsx`.
 * Extracted here so the timing logic can be unit-tested without booting
 * the whole zustand store + r3f scene.
 */

/**
 * Pick a random pre-release pause for a procedural recording window of
 * `durationMs`. The returned value is the time between the start of
 * recording and the moment the body is released (or starts an
 * accelerate-and-release sequence) — picked so that:
 *
 *   - the trace always carries at least ~40 ms of pre-release baseline
 *     before the impulse, so EI's first samples reflect the kinematic
 *     hold pose rather than a half-applied release
 *   - the release lands well inside the recording window — capped at
 *     15 % of `durationMs` and at most 200 ms total — so the bulk of the
 *     trace is the actual motion under test
 *
 * Returns a finite number ≥ 40 ms. With `durationMs = 1500` the returned
 * value is uniform on `[40, 200]`. With `durationMs = 300` (the minimum
 * the UI permits) it's `[40, 85]`.
 */
export function randomPreReleaseMs(
  durationMs: number,
  rng: () => number = Math.random,
): number {
  const cap = Math.min(160, durationMs * 0.15);
  return 40 + rng() * Math.max(0, cap);
}
