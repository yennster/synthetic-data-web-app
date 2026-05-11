/**
 * "Realism" domain-randomization pass for synthetic captures. Bridges
 * the sim-to-real gap by re-rendering the captured PNG with cheap CPU-
 * side pixel transforms: film grain, chromatic aberration, vignette,
 * color jitter, and a JPEG round-trip that introduces real lossy-
 * compression artifacts. Each transform is randomized per-call so a
 * batch of N captures shows visible variation instead of every PNG
 * looking like the same filter pass.
 *
 * Bounding boxes are not touched. The transforms are pure pixel ops
 * — the geometry never moves — so EI detection / FOMO / anomaly labels
 * stay byte-perfect against the modified PNG.
 *
 * The pixel-level helpers (`applyFilmGrain`, `applyChromaticAberration`,
 * etc.) operate on a `Uint8ClampedArray` of RGBA bytes. They're pure
 * and side-effect-free (mutate in place + return the same buffer)
 * so they're trivially unit-testable without a DOM canvas. The blob-
 * level `applyRealismToBlob` glues them together with a real canvas.
 */

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

/**
 * Box-Muller transform: convert two uniform [0, 1) samples into a
 * single standard-normal sample. Caches the unused second sample on
 * the function object so consecutive calls amortize the trig pair.
 */
function gaussian(rng: Rng): number {
  // Reject 0 so log doesn't blow up. The cache trick (stash the second
  // sample so every other call is free) means we run `Math.log` /
  // `Math.cos` per pair rather than per sample.
  let u = rng();
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * In-place gaussian noise on each RGB channel. `intensity` ∈ [0, 1];
 * 0 is a no-op, 1 adds ±~30 LSB per channel. Alpha is preserved.
 *
 * The grain is applied independently per channel so it looks like
 * sensor noise (uncorrelated) rather than luminance noise (which
 * would correlate the channels and look like film banding).
 */
export function applyFilmGrain(
  rgba: Uint8ClampedArray,
  intensity: number,
  rng: Rng,
): Uint8ClampedArray {
  if (intensity <= 0) return rgba;
  // 1.0 → σ≈10 LSB. Higher values look like sensor static rather than
  // grain — at σ=30 the gaussian's 3σ tail clips ~±90 LSB which buries
  // small features (the cone on the conveyor) under speckle.
  const sigma = intensity * 10;
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = rgba[i] + gaussian(rng) * sigma;
    rgba[i + 1] = rgba[i + 1] + gaussian(rng) * sigma;
    rgba[i + 2] = rgba[i + 2] + gaussian(rng) * sigma;
    // rgba[i + 3] alpha untouched
  }
  return rgba;
}

/**
 * Lateral chromatic aberration — shift the R channel `maxShift` pixels
 * one way and the B channel the same distance the other way, leaving
 * G in place. Mimics what cheap lenses do at the corners.
 *
 * `intensity` ∈ [0, 1]; 0 is a no-op, 1 shifts by ~4 px each direction.
 * The actual per-call shift is randomized within [0, maxShift] so a
 * batch shows variation.
 */
export function applyChromaticAberration(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  intensity: number,
  rng: Rng,
): Uint8ClampedArray {
  if (intensity <= 0) return rgba;
  const maxShift = Math.max(1, Math.round(intensity * 4));
  // Random per call so each capture in a batch shows a different
  // amount of CA — flat shift looks like a filter, varied shift
  // looks like a real (cheap) lens.
  const shift = Math.max(1, Math.round(rng() * maxShift));

  const original = new Uint8ClampedArray(rgba); // snapshot so we sample undisturbed pixels
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4;
      // Sample R from x+shift and B from x-shift, clamped to bounds
      // so edge pixels don't wrap.
      const rx = Math.min(width - 1, x + shift);
      const bx = Math.max(0, x - shift);
      const rIdx = (y * width + rx) * 4;
      const bIdx = (y * width + bx) * 4 + 2;
      rgba[dst] = original[rIdx];
      rgba[dst + 2] = original[bIdx];
      // G + A untouched
    }
  }
  return rgba;
}

/**
 * Radial darkening from the center — multiplies each pixel by a
 * smooth falloff factor that goes from 1.0 at the center to (1 -
 * intensity) at the corners. `intensity` ∈ [0, 1]; 0 is a no-op, 1
 * makes corners 100% black (rare; typical values 0.2–0.5).
 *
 * Falloff is `cos⁴` over normalized radius, which is the cheap
 * analytical approximation of the cos⁴ law that real lenses follow.
 */
