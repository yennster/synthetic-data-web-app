/**
 * Vercel Function — proxies a single img2img call to the Hugging Face
 * Inference API so the optional HF token stays server-side and the
 * browser doesn't have to deal with CORS or rate-limit responses
 * straight from huggingface.co.
 *
 * The client only invokes this for the first N images of a batch (see
 * `consumeDiffusionBudget` in `src/lib/realism.ts`) and falls back to
 * the local Random pass on any error, so it's safe to fail fast — the
 * worst case is "this image is grain instead of img2img" which the
 * batch metadata records as `realism_mode = 'random'`.
 *
 * Request: `POST /api/realism-diffusion`
 *   - Header: `x-realism-intensity` (0..1, optional, defaults to 0.5)
 *   - Body: image bytes (image/png), no multipart wrapping
 *
 * Response on success: image bytes (image/png) with the same dimensions
 * Response on error: 4xx/5xx with a one-line JSON `{ error: string }`.
 *
 * Env:
 *   - HF_TOKEN — optional Hugging Face access token. Without it the
 *     call still goes through but the shared free quota is extremely
 *     low (often a single-digit RPM across all unauth callers).
 *   - HF_REALISM_MODEL — optional override of the model id. Default
 *     `timbrooks/instruct-pix2pix` because it's instruction-driven,
 *     small, and supports the serverless image-to-image task. Swap to
 *     a stronger refiner (e.g. `stabilityai/stable-diffusion-xl-refiner-1.0`)
 *     once a paid HF plan is wired up.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

const DEFAULT_MODEL = 'timbrooks/instruct-pix2pix';
// SDXL refiner / FLUX img2img would land here once we're on a paid
// tier. The instruction prompt is tuned for the default pix2pix model.
const INSTRUCTION =
  'make this look like a real photograph: natural lighting, accurate ' +
  'materials, subtle film grain, soft shadows; keep every object in ' +
  'exactly the same position and shape.';

export const config = { runtime: 'nodejs' };

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'POST only' });
  }
  const intensityHeader = headerOf(req, 'x-realism-intensity');
  const intensity = clamp(Number(intensityHeader ?? '0.5'), 0.05, 1);
  // pix2pix's `image_guidance_scale` controls how closely the output
  // sticks to the input image — high means "almost no change", low
  // means "free to repaint". We map our 0..1 intensity to a 2.0..1.2
  // range so a higher slider means MORE realism drift (less guidance).
  const imageGuidance = 2.0 - intensity * 0.8;

  let imageBytes: Buffer;
  try {
    imageBytes = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: `bad image body: ${(e as Error).message}` });
  }
  if (imageBytes.length === 0) {
    return json(res, 400, { error: 'empty image body' });
  }

  const model = process.env.HF_REALISM_MODEL ?? DEFAULT_MODEL;
  const token = process.env.HF_TOKEN;
  const upstreamUrl = `https://api-inference.huggingface.co/models/${model}`;
  // HF accepts a multipart-style payload via JSON: `inputs` is a base64
  // string of the source image, `parameters` carries the prompt and
  // pipeline-specific controls.
  const body = JSON.stringify({
    inputs: imageBytes.toString('base64'),
    parameters: {
      prompt: INSTRUCTION,
      image_guidance_scale: imageGuidance,
      num_inference_steps: 20,
    },
    options: {
      // Block waiting for cold-start so we don't bounce back with a
      // 503 the first call after a quiet period. The client has its
      // own timeout and falls back to Random on any error.
      wait_for_model: true,
      use_cache: false,
    },
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'image/png',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { method: 'POST', headers, body });
  } catch (e) {
    return json(res, 502, { error: `hf network: ${(e as Error).message}` });
  }
  if (!upstream.ok) {
    // Pass the upstream message back so the browser console shows the
    // actual reason (rate limit, model not found, auth required).
    const text = await upstream.text().catch(() => '');
    return json(res, upstream.status === 503 ? 503 : 502, {
      error: `hf ${upstream.status}: ${text.slice(0, 200)}`,
    });
  }
  const contentType = upstream.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/')) {
    // HF sometimes returns JSON for queued / cold-starting models even
    // when wait_for_model: true. Treat as a failure so the client
    // falls back instead of trying to render JSON as a PNG.
    const text = await upstream.text().catch(() => '');
    return json(res, 502, {
      error: `hf non-image response: ${text.slice(0, 200)}`,
    });
  }
  const out = Buffer.from(await upstream.arrayBuffer());
  res.statusCode = 200;
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store');
  res.end(out);
}

/** Read the whole body into a Buffer. Vercel's Node runtime gives us
 * a regular IncomingMessage stream — collect chunks the standard way. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Pull a header value as a string. Node's IncomingMessage headers
 * are normalized to lowercase keys; values can be string or string[]. */
function headerOf(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
