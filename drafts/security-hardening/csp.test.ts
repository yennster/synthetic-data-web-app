import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

// External URLs the running app actually fetches. Adding a new external
// dependency? Add it here AND to the matching CSP directive in
// vercel.json + bin/serve.mjs. This test fails first so you can't ship
// a runtime "Refused to connect" / "Load failed" regression — that's
// the failure mode that prompted this test (the warehouse HDR loaded
// from `raw.githubusercontent.com` was in connect-src but blocked by
// COEP credentialless on Vercel, and we caught it only after deploy).
//
// Each entry asserts the host appears literally in the CSP directive,
// with the matching wildcard form if applicable. Don't list paths here;
// CSP allowlisting is per-host.
const EXTERNAL_FETCHES: Array<{
  feature: string;
  directive: 'connect-src' | 'script-src';
  host: string;
}> = [
  // Drei warehouse HDR (Scene.tsx WAREHOUSE_HDR_URL). MUST be a host
  // that sends `Cross-Origin-Resource-Policy: cross-origin` because
  // we ship `COEP: credentialless` for OpenUSD SharedArrayBuffer.
  // jsdelivr does; raw.githubusercontent.com does not — that's the
  // regression this test was created to prevent.
  {
    feature: 'drei warehouse HDR (jsdelivr GH mirror)',
    directive: 'connect-src',
    host: 'https://cdn.jsdelivr.net',
  },
  // MediaPipe hand-landmarker WASM loader. Hand tracking fails silently
  // without this (FilesetResolver fetches `vision_wasm_internal.{js,wasm}`).
  {
    feature: 'MediaPipe vision WASM loader (script)',
    directive: 'script-src',
    host: 'https://cdn.jsdelivr.net',
  },
  {
    feature: 'MediaPipe vision WASM loader (fetch)',
    directive: 'connect-src',
    host: 'https://cdn.jsdelivr.net',
  },
  // MediaPipe hand-landmarker model file (hosted on GCS, bytes only).
  {
    feature: 'MediaPipe hand-landmarker model',
    directive: 'connect-src',
    host: 'https://storage.googleapis.com',
  },
  // Edge Impulse Studio + Ingestion APIs.
  {
    feature: 'Edge Impulse APIs',
    directive: 'connect-src',
    host: 'https://*.edgeimpulse.com',
  },
  // HuggingFace inference (used by the inference card's HF mode).
  {
    feature: 'HuggingFace inference',
    directive: 'connect-src',
    host: 'https://api-inference.huggingface.co',
  },
  // Vercel Web Analytics: script + beacon.
  {
    feature: 'Vercel Analytics script',
    directive: 'script-src',
    host: 'https://va.vercel-scripts.com',
  },
  {
    feature: 'Vercel Analytics beacon',
    directive: 'connect-src',
    host: 'https://va.vercel-scripts.com',
  },
  {
    feature: 'Vercel Insights beacon',
    directive: 'connect-src',
    host: 'https://*.vercel-insights.com',
  },
];

function readVercelCsp(): string {
  const json = JSON.parse(
    readFileSync(join(repoRoot, 'vercel.json'), 'utf-8'),
  ) as {
    headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };
  for (const block of json.headers) {
    for (const h of block.headers) {
      if (h.key === 'Content-Security-Policy') return h.value;
    }
  }
  throw new Error('Content-Security-Policy not found in vercel.json');
}

function readServeMjsCsp(): string {
  const src = readFileSync(join(repoRoot, 'bin', 'serve.mjs'), 'utf-8');
  // Match the literal `'Content-Security-Policy': [ ... ].join('; ')` block.
  const start = src.indexOf("'Content-Security-Policy'");
  if (start < 0) throw new Error("'Content-Security-Policy' key not found in bin/serve.mjs");
  const arrStart = src.indexOf('[', start);
  const arrEnd = src.indexOf("].join", arrStart);
  if (arrStart < 0 || arrEnd < 0) {
    throw new Error('CSP array literal not found in bin/serve.mjs');
  }
  const arrSrc = src.slice(arrStart, arrEnd + 1);
  // Pull every double-quoted directive string out of the array source.
  // Anchored on `"…"` so single-quoted JS comment text doesn't match.
  const directives = [...arrSrc.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  if (directives.length === 0) {
    throw new Error('No directive strings extracted from bin/serve.mjs CSP');
  }
  return directives.join('; ');
}

function getDirective(csp: string, name: string): string {
  const part = csp
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${name} `) || p === name);
  if (!part) {
    throw new Error(`CSP missing "${name}" directive: ${csp}`);
  }
  return part;
}

describe('CSP allowlist matches the URLs the app actually fetches', () => {
  const vercelCsp = readVercelCsp();
  const serveCsp = readServeMjsCsp();

  it('vercel.json and bin/serve.mjs ship the same CSP (no drift)', () => {
    // The drift that gave us yesterday's regression: vercel.json was
    // updated and bin/serve.mjs wasn't. Normalize whitespace + directive
    // order before comparing so cosmetic diffs don't trip the test.
    const normalize = (csp: string) =>
      csp
        .split(';')
        .map((p) => p.trim())
        .filter(Boolean)
        .sort()
        .join('; ');
    expect(normalize(serveCsp)).toBe(normalize(vercelCsp));
  });

  for (const entry of EXTERNAL_FETCHES) {
    it(`${entry.feature} → ${entry.directive} allows ${entry.host}`, () => {
      const directive = getDirective(vercelCsp, entry.directive);
      expect(
        directive,
        `vercel.json ${entry.directive} is missing ${entry.host} for ${entry.feature}. ` +
          `If you removed this dependency, drop the entry from EXTERNAL_FETCHES in csp.test.ts.`,
      ).toContain(entry.host);
    });
  }
});

describe('Permissions-Policy allows iframe embedders to delegate camera', () => {
  // `camera=(self)` blocks cross-origin iframe embedders from granting
  // camera even with `<iframe allow="camera">`. `camera=*` (or an explicit
  // allowlist) is required for the documented ?embed=1 mode to capture
  // the webcam on the parent site's behalf.
  it('vercel.json Permissions-Policy is not restricted to (self)', () => {
    const json = JSON.parse(
      readFileSync(join(repoRoot, 'vercel.json'), 'utf-8'),
    ) as {
      headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    };
    let pp: string | undefined;
    for (const block of json.headers) {
      for (const h of block.headers) {
        if (h.key === 'Permissions-Policy') pp = h.value;
      }
    }
    expect(pp, 'Permissions-Policy header missing in vercel.json').toBeDefined();
    expect(pp).not.toMatch(/camera=\(self\)/);
    expect(pp).toMatch(/camera=(\*|\(self.*?\))/);
  });

  it('bin/serve.mjs Permissions-Policy is not restricted to (self)', () => {
    const src = readFileSync(join(repoRoot, 'bin', 'serve.mjs'), 'utf-8');
    const match = src.match(/'Permissions-Policy':\s*'([^']+)'/);
    expect(match, "Permissions-Policy not found in bin/serve.mjs").not.toBeNull();
    const value = match![1];
    expect(value).not.toMatch(/camera=\(self\)/);
    expect(value).toMatch(/camera=(\*|\(self.*?\))/);
  });
});
