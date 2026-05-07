import type {
  AccelSample,
  BoundingBox,
  Capture,
  EdgeImpulseConfig,
} from '../store/useStore';

const INGESTION_BASE = 'https://ingestion.edgeimpulse.com/api';
const STUDIO_BASE = 'https://studio.edgeimpulse.com/v1/api';

// Build the unsigned (alg: "none") Edge Impulse data acquisition format.
// HMAC signing is supported if hmacKey is provided.
// Format reference: https://docs.edgeimpulse.com/reference/data-acquisition-format
async function hmacSha256Hex(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(msg));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export type UploadResult = { ok: boolean; status: number; body: string };

export async function uploadSample(
  cfg: EdgeImpulseConfig,
  samples: AccelSample[],
  sampleRateHz: number,
  fileName: string,
): Promise<UploadResult> {
  if (samples.length === 0) {
    return { ok: false, status: 0, body: 'No samples to upload' };
  }
  if (!cfg.apiKey) {
    return { ok: false, status: 0, body: 'Missing API key' };
  }

  const intervalMs = 1000 / sampleRateHz;
  const useHmac = !!cfg.hmacKey;

  const payload = {
    device_name: cfg.device || 'synthetic-hand-3d',
    device_type: 'WEB_SIMULATOR',
    interval_ms: intervalMs,
    // 6-channel IMU: accelerometer (m/s²) + gyroscope (rad/s), both in the
    // object's local body frame. Channel naming matches what Edge Impulse
    // expects for fused IMU streams.
    sensors: [
      { name: 'accX', units: 'm/s2' },
      { name: 'accY', units: 'm/s2' },
      { name: 'accZ', units: 'm/s2' },
      { name: 'gyrX', units: 'rad/s' },
      { name: 'gyrY', units: 'rad/s' },
      { name: 'gyrZ', units: 'rad/s' },
    ],
    values: samples.map((s) => [s.ax, s.ay, s.az, s.gx, s.gy, s.gz]),
  };

  const protectedHeader = {
    ver: 'v1',
    alg: useHmac ? 'HS256' : 'none',
    iat: Math.floor(Date.now() / 1000),
  };

  const emptySig = '0'.repeat(64);
  const body: {
    protected: typeof protectedHeader;
    signature: string;
    payload: typeof payload;
  } = {
    protected: protectedHeader,
    signature: emptySig,
    payload,
  };

  if (useHmac) {
    const serialized = JSON.stringify(body);
    body.signature = await hmacSha256Hex(cfg.hmacKey, serialized);
  }

  const url = `${INGESTION_BASE}/${cfg.category === 'testing' ? 'testing' : 'training'}/data`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'x-file-name': fileName,
      'x-label': cfg.label || 'unlabeled',
      'x-disallow-duplicates': '0',
      'x-add-date-id': '1',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

export function buildFileName(label: string): string {
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', '');
  const safe = (label || 'sample').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safe}.${ts}.json`;
}

// ---------- Image + bounding box uploads ----------

/**
 * Upload an image (anomaly or detection mode). For detection, pass `boxes`
 * — they're sent in the `x-bounding-boxes` header per the Edge Impulse
 * Ingestion API.
 */
export async function uploadImage(
  cfg: EdgeImpulseConfig,
  blob: Blob,
  filename: string,
  label: string,
  boxes: BoundingBox[] | null,
): Promise<UploadResult> {
  if (!cfg.apiKey) return { ok: false, status: 0, body: 'Missing API key' };

  const url = `${INGESTION_BASE}/${cfg.category === 'testing' ? 'testing' : 'training'}/files`;
  const form = new FormData();
  // The Edge Impulse uploader expects field name `data`.
  form.append('data', blob, filename);

  const headers: Record<string, string> = {
    'x-api-key': cfg.apiKey,
    'x-label': label || 'unlabeled',
    'x-add-date-id': '1',
    'x-disallow-duplicates': '0',
  };
  if (boxes && boxes.length > 0) {
    headers['x-bounding-boxes'] = JSON.stringify(boxes);
  }

  const res = await fetch(url, { method: 'POST', headers, body: form });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

export type BatchUploadProgress = {
  total: number;
  done: number;
  failed: number;
  current?: string;
};

// ---------- Studio API: list projects, fetch deployment ----------

export type EiProject = { id: number; name: string; owner?: string };

async function studioGet<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(`${STUDIO_BASE}${path}`, {
    headers: { 'x-api-key': apiKey, accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Bad JSON from Studio: ${text.slice(0, 200)}`);
  }
}

/** List all projects accessible to the supplied API key. */
export async function listEiProjects(apiKey: string): Promise<EiProject[]> {
  const r = await studioGet<{
    success: boolean;
    error?: string;
    projects: Array<{ id: number; name: string; owner?: { username?: string } }>;
  }>('/projects', apiKey);
  if (!r.success) throw new Error(r.error || 'Studio rejected the API key');
  return (r.projects ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    owner: p.owner?.username,
  }));
}

