import type {
  AccelSample,
  BoundingBox,
  Capture,
  EdgeImpulseConfig,
  LidarSample,
} from '../store/useStore';

const INGESTION_BASE = 'https://ingestion.edgeimpulse.com/api';
const STUDIO_BASE = 'https://studio.edgeimpulse.com/v1/api';

const METADATA_SOURCE = 'Synthetic Data Studio';

/** Probability of routing to the training bucket when category === 'split'. */
const SPLIT_TRAINING_RATIO = 0.8;

/**
 * Resolve the upload bucket from the user-selected category. `split` rolls
 * an 80/20 dice per call and tags the metadata so the user can audit
 * which samples landed where.
 */
export function resolveBucket(
  category: EdgeImpulseConfig['category'],
): 'training' | 'testing' {
  if (category === 'split') {
    return Math.random() < SPLIT_TRAINING_RATIO ? 'training' : 'testing';
  }
  return category;
}

export type IngestionMetadataExtras = Record<
  string,
  string | number | boolean | undefined | null
>;

export type EdgeImpulseInfoLabelsEntry = {
  path: string;
  category: EdgeImpulseConfig['category'];
  label: { type: 'label'; label: string } | { type: 'unlabeled' };
  metadata?: Record<string, string>;
};

/**
 * Build the JSON string for Edge Impulse's `x-metadata` ingestion header.
 * Always tags samples with the studio's name + the page URL they were
 * generated from; callers add per-sample context (mode, shape, etc.).
 */
export function buildIngestionMetadata(extras?: IngestionMetadataExtras): string {
  const meta: Record<string, string> = { source: METADATA_SOURCE };
  if (typeof window !== 'undefined' && window.location?.href) {
    const { origin, pathname } = window.location;
    meta.source_url = `${origin}${pathname}`;
  }
  if (extras) {
    for (const [k, v] of Object.entries(extras)) {
      if (v === undefined || v === null || v === '') continue;
      meta[k] = String(v);
    }
  }
  return JSON.stringify(meta);
}

export function buildInfoLabelsEntry(opts: {
  path: string;
  category: EdgeImpulseConfig['category'];
  label?: string;
  metadataExtras?: IngestionMetadataExtras;
}): EdgeImpulseInfoLabelsEntry {
  const metadata = JSON.parse(
    buildIngestionMetadata(opts.metadataExtras),
  ) as Record<string, string>;
  return {
    path: opts.path,
    category: opts.category,
    label: opts.label
      ? { type: 'label', label: opts.label }
      : { type: 'unlabeled' },
    metadata,
  };
}

export function buildInfoLabelsFile(
  entries: EdgeImpulseInfoLabelsEntry[],
): string {
  return JSON.stringify({ version: 1, files: entries }, null, 2);
}

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

/**
 * Pick the `interval_ms` to declare in the EI payload. The sampler tags
 * each sample with `t = performance.now()`, so the average span between
 * the first and last samples is a much better estimate of the actual
 * emit rate than the user's requested sample rate (which is an upper
 * bound, capped by the render frame rate). Falls back to the requested
 * rate when there's only one sample, or when the timestamps are
 * monotonically broken / coincident.
 */
export function inferIntervalMs(
  samples: AccelSample[],
  sampleRateHz: number,
): number {
  const fallback = 1000 / sampleRateHz;
  if (samples.length < 2) return fallback;
  const span = samples[samples.length - 1].t - samples[0].t;
  if (!Number.isFinite(span) || span <= 0) return fallback;
  return span / (samples.length - 1);
}

