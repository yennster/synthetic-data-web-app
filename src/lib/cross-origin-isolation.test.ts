import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

// The full defensive header stack (CSP, Permissions-Policy, etc.) is
// parked in drafts/security-hardening/. These three headers are NOT in
// that bucket — they're functional requirements for SharedArrayBuffer
// (which the OpenUSD WASM in `three-usdz-loader` uses for USDZ import).
// If they regress on any of the three surfaces (Vite dev server,
// vercel.json, bin/serve.mjs), USDZ import breaks immediately with
// `SharedArrayBuffer transfer requires self.crossOriginIsolated`.
// These tests are the trip-wire.

describe('Cross-origin isolation headers (USDZ functional requirement)', () => {
  it('vercel.json sets COOP, COEP, and CORP on every path', () => {
    const json = JSON.parse(
      readFileSync(join(repoRoot, 'vercel.json'), 'utf-8'),
    ) as {
      headers: Array<{
        source: string;
        headers: Array<{ key: string; value: string }>;
      }>;
    };
    const rootBlock = json.headers.find((h) => h.source === '/(.*)');
    expect(rootBlock, 'vercel.json missing /(.*) header block').toBeDefined();
    const byKey = Object.fromEntries(
      rootBlock!.headers.map((h) => [h.key, h.value]),
    );
    expect(byKey['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(byKey['Cross-Origin-Embedder-Policy']).toBe('credentialless');
    expect(byKey['Cross-Origin-Resource-Policy']).toBe('cross-origin');
  });

  it('vite.config.ts dev server sends COOP and COEP', () => {
    const src = readFileSync(join(repoRoot, 'vite.config.ts'), 'utf-8');
    expect(src).toMatch(
      /'Cross-Origin-Opener-Policy':\s*'same-origin'/,
    );
    expect(src).toMatch(
      /'Cross-Origin-Embedder-Policy':\s*'credentialless'/,
    );
  });

  it('bin/serve.mjs spreads COI_HEADERS into both response paths', () => {
    const src = readFileSync(join(repoRoot, 'bin', 'serve.mjs'), 'utf-8');
    // Header value definitions.
    expect(src).toMatch(
      /'Cross-Origin-Opener-Policy':\s*'same-origin'/,
    );
    expect(src).toMatch(
      /'Cross-Origin-Embedder-Policy':\s*'credentialless'/,
    );
    expect(src).toMatch(
      /'Cross-Origin-Resource-Policy':\s*'cross-origin'/,
    );
    // And the spread into both writeHead() calls. Two spreads = file +
    // SPA-fallback paths. If either gets dropped, requests to that path
    // silently lose isolation.
    const spreadCount = (src.match(/\.\.\.COI_HEADERS/g) || []).length;
    expect(spreadCount).toBeGreaterThanOrEqual(2);
  });

  it('public/_headers (Netlify/CF Pages) sends COOP, COEP, and CORP', () => {
    const src = readFileSync(join(repoRoot, 'public', '_headers'), 'utf-8');
    expect(src).toMatch(/Cross-Origin-Opener-Policy:\s*same-origin/);
    expect(src).toMatch(/Cross-Origin-Embedder-Policy:\s*credentialless/);
    expect(src).toMatch(/Cross-Origin-Resource-Policy:\s*cross-origin/);
  });
});

describe('Warehouse HDR URL (COEP-compatible)', () => {
  // Under `COEP: credentialless` a cross-origin resource must send
  // `Cross-Origin-Resource-Policy` or the fetch fails with "Load
  // failed" — independent of CSP. raw.githubusercontent.com (drei's
  // default) does NOT send CORP; cdn.jsdelivr.net DOES. We override
  // drei's `preset="warehouse"` default to point at jsdelivr.
  //
  // This test fails if anyone reverts to `preset="warehouse"` without
  // also providing a `files=` override — which would break the warehouse
  // env at runtime under our current COEP credentialless deployment.

  it('Scene.tsx points <Environment files=…> at jsdelivr', () => {
    const src = readFileSync(
      join(repoRoot, 'src', 'components', 'Scene.tsx'),
      'utf-8',
    );
    // The URL itself.
    expect(
      src,
      'WAREHOUSE_HDR_URL should be defined in Scene.tsx',
    ).toMatch(/WAREHOUSE_HDR_URL\s*=\s*['"]([^'"]+)['"]/);
    const match = src.match(/WAREHOUSE_HDR_URL\s*=\s*['"]([^'"]+)['"]/);
    const url = match![1];
    expect(url).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/gh\/pmndrs\/drei-assets/);
    expect(url).toMatch(/hdri\/empty_warehouse_01_1k\.hdr$/);
    // Must NOT point at raw.githubusercontent.com — that host doesn't
    // send CORP, so the fetch fails under COEP credentialless.
    expect(url).not.toMatch(/raw\.githubusercontent\.com/);

    // The <Environment> usage must consume the URL via `files=…`, not
    // `preset="warehouse"` (which would re-introduce the default
    // raw.githubusercontent.com fetch).
    expect(src).toMatch(/<Environment\s+files=\{WAREHOUSE_HDR_URL\}/);
    expect(src).not.toMatch(/<Environment\s+preset="warehouse"/);
  });
});
