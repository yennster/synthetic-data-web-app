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

import { mulberry32, type Rng } from './realism';
import { URL_PRESETS } from './urlParams';

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