export async function buildDataAcquisitionPayload(
  cfg: Pick<EdgeImpulseConfig, 'device' | 'hmacKey'>,
  samples: AccelSample[],
  sampleRateHz: number,
): Promise<{
  protected: { ver: 'v1'; alg: 'HS256' | 'none'; iat: number };
  signature: string;
  payload: {
    device_name: string;
    device_type: string;
    interval_ms: number;
    sensors: { name: string; units: string }[];
    values: number[][];
  };
}> {
  // EI plots a trace's duration as `samples.length * interval_ms`, so a
  // mismatch between the requested sample rate and the rate we actually
  // emit at shows up as a wrong-length recording in the Studio. The
  // sampler caps emission at the render frame rate (one sample per
  // useFrame call), so 100 Hz requested + 60 fps render = ~60 Hz actual,
  // and a 2 s recording would render as 1.2 s if we naively reported
  // 1000/100 = 10 ms here. Prefer the actual per-sample spacing measured
  // from the recorded timestamps; fall back to the requested rate only
  // when there aren't enough samples to derive it.
  const intervalMs = inferIntervalMs(samples, sampleRateHz);
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

  const protectedHeader: {
    ver: 'v1';
    alg: 'HS256' | 'none';
    iat: number;
  } = {
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

  return body;
}

export async function uploadSample(
  cfg: EdgeImpulseConfig,
  samples: AccelSample[],
  sampleRateHz: number,
  fileName: string,
  metadataExtras?: IngestionMetadataExtras,
): Promise<UploadResult> {
  if (samples.length === 0) {
    return { ok: false, status: 0, body: 'No samples to upload' };
  }
  if (!cfg.apiKey) {
    return { ok: false, status: 0, body: 'Missing API key' };
  }

  const body = await buildDataAcquisitionPayload(cfg, samples, sampleRateHz);
  return uploadDataAcquisitionJson(cfg, body, fileName, metadataExtras);
}

async function uploadDataAcquisitionJson(
  cfg: EdgeImpulseConfig,
  body: unknown,
  fileName: string,
  metadataExtras?: IngestionMetadataExtras,
): Promise<UploadResult> {
  const bucket = resolveBucket(cfg.category);
  const meta: IngestionMetadataExtras = { ...metadataExtras };
  if (cfg.category === 'split') meta.split_bucket = bucket;
  const form = new FormData();
  form.append(
    'data',
    new Blob([JSON.stringify(body)], { type: 'application/json' }),
    fileName,
  );
  const url = `${INGESTION_BASE}/${bucket}/files`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': cfg.apiKey,
      'x-label': cfg.label || 'unlabeled',
      'x-disallow-duplicates': '0',
      'x-add-date-id': '1',
      'x-metadata': buildIngestionMetadata(meta),
    },
    body: form,
  });

  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

/**
 * Like `inferIntervalMs` but for lidar samples (which carry N-channel
 * range arrays per timestep instead of fixed 6-channel IMU readings).
 */
function inferLidarIntervalMs(
  samples: LidarSample[],
  sampleRateHz: number,
): number {
  const fallback = 1000 / sampleRateHz;
  if (samples.length < 2) return fallback;
  const span = samples[samples.length - 1].t - samples[0].t;
  if (!Number.isFinite(span) || span <= 0) return fallback;
  return span / (samples.length - 1);
}

/**
 * Build the EI data-acquisition payload for a lidar/ToF ring recording.
 * Same shape as the IMU payload but with N range channels (`r0`..`rN-1`)
 * in meters. The number of channels is fixed per sample (every reading
 * has the same `bins` count); we read `samples[0].ranges.length` and
 * trust the sampler to keep it stable.
 *
 * EI's classifier expects a rectangular time-series. If `samples`
 * contains rows with mismatched bin counts (shouldn't happen — the
 * store's `pushLidarSample` doesn't validate, but the sampler always
 * emits `bins`-length arrays) we right-pad short rows with `maxRange`
 * so the upload doesn't error out partway through a batch.
 */