/**
 * Check whether a project has a built WebAssembly deployment ready for
 * download. EI returns `hasDeployment: false` when the user hasn't built one
 * yet — we surface that as a clear actionable error.
 */
export async function getEiDeployment(
  apiKey: string,
  projectId: number,
  type = 'wasm',
): Promise<{ hasDeployment: boolean; version?: number }> {
  const r = await studioGet<{
    success: boolean;
    error?: string;
    hasDeployment?: boolean;
    version?: number;
  }>(`/${projectId}/deployment?type=${encodeURIComponent(type)}`, apiKey);
  if (!r.success) throw new Error(r.error || 'Failed to query deployment');
  return { hasDeployment: !!r.hasDeployment, version: r.version };
}

/**
 * Trigger a new build of the WebAssembly (browser) deployment for the
 * project. Returns the job id; poll `getEiJobStatus` until it completes.
 *
 * `engine` defaults to 'tflite' (most universal). `modelType` is the
 * quantization mode — 'int8' for the smallest/fastest, 'float32' for
 * highest accuracy.
 */
export async function buildEiDeployment(
  apiKey: string,
  projectId: number,
  opts: { engine?: string; modelType?: string } = {},
): Promise<{ jobId: number }> {
  const engine = opts.engine ?? 'tflite';
  const modelType = opts.modelType ?? 'int8';
  const url = `${STUDIO_BASE}/${projectId}/jobs/build-ondevice-model?type=wasm`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ engine, modelType }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Build trigger failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
    );
  }
  const r = JSON.parse(text) as { success: boolean; id?: number; error?: string };
  if (!r.success || typeof r.id !== 'number') {
    throw new Error(r.error || 'Build trigger returned no job id');
  }
  return { jobId: r.id };
}

export type EiJobStatus = {
  finished: boolean;
  finishedSuccessful: boolean;
  jobNotificationUids?: string[];
};

/** Poll a single build job for its current status. */
export async function getEiJobStatus(
  apiKey: string,
  projectId: number,
  jobId: number,
): Promise<EiJobStatus> {
  const r = await studioGet<{
    success: boolean;
    error?: string;
    job?: { finished?: string | null; finishedSuccessful?: boolean };
  }>(`/${projectId}/jobs/${jobId}/status`, apiKey);
  if (!r.success) throw new Error(r.error || 'Failed to query job status');
  return {
    finished: !!r.job?.finished,
    finishedSuccessful: !!r.job?.finishedSuccessful,
  };
}

/**
 * Block until an EI build job finishes (or hits the timeout). Calls
 * `onProgress` once per poll so the UI can update.
 */
export async function waitForEiJob(
  apiKey: string,
  projectId: number,
  jobId: number,
  opts: {
    onProgress?: (elapsedMs: number) => void;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<void> {
  const timeout = opts.timeoutMs ?? 10 * 60 * 1000; // 10 minutes
  const poll = opts.pollMs ?? 3000;
  const start = Date.now();
  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed > timeout) throw new Error(`Build timed out after ${timeout}ms`);
    opts.onProgress?.(elapsed);
    const s = await getEiJobStatus(apiKey, projectId, jobId);
    if (s.finished) {
      if (!s.finishedSuccessful) {
        throw new Error('Build job finished with failure status');
      }
      return;
    }
    await new Promise((r) => setTimeout(r, poll));
  }
}

/** Download the deployment zip from the Studio. */
export async function downloadEiDeployment(
  apiKey: string,
  projectId: number,
  type = 'wasm',
): Promise<Blob> {
  const url = `${STUDIO_BASE}/${projectId}/deployment/download?type=${encodeURIComponent(
    type,
  )}`;
  const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Download failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
    );
  }
  return await res.blob();
}

export async function uploadCaptures(
  cfg: EdgeImpulseConfig,
  captures: Capture[],
  defaultLabel: string,
  includeBoxes: boolean,
  onProgress?: (p: BatchUploadProgress) => void,
): Promise<{ done: number; failed: number; lastError?: string }> {
  let done = 0;
  let failed = 0;
  let lastError: string | undefined;
  const total = captures.length;
  for (const c of captures) {
    onProgress?.({ total, done, failed, current: c.filename });
    const lbl = c.label || defaultLabel;
    try {
      const res = await uploadImage(
        cfg,
        c.blob,
        c.filename,
        lbl,
        includeBoxes ? c.boxes : null,
      );
      if (res.ok) done += 1;
      else {
        failed += 1;
        lastError = `${res.status}: ${res.body.slice(0, 200)}`;
      }
    } catch (e) {
      failed += 1;
      lastError = (e as Error).message;
    }
  }
  onProgress?.({ total, done, failed });
  return { done, failed, lastError };
}
