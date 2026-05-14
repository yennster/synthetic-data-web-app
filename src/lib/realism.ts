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

import { mulberry32, type Rng } from './rng';
export { mulberry32, type Rng };

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
 * Radial chromatic aberration — shift R outward and B inward along
 * the vector from the image center, with the shift magnitude scaling
 * with the squared distance from center. This is how real lenses
 * fail: zero CA at the optical center, max CA at the corners.
 *
 * `intensity` ∈ [0, 1]; 0 is a no-op, 1 shifts the corner channels
 * by ~5 px. Each call randomizes the corner-shift within [0, max]
 * so a batch shows variation rather than a flat filter.
 *
 * Bounding boxes stay valid against the result — the geometry never
 * moves, we're only resampling RGB channels at slightly offset
 * positions per pixel.
 */
export function applyChromaticAberration(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  intensity: number,
  rng: Rng,
): Uint8ClampedArray {
  if (intensity <= 0) return rgba;
  const maxCornerShift = intensity * 5;
  // Vary the corner shift per call so batches don't all look like the
  // same filter pass — bare minimum 1px so the effect is visible.
  const cornerShift = Math.max(1, rng() * maxCornerShift);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  // Normalize against the corner distance so `cornerShift` is the
  // pixel offset applied at the image corners specifically. r² gives
  // a softer ramp than linear r — closer to the cos⁴-style falloff
  // physical lenses exhibit.
  const maxRSq = cx * cx + cy * cy;
  const original = new Uint8ClampedArray(rgba);
  for (let y = 0; y < height; y++) {
    const dy = y - cy;
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const rSq = dx * dx + dy * dy;
      const t = rSq / maxRSq;
      const px = cornerShift * t; // shift magnitude in pixels at this radius
      // Direction: outward unit vector from center. Avoid div-by-zero
      // at the dead-center pixel (t==0 → no shift anyway).
      const r = Math.sqrt(rSq);
      const ux = r > 0 ? dx / r : 0;
      const uy = r > 0 ? dy / r : 0;
      const rShiftX = Math.round(ux * px);
      const rShiftY = Math.round(uy * px);
      const bShiftX = -rShiftX;
      const bShiftY = -rShiftY;
      const dst = (y * width + x) * 4;
      const rxs = Math.min(width - 1, Math.max(0, x + rShiftX));
      const rys = Math.min(height - 1, Math.max(0, y + rShiftY));
      const bxs = Math.min(width - 1, Math.max(0, x + bShiftX));
      const bys = Math.min(height - 1, Math.max(0, y + bShiftY));
      rgba[dst] = original[(rys * width + rxs) * 4];
      rgba[dst + 2] = original[(bys * width + bxs) * 4 + 2];
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

/** Per-effect intensities (0..1) for `applyRandomRealism`. Each knob
 * is independent so callers can compose, e.g. heavy grain + no
 * vignette. `jpeg` isn't in this struct because the JPEG round-trip
 * is a blob-level op (it needs the encoded image), not a pixel-buffer
 * op — it lives on `RealismIntensities` for `applyRealismToBlob`. */
export interface PixelIntensities {
  grain: number;
  chromatic: number;
  vignette: number;
  jitter: number;
}

/**
 * Compose the full random pass on an RGBA buffer. Order matters:
 *   1. Chromatic aberration (operates on clean source, before grain).
 *   2. Color jitter (multiplicative — comes before additive noise).
 *   3. Vignette (multiplicative falloff — also before grain).
 *   4. Film grain LAST so the noise carries through unmodified.
 *
 * Each transform receives its own intensity so users can dial them
 * independently. The same `Rng` is threaded through all four so a
 * seeded call is fully reproducible.
 */
export function applyRandomRealism(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  intensities: PixelIntensities,
  rng: Rng,
): Uint8ClampedArray {
  applyChromaticAberration(rgba, width, height, intensities.chromatic, rng);
  applyColorJitter(rgba, intensities.jitter, rng);
  applyVignette(rgba, width, height, intensities.vignette);
  applyFilmGrain(rgba, intensities.grain, rng);
  return rgba;
}

/**
 * How many img2img calls a single batch is allowed to spend on the
 * Hugging Face free tier before the realism pass falls back to the
 * local Random transform. Tuned so a worst-case cold-start of ~10s
 * per image still finishes in under 30s — beyond that the user
 * notices the wait and the rest of the batch would queue up anyway.
 *
 * Exported so the UI can show "first N of this batch" without having
 * to import a magic number directly.
 */
export const DIFFUSION_BUDGET = 3;

let diffusionBudgetRemaining = DIFFUSION_BUDGET;

/** Reset the per-batch HF budget. Call at the start of every batch
 * (and every single-shot capture) so the next sequence of diffusion
 * calls starts with the full quota. */
export function resetDiffusionBudget(): void {
  diffusionBudgetRemaining = DIFFUSION_BUDGET;
}

/** Full per-effect intensity bundle for the blob-level pass. Pixel
 * transforms get `grain` / `chromatic` / `vignette` / `jitter`; the
 * blob-level JPEG round-trip gets `jpeg`. */
export interface RealismIntensities extends PixelIntensities {
  jpeg: number;
}

/**
 * Apply the realism pass to a captured PNG blob. Returns a fresh PNG;
 * the input blob is not mutated.
 *
 * - `off`: return the input unchanged.
 * - `random`: decode → run pixel transforms → JPEG round-trip → re-
 *   encode as PNG (pure client-side, ~30-50ms, bounding-box-preserving).
 * - `diffusion`: for the first `DIFFUSION_BUDGET` calls of a batch,
 *   POST to `/api/realism-diffusion` (Vercel Function → HF Inference
 *   img2img). On any error — and for every call after the budget is
 *   spent — silently fall back to the `random` pass so the batch
 *   never stalls.
 */
export async function applyRealismToBlob(
  blob: Blob,
  opts: {
    mode: 'off' | 'random' | 'diffusion';
    intensities: RealismIntensities;
    /** When true, each invocation re-samples the effective intensity
     * for every effect in `[0, intensities[k]]`, so a batch produces
     * varied output instead of running the same fixed transform on
     * every PNG. The slider values then act as upper bounds. */
    randomize?: boolean;
    rng?: Rng;
  },
): Promise<Blob> {
  if (opts.mode === 'off') return blob;
  // Skip the whole pass when every knob is at 0 — equivalent to off,
  // saves a canvas round-trip per capture.
  const baseline = opts.intensities;
  if (
    baseline.grain <= 0 &&
    baseline.chromatic <= 0 &&
    baseline.vignette <= 0 &&
    baseline.jitter <= 0 &&
    baseline.jpeg <= 0
  ) {
    return blob;
  }
  const rng = opts.rng ?? Math.random;
  // When randomize is on, draw each effective intensity uniformly in
  // [0, slider]. The user's slider therefore acts as the *max* for
  // that effect across the batch, not a fixed value. Five rng()
  // calls so each effect has independent variation.
  const effective: RealismIntensities = opts.randomize
    ? {
        grain: baseline.grain * rng(),
        chromatic: baseline.chromatic * rng(),
        vignette: baseline.vignette * rng(),
        jitter: baseline.jitter * rng(),
        jpeg: baseline.jpeg * rng(),
      }
    : baseline;
  if (opts.mode === 'diffusion' && diffusionBudgetRemaining > 0) {
    // Decrement up front: even if the call fails, we've spent the
    // budget slot on the attempt. This keeps a slow / throttled HF
    // backend from burning through the whole budget on retries.
    diffusionBudgetRemaining -= 1;
    try {
      const diffused = await callDiffusionEndpoint(
        blob,
        // Diffusion has no per-effect knobs of its own — pass the
        // average across the pixel intensities as a rough "how much
        // realism" signal to the upstream model.
        (effective.grain +
          effective.chromatic +
          effective.vignette +
          effective.jitter) /
          4,
      );
      if (diffused) return diffused;
    } catch {
      // Fall through to random.
    }
  }
  return applyRandomToBlob(blob, effective, rng);
}

async function callDiffusionEndpoint(
  blob: Blob,
  intensity: number,
): Promise<Blob | null> {
  // Best-effort: if we're running under vitest / SSR where `fetch`
  // exists but `/api/realism-diffusion` doesn't, the response will be
  // a 404 and we return null so the caller falls back to random.
  const res = await fetch('/api/realism-diffusion', {
    method: 'POST',
    headers: {
      'Content-Type': 'image/png',
      'x-realism-intensity': String(intensity),
    },
    body: blob,
  });
  if (!res.ok) return null;
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.startsWith('image/')) return null;
  return res.blob();
}

async function applyRandomToBlob(
  blob: Blob,
  intensities: RealismIntensities,
  rng: Rng,
): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const w = bitmap.width;
  const h = bitmap.height;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) return blob;
  ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0);
  bitmap.close();
  const imageData = ctx.getImageData(0, 0, w, h);
  applyRandomRealism(imageData.data, w, h, intensities, rng);
  ctx.putImageData(imageData, 0, 0);

  // JPEG round-trip: encode the post-pass canvas to JPEG (lossy DCT,
  // 8×8 block artifacts, mild color banding), decode it back, then
  // re-encode as PNG so downstream code (`saveBlob`, EI upload) keeps
  // the same content-type contract. Quality scales with the dedicated
  // `jpeg` knob — 0 → skip the round-trip entirely (no artifacts),
  // 1 → quality 0.55 (obvious WhatsApp-screenshot artifacts).
  // 0.95 → 0.55 maps the slider range onto "fine phone-camera JPEG"
  // → "aggressive compression". This is the only step that injects
  // real camera-pipeline compression noise, which models trained on
  // web photos learn to be invariant to.
  if (intensities.jpeg <= 0) {
    return (await canvasToPng(canvas)) ?? blob;
  }
  const jpegQuality = 0.95 - intensities.jpeg * 0.4;
  const jpegBlob = await canvasToBlob(canvas, 'image/jpeg', jpegQuality);
  if (!jpegBlob) return canvasToPng(canvas).then((b) => b ?? blob);
  const jpegBitmap = await createImageBitmap(jpegBlob);
  const finalCanvas = makeCanvas(w, h);
  const finalCtx = finalCanvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!finalCtx) return jpegBlob;
  finalCtx.drawImage(jpegBitmap as unknown as CanvasImageSource, 0, 0);
  jpegBitmap.close();
  const pngBlob = await canvasToPng(finalCanvas);
  return pngBlob ?? blob;
}

/** Build an OffscreenCanvas where available, fall back to an in-DOM
 * canvas for jsdom / older paths. Internal helper for `applyRandomToBlob`. */
function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return Object.assign(document.createElement('canvas'), { width: w, height: h });
}

/** Encode any canvas (Offscreen or HTML) to a blob with the given MIME
 * type + quality. Returns null on failure so the caller can fall back. */
function canvasToBlob(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob | null> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type, quality }).catch(() => null);
  }
  return new Promise((resolve) => {
    (canvas as HTMLCanvasElement).toBlob((b) => resolve(b), type, quality);
  });
}

function canvasToPng(
  canvas: OffscreenCanvas | HTMLCanvasElement,
): Promise<Blob | null> {
  return canvasToBlob(canvas, 'image/png');
}