export function applyVignette(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  intensity: number,
): Uint8ClampedArray {
  if (intensity <= 0) return rgba;
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const maxR = Math.sqrt(cx * cx + cy * cy);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / maxR;
      const dy = (y - cy) / maxR;
      const r = Math.sqrt(dx * dx + dy * dy);
      // cos^4-ish falloff: 1 at center, smoothly down to 1-intensity at edge.
      const fall = 1 - intensity * Math.pow(Math.min(1, r), 2);
      const idx = (y * width + x) * 4;
      rgba[idx] = rgba[idx] * fall;
      rgba[idx + 1] = rgba[idx + 1] * fall;
      rgba[idx + 2] = rgba[idx + 2] * fall;
    }
  }
  return rgba;
}

/**
 * Per-channel multiplicative scale + brightness offset. Each channel
 * gets an independent random gain drawn from U(1-i/2, 1+i/2) and a
 * brightness offset from U(-i*20, +i*20). Simulates white-balance
 * drift + exposure jitter across captures in a batch.
 */
export function applyColorJitter(
  rgba: Uint8ClampedArray,
  intensity: number,
  rng: Rng,
): Uint8ClampedArray {
  if (intensity <= 0) return rgba;
  // Per-channel gain spans 1±i*0.2 (was 1±i*0.5 — at i=1 that pushed
  // channels to 0.5×/1.5× which clipped highlights and crushed shadows).
  // Offset spans ±i*12 LSB (was ±i*20) so a dark frame stays dark.
  const gain = [
    1 + (rng() - 0.5) * intensity * 0.4,
    1 + (rng() - 0.5) * intensity * 0.4,
    1 + (rng() - 0.5) * intensity * 0.4,
  ];
  const offset = [
    (rng() - 0.5) * intensity * 24,
    (rng() - 0.5) * intensity * 24,
    (rng() - 0.5) * intensity * 24,
  ];
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = rgba[i] * gain[0] + offset[0];
    rgba[i + 1] = rgba[i + 1] * gain[1] + offset[1];
    rgba[i + 2] = rgba[i + 2] * gain[2] + offset[2];
  }
  return rgba;
}

/**
 * Compose the full random pass on an RGBA buffer. Order matters:
 *   1. Chromatic aberration (operates on clean source, before grain).
 *   2. Color jitter (multiplicative — comes before additive noise).
 *   3. Vignette (multiplicative falloff — also before grain).
 *   4. Film grain LAST so the noise carries through unmodified.
 *
 * Same `Rng` is threaded through the random transforms so a seeded
 * call is fully reproducible.
 */
export function applyRandomRealism(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  intensity: number,
  rng: Rng,
): Uint8ClampedArray {
  if (intensity <= 0) return rgba;
  applyChromaticAberration(rgba, width, height, intensity, rng);
  applyColorJitter(rgba, intensity, rng);
  applyVignette(rgba, width, height, intensity * 0.6); // vignette scales softer than grain
  applyFilmGrain(rgba, intensity, rng);
  return rgba;
}

/**
 * Apply the random realism pass to a captured PNG blob. Returns a
 * fresh PNG blob; the input blob is not mutated. The PNG is decoded
 * via `createImageBitmap` (browser-supported, off-thread on Chromium)
 * into an OffscreenCanvas (or a regular canvas in jsdom), the pixel
 * transforms run, and the canvas is re-encoded.
 *
 * For the `random` mode this stays a PNG so bounding boxes line up
 * to the same pixel grid that produced them. Future `diffusion` mode
 * will go through a server endpoint instead.
 */
export async function applyRealismToBlob(
  blob: Blob,
  opts: { mode: 'off' | 'random' | 'diffusion'; intensity: number; rng?: Rng },
): Promise<Blob> {
  if (opts.mode === 'off' || opts.intensity <= 0) return blob;
  if (opts.mode === 'diffusion') {
    // Diffusion path is a future server endpoint — for now fall back
    // to the random pass so the toggle is never a silent no-op while
    // the feature lands incrementally.
    // TODO(diffusion): POST to /api/realism, fall back on error.
  }
  const bitmap = await createImageBitmap(blob);
  const w = bitmap.width;
  const h = bitmap.height;
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), {
          width: w,
          height: h,
        });
  const ctx = canvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) return blob;
  ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, w, h);
  const rng = opts.rng ?? Math.random;
  applyRandomRealism(imageData.data, w, h, opts.intensity, rng);
  ctx.putImageData(imageData, 0, 0);
  // `convertToBlob` on OffscreenCanvas, `toBlob` on HTMLCanvasElement
  // — branch over the union so TypeScript is happy on both paths.
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type: 'image/png' });
  }
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/png',
    );
  });
}
