import type { AccelSample, EdgeImpulseConfig } from '../store/useStore';

const INGESTION_BASE = 'https://ingestion.edgeimpulse.com/api';

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
    sensors: [
      { name: 'accX', units: 'm/s2' },
      { name: 'accY', units: 'm/s2' },
      { name: 'accZ', units: 'm/s2' },
    ],
    values: samples.map((s) => [s.ax, s.ay, s.az]),
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
