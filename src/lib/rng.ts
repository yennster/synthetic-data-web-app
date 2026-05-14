/**
 * App-wide random number generator with optional seeding.
 *
 * When `?seed=12345` is set in the URL, this module returns a
 * deterministic mulberry32 sequence — so a batch capture run yields
 * the same scene jitter, the same realism noise, the same arm-pickup
 * positions on every page load. Without `?seed`, it falls through to
 * `Math.random` (the prior behaviour).
 *
 * Not every random call in the codebase is routed through here yet —
 * the procedural motion runner and a handful of one-shot UI niceties
 * still call `Math.random` directly. The seed contract is documented
 * in `docs/url-parameters.md`: batch jitter (camera/lighting/objects)
 * and the realism post-process are seeded; motion-mode drops are not.
 */

import { URL_PRESETS } from './urlParams';

/** Branded seedable RNG so tests can pin sequences. Same shape as
 * `Math.random` — returns a uniform [0, 1) — but deterministic when
 * constructed with a seed. */
export type Rng = () => number;

/**
 * Mulberry32 — a 32-bit non-cryptographic PRNG with a 32-bit period
 * but extremely fast (no `Math` calls in the hot path) and good
 * uniformity for our purposes. The seed is the only state.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let _rng: Rng | null = null;

function ensureRng(): Rng {
  if (_rng) return _rng;
  const seed = URL_PRESETS.seed;
  _rng = typeof seed === 'number' ? mulberry32(seed) : Math.random;
  return _rng;
}

/** Returns a uniform number in [0, 1). Seeded when `?seed=N` is set. */
export function rng(): number {
  return ensureRng()();
}

/** Returns the underlying RNG function so callers can pass it to
 * helpers like `applyRealismToBlob({ rng })` and
 * `randomizeArmPickupPositions(rng)`. */
export function getRng(): Rng {
  return ensureRng();
}

/** True if the URL set an explicit `?seed=`. Useful for UI badges. */
export function isSeeded(): boolean {
  return typeof URL_PRESETS.seed === 'number';
}

/** Reset for tests. */
export function _resetRngForTest(rng?: Rng): void {
  _rng = rng ?? null;
}