export async function buildLidarDataAcquisitionPayload(
  cfg: Pick<EdgeImpulseConfig, 'device' | 'hmacKey'>,
  samples: LidarSample[],
  sampleRateHz: number,
  maxRange: number,
): Promise<{
  protected: { ver: 'v1'; alg: 'HS256' | 'none'; iat: number };
  signature: string;
  payload: {
    device_name: string;
    device_type: string;
    interval_ms: number;
    sensors: { name: string; units: string }[];
    values: number[][];
  };
}> {
  const bins = samples[0]?.ranges.length ?? 0;
  const intervalMs = inferLidarIntervalMs(samples, sampleRateHz);
  const useHmac = !!cfg.hmacKey;

  const sensors: { name: string; units: string }[] = [];
  for (let i = 0; i < bins; i++) {
    sensors.push({ name: `r${i}`, units: 'm' });
  }
  const values = samples.map((s) => {
    if (s.ranges.length === bins) return s.ranges;
    const row = s.ranges.slice(0, bins);
    while (row.length < bins) row.push(maxRange);
    return row;
  });

  const payload = {
    device_name: cfg.device || 'synthetic-rover',
    device_type: 'WEB_SIMULATOR',
    interval_ms: intervalMs,
    sensors,
    values,
  };

  const protectedHeader: {
    ver: 'v1';
    alg: 'HS256' | 'none';
    iat: number;
  } = {
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
  return body;
}

/**
 * Build a combined IMU + lidar payload for the rover. The chassis
 * carries both sensors at the same nominal rate, so the runner emits
 * one sample per ~50 ms with both modalities. Edge Impulse handles
 * arbitrary multi-channel time-series, so we just declare 6 IMU + N
 * lidar channels in the payload's `sensors` array and pack them per
 * row.
 *
 * Sample arrays must be the same length (the rover's dual sampler
 * pushes both per tick, so this holds in practice). When they differ,
 * we trim to the shorter length so the upload is rectangular.
 */
export async function buildRoverDataAcquisitionPayload(
  cfg: Pick<EdgeImpulseConfig, 'device' | 'hmacKey'>,
  imu: AccelSample[],
  lidar: LidarSample[],
  sampleRateHz: number,
  maxRange: number,
): Promise<{
  protected: { ver: 'v1'; alg: 'HS256' | 'none'; iat: number };
  signature: string;
  payload: {
    device_name: string;
    device_type: string;
    interval_ms: number;
    sensors: { name: string; units: string }[];
    values: number[][];
  };
}> {
  if (imu.length === 0 || lidar.length === 0) {
    throw new Error('Rover fused payload requires both IMU and lidar samples');
  }
  const n = Math.min(imu.length, lidar.length);
  const trimmed = {
    imu: imu.slice(0, n),
    lidar: lidar.slice(0, n),
  };
  const bins = trimmed.lidar[0]?.ranges.length ?? 0;
  const intervalMs = inferIntervalMs(trimmed.imu, sampleRateHz);
  const useHmac = !!cfg.hmacKey;

  const sensors: { name: string; units: string }[] = [
    { name: 'accX', units: 'm/s2' },
    { name: 'accY', units: 'm/s2' },
    { name: 'accZ', units: 'm/s2' },
    { name: 'gyrX', units: 'rad/s' },
    { name: 'gyrY', units: 'rad/s' },
    { name: 'gyrZ', units: 'rad/s' },
  ];
  for (let i = 0; i < bins; i++) sensors.push({ name: `r${i}`, units: 'm' });

  const values = trimmed.imu.map((a, i) => {
    const ranges =
      trimmed.lidar[i].ranges.length === bins
        ? trimmed.lidar[i].ranges
        : (() => {
            const r = trimmed.lidar[i].ranges.slice(0, bins);
            while (r.length < bins) r.push(maxRange);
            return r;
          })();
    return [a.ax, a.ay, a.az, a.gx, a.gy, a.gz, ...ranges];
  });

  const payload = {
    device_name: cfg.device || 'synthetic-rover',
    device_type: 'WEB_SIMULATOR',
    interval_ms: intervalMs,
    sensors,
    values,
  };
  const protectedHeader: { ver: 'v1'; alg: 'HS256' | 'none'; iat: number } = {
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
  return body;
}

/**
 * Upload a combined IMU + lidar rover sample to EI. Same ingestion URL
 * as `uploadSample`; payload built by `buildRoverDataAcquisitionPayload`.
 */
export async function uploadRoverSample(
  cfg: EdgeImpulseConfig,
  imu: AccelSample[],
  lidar: LidarSample[],
  sampleRateHz: number,
  maxRange: number,
  fileName: string,
  metadataExtras?: IngestionMetadataExtras,
): Promise<UploadResult> {
  if (imu.length === 0 || lidar.length === 0) {
    return {
      ok: false,
      status: 0,
      body: 'Fused rover upload requires both IMU and lidar samples',
    };
  }
  if (!cfg.apiKey) return { ok: false, status: 0, body: 'Missing API key' };
  const body = await buildRoverDataAcquisitionPayload(
    cfg,
    imu,
    lidar,
    sampleRateHz,
    maxRange,
  );
  return uploadDataAcquisitionJson(cfg, body, fileName, metadataExtras);
}

/**
 * Sibling to `uploadSample` for lidar/ToF time series. Same ingestion
 * URL shape; the only difference is the payload builder.
 */
export async function uploadLidarSample(
  cfg: EdgeImpulseConfig,
  samples: LidarSample[],
  sampleRateHz: number,
  maxRange: number,
  fileName: string,
  metadataExtras?: IngestionMetadataExtras,
): Promise<UploadResult> {
  if (samples.length === 0) {
    return { ok: false, status: 0, body: 'No samples to upload' };
  }
  if (!cfg.apiKey) {
    return { ok: false, status: 0, body: 'Missing API key' };
  }

  const body = await buildLidarDataAcquisitionPayload(
    cfg,
    samples,
    sampleRateHz,
    maxRange,
  );
  return uploadDataAcquisitionJson(cfg, body, fileName, metadataExtras);
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
  metadataExtras?: IngestionMetadataExtras,
): Promise<UploadResult> {
  if (!cfg.apiKey) return { ok: false, status: 0, body: 'Missing API key' };

  const bucket = resolveBucket(cfg.category);
  const meta: IngestionMetadataExtras = { ...metadataExtras };
  if (cfg.category === 'split') meta.split_bucket = bucket;
  const url = `${INGESTION_BASE}/${bucket}/files`;
  const form = new FormData();
  // The Edge Impulse uploader expects field name `data`.
  form.append('data', blob, filename);

  const headers: Record<string, string> = {
    'x-api-key': cfg.apiKey,
    'x-label': label || 'unlabeled',
    'x-add-date-id': '1',
    'x-disallow-duplicates': '0',
    'x-metadata': buildIngestionMetadata(meta),
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

/**
 * Snapshot of what kind of data a project currently contains. Edge
 * Impulse projects don't mix freely — an "object detection" impulse and
 * a "time-series classifier" impulse can both exist on the same
 * project, but the Studio data tab is dominated by whichever sample
 * type was ingested first, and uploading the wrong kind tends to either
 * be rejected or produce a project that won't train. The robot panel
 * uses this probe to decide whether to upload the sensor stream, the
 * image stream, or both — anything that wouldn't survive ingestion is
 * downloaded locally instead.
 *
 * Probe strategy (most authoritative → least):
 *
 *   1. **Project info**: `GET /v1/api/{projectId}` — EI's project
 *      record has `dataAcquisitionType` / `labelingMethod` /
 *      `type` flags that directly identify image / object-detection
 *      projects. When any of those say "image", we're done.
 *   2. **Raw-data samples**: fall back to listing samples and
 *      classifying each by structural signals (intervalMs / frequency /
 *      thumbnailUrl) rather than relying on filename extensions, since
 *      EI's image samples sometimes carry `.cbor` filenames internally.
 *   3. **Filename extension**: final fallback only.
 */
export type EiProjectDataKinds = {
  hasImages: boolean;
  hasTimeSeries: boolean;
  /** Total samples actually examined (≤ probe page size). 0 means the
   * project is empty — caller should treat that as "accepts either". */
  totalChecked: number;
};

const IMAGE_FILENAME_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;

/** One raw-data sample as returned by EI's `getProjectRawData`. We only
 *  type the fields the classifier looks at — everything else is
 *  ignored. All fields are optional because the EI API shape varies
 *  slightly across project types. */
type EiRawDataSample = {
  filename?: string;
  intervalMs?: number;
  frequency?: number;
  length?: number;
  valuesCount?: number;
  thumbnailUrl?: string | null;
  /** Some EI deployments surface a `chartType` field on the data
   * inspector. `image` is the most direct signal we get. */
  chartType?: string;
};

/**
 * Classify one raw-data sample as `image` or `time-series` using
 * multiple signals, in priority order. Returns `null` when no signal
 * fires (e.g. a sample stub with only an `id`).
 */
function classifyEiSample(
  s: EiRawDataSample,
): 'image' | 'time-series' | null {
  // 1. Most authoritative: an explicit chartType.
  if (s.chartType === 'image') return 'image';
  if (s.chartType === 'time-series') return 'time-series';
  // 2. Time-series structural signals — non-zero sampling rate or
  //    multi-step value count. Images report 0 / null for these.
  if ((s.intervalMs ?? 0) > 0) return 'time-series';
  if ((s.frequency ?? 0) > 0) return 'time-series';
  if ((s.length ?? 0) > 0) return 'time-series';
  if ((s.valuesCount ?? 0) > 1) return 'time-series';
  // 3. Image structural signal — EI generates thumbnails for image
  //    samples and leaves it null for time-series.
  if (s.thumbnailUrl) return 'image';
  // 4. Filename extension as a last resort.
  const fn = (s.filename ?? '').toLowerCase();
  if (IMAGE_FILENAME_RE.test(fn)) return 'image';
  // No strong signal — skip.
  return null;
}

/**
 * Read `GET /v1/api/{projectId}` and infer whether the project is
 * obviously image-typed. EI exposes one of several flags depending on
 * project age — we check the union. Returns `null` when no flag
 * resolves, so the caller can fall back to the sample probe.
 */
async function getEiProjectKindFromInfo(
  apiKey: string,
  projectId: number,
): Promise<'image' | 'time-series' | null> {
  try {
    const r = await studioGet<{
      success: boolean;
      project?: {
        dataAcquisitionType?: string;
        labelingMethod?: string;
        type?: string;
        isComputerVisionProject?: boolean;
      };
    }>(`/${projectId}`, apiKey);
    if (!r.success || !r.project) return null;
    const p = r.project;
    if (p.isComputerVisionProject === true) return 'image';
    const blob = `${p.dataAcquisitionType ?? ''} ${p.labelingMethod ?? ''} ${
      p.type ?? ''
    }`.toLowerCase();
    if (/image|vision|bounding|object-detection/.test(blob)) return 'image';
    if (/time.?series|audio|accelerometer|imu/.test(blob)) return 'time-series';
    return null;
  } catch {
    return null;
  }
}

export async function getEiProjectDataKinds(
  apiKey: string,
  projectId: number,
): Promise<EiProjectDataKinds> {
  const seen = { hasImages: false, hasTimeSeries: false, totalChecked: 0 };

  // Authoritative path: project info. Object-detection / image projects
  // surface a flag here that the raw-data filename heuristic miss when
  // EI stores ingested images under `.cbor` wrappers.
  const fromInfo = await getEiProjectKindFromInfo(apiKey, projectId);
  if (fromInfo) {
    if (fromInfo === 'image') seen.hasImages = true;
    else seen.hasTimeSeries = true;
    seen.totalChecked = 1;
    return seen;
  }

  // Sample across categories so a project that only has data in the
  // testing bucket still classifies correctly.
  for (const category of ['training', 'testing'] as const) {
    if (seen.hasImages && seen.hasTimeSeries) break;
    let r: {
      success: boolean;
      error?: string;
      samples?: EiRawDataSample[];
    };
    try {
      r = await studioGet<typeof r>(
        `/${projectId}/raw-data?category=${category}&limit=30&offset=0`,
        apiKey,
      );
    } catch {
      continue;
    }
    if (!r.success) continue;
    const samples = r.samples ?? [];
    for (const s of samples) {
      const kind = classifyEiSample(s);
      if (!kind) continue;
      seen.totalChecked += 1;
      if (kind === 'image') seen.hasImages = true;
      else seen.hasTimeSeries = true;
      if (seen.hasImages && seen.hasTimeSeries) break;
    }
  }
  return seen;
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
 * One entry in the project's deployment history (= every successfully built
 * artefact ever produced for this project). Surfaced via the `/deployment/
 * history` endpoint, which is the only reliable way to enumerate what's
 * actually been built — the singular `/deployment` endpoint requires the
 * caller to already know `engine` + `modelType` + `impulseId` and silently
 * returns `hasDeployment: false` when any of those don't match.
 */
export type EiDeploymentHistoryEntry = {
  created: string;
  deploymentVersion: number;
  deploymentFormat: string;
  engine: string;
  modelType?: string;
  impulseId: number;
  impulseName?: string;
  impulseIsDeleted?: boolean;
  deploymentTarget?: { format?: string; name?: string };
};

/**
 * List every successfully built deployment for a project (across impulses,
 * engines, model types, and historical versions). Returns the newest first.
 */
export async function listEiDeploymentHistory(
  apiKey: string,
  projectId: number,
  opts: { impulseId?: number; limit?: number } = {},
): Promise<EiDeploymentHistoryEntry[]> {
  const params = new URLSearchParams();
  if (opts.impulseId != null) params.set('impulseId', String(opts.impulseId));
  if (opts.limit != null) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const path = `/${projectId}/deployment/history${qs ? `?${qs}` : ''}`;
  const r = await studioGet<{
    success: boolean;
    error?: string;
    deployments?: EiDeploymentHistoryEntry[];
    totalDeploymentCount?: number;
  }>(path, apiKey);
  if (!r.success) throw new Error(r.error || 'Failed to list deployment history');
  const list = r.deployments ?? [];
  // Studio doesn't guarantee an order; sort newest-first by created date so
  // callers can pick `[0]` to get the latest matching artefact.
  return list.slice().sort((a, b) => (a.created < b.created ? 1 : -1));
}

/**
 * Download a specific historic deployment by its `deploymentVersion`. This
 * is the supported replacement for the deprecated singular
 * `/deployment/download` endpoint and works regardless of which engine /
 * modelType / impulse the build targeted.
 */
export async function downloadEiHistoricDeployment(
  apiKey: string,
  projectId: number,
  deploymentVersion: number,
): Promise<Blob> {
  const url = `${STUDIO_BASE}/${projectId}/deployment/history/${deploymentVersion}/download`;
  const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Download failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
    );
  }
  return await res.blob();
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
): Promise<{
  hasDeployment: boolean;
  version?: number;
  /** The engine + modelType that actually matched a built artefact. Pass
   * these to `downloadEiDeployment` so the download targets the same
   * deployment that the check found. */
  engine?: string;
  modelType?: string;
}> {
  // Studio's deployment endpoint requires engine + modelType query params to
  // match against a specific built artefact; without them the API returns
  // hasDeployment=false even when a build exists. We probe the common
  // (engine, modelType) combos in priority order and surface the first hit.
  const candidates: { engine: string; modelType: string }[] = [
    { engine: 'tflite', modelType: 'int8' },
    { engine: 'tflite', modelType: 'float32' },
    { engine: 'tflite-eon', modelType: 'int8' },
    { engine: 'tflite-eon', modelType: 'float32' },
  ];
  let lastError: string | undefined;
  for (const c of candidates) {
    const qs = new URLSearchParams({ type, ...c }).toString();
    const r = await studioGet<{
      success: boolean;
      error?: string;
      hasDeployment?: boolean;
      version?: number;
    }>(`/${projectId}/deployment?${qs}`, apiKey);
    if (!r.success) {
      lastError = r.error || 'Failed to query deployment';
      continue;
    }
    if (r.hasDeployment) {
      return {
        hasDeployment: true,
        version: r.version,
        engine: c.engine,
        modelType: c.modelType,
      };
    }
  }
  if (lastError) throw new Error(lastError);
  return { hasDeployment: false };
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

/**
 * Retrain the project's default impulse with the last known DSP / learn block
 * settings. This mirrors Studio's "Retrain model" shortcut after new data has
 * been uploaded.
 */
export async function retrainEiModel(
  apiKey: string,
  projectId: number,
): Promise<{ jobId: number }> {
  const url = `${STUDIO_BASE}/${projectId}/jobs/retrain`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      accept: 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Retrain trigger failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
    );
  }
  const r = JSON.parse(text) as { success: boolean; id?: number; error?: string };
  if (!r.success || typeof r.id !== 'number') {
    throw new Error(r.error || 'Retrain trigger returned no job id');
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
  engine = 'tflite',
  modelType = 'int8',
): Promise<Blob> {
  const qs = new URLSearchParams({ type, engine, modelType }).toString();
  const url = `${STUDIO_BASE}/${projectId}/deployment/download?${qs}`;
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
  metadataExtras?: IngestionMetadataExtras,
): Promise<{ done: number; failed: number; lastError?: string }> {
  let done = 0;
  let failed = 0;
  let lastError: string | undefined;
  const total = captures.length;
  for (const c of captures) {
    onProgress?.({ total, done, failed, current: c.filename });
    const lbl = c.label || defaultLabel;
    // Per-capture metadata: scene shape names + dimensions, on top of the
    // batch-level extras passed in by the caller.
    const perCapture: IngestionMetadataExtras = {
      ...metadataExtras,
      width: c.width,
      height: c.height,
      capture_ts: new Date(c.ts).toISOString(),
    };
    if (c.shapes && c.shapes.length > 0) {
      perCapture.shapes = c.shapes.join(',');
    }
    if (c.assetSnapshot && c.assetSnapshot.length > 0) {
      perCapture.asset_files = c.assetSnapshot.map((a) => a.name).join(',');
      perCapture.asset_labels = c.assetSnapshot.map((a) => a.label).join(',');
      perCapture.asset_count = c.assetSnapshot.length;
    }
    try {
      const res = await uploadImage(
        cfg,
        c.blob,
        c.filename,
        lbl,
        includeBoxes ? c.boxes : null,
        perCapture,
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
