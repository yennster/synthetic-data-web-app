#!/usr/bin/env node
// Tiny static file server that ships with the npm package. Serves the built
// app from ../dist with the COOP/COEP headers that the OpenUSD WASM runtime
// requires. Run via: `npx @yennster/synthetic-data-studio` (or after a global
// install, just `synthetic-data-studio`).
//
// Flags:
//   --port <n>   Listen on this port (default 5173, or $PORT)
//   --host <h>   Bind to this host (default 127.0.0.1 — pass 0.0.0.0 to
//                expose on the LAN)
//   --no-coep    Disable cross-origin-isolation headers (USDZ import will
//                not work but everything else does)
//
// Note: the strict defensive-headers block (CSP, Permissions-Policy,
// X-Content-Type-Options, Referrer-Policy) is paused — see
// drafts/security-hardening/ for the parked configuration. The COOP /
// COEP / CORP headers below stayed because they're functional
// requirements for SharedArrayBuffer (USDZ import), not defensive
// overlays.

import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_RAW = path.join(__dirname, '..', 'dist');
// Resolve symlinks once at boot so the per-request check compares apples
// to apples. realpath() on a non-existent path throws — that case is
// handled below where we used to call stat().
let DIST = DIST_RAW;

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const PORT = parseInt(arg('--port', process.env.PORT || '5173'), 10);
// Default to loopback so `npx synthetic-data-studio` doesn't silently
// expose the SPA to the local network. Pass `--host 0.0.0.0` to share.
const HOST = arg('--host', process.env.HOST || '127.0.0.1');
const COEP = !args.includes('--no-coep');

// Cross-origin isolation headers — required for SharedArrayBuffer (which
// the OpenUSD WASM in `three-usdz-loader` needs for USDZ import).
// `credentialless` is more permissive than `require-corp` and lets the
// MediaPipe CDN load without setting CORP on every response.
// CORP: cross-origin lets cross-origin iframe parents under strict
// COEP embed this app.
const COI_HEADERS = COEP
  ? {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    }
  : {
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.task': 'application/octet-stream',
  '.map': 'application/json',
};

try {
  // realpath() throws when missing — same effect as the old stat() probe,
  // and also collapses any symlink shenanigans on the package root once.
  DIST = await realpath(DIST_RAW);
} catch {
  console.error(
    `Build output not found at ${DIST_RAW}. Reinstall the package, or run "npm run build" if you cloned the repo.`,
  );
  process.exit(1);
}

// Hashed asset filenames look like `assets/index-abc123.js` — Vite emits
// content-addressed names so they're safe to cache aggressively. Everything
// else (index.html, /icons, root assets) gets revalidated each load.
const HASHED_ASSET_RE = /\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.[^.]+$/;
function cacheControlFor(urlPath) {
  return HASHED_ASSET_RE.test(urlPath)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}

// Returns the canonical absolute path inside DIST for `urlPath`, or null
// if the request escapes DIST (via `..`, absolute path, symlink, etc).
async function resolveSafe(urlPath) {
  // path.join collapses `..` and forces a relative-from-DIST resolution.
  const joined = path.join(DIST, '.' + path.posix.normalize(urlPath));
  // Compare with a trailing separator so `/dist-evil` doesn't pass a
  // prefix test against `/dist`.
  if (joined !== DIST && !joined.startsWith(DIST + path.sep)) return null;
  try {
    const real = await realpath(joined);
    if (real !== DIST && !real.startsWith(DIST + path.sep)) return null;
    return real;
  } catch {
    // Missing file — return the un-realpath'd value so the caller can
    // decide whether to 404 or fall back to index.html.
    return joined;
  }
}

const server = createServer(async (req, res) => {
  let urlPath;
  try {
    const parsed = new URL(req.url || '/', 'http://localhost');
    urlPath = decodeURIComponent(parsed.pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  const safe = await resolveSafe(urlPath);
  if (!safe) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const s = await stat(safe);
    const target = s.isDirectory() ? path.join(safe, 'index.html') : safe;
    // Re-check after the directory→index.html hop so a symlinked
    // directory target can't escape either.
    if (target !== DIST && !target.startsWith(DIST + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const data = await readFile(target);
    const ext = path.extname(target);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControlFor(urlPath),
      ...COI_HEADERS,
    });
    res.end(data);
  } catch {
    // SPA fallback to index.html for unknown routes (so refresh works).
    try {
      const data = await readFile(path.join(DIST, 'index.html'));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        ...COI_HEADERS,
      });
      res.end(data);
    } catch {
      res.writeHead(404).end('Not found');
    }
  }
});

server.listen(PORT, HOST, () => {
  const url =
    HOST === '0.0.0.0' || HOST === '::'
      ? `http://localhost:${PORT}`
      : `http://${HOST}:${PORT}`;
  console.log('Synthetic Data Studio');
  console.log(`  ${url}`);
  if (!COEP) {
    console.log(
      '  (COOP/COEP headers disabled — USDZ import will not work in this mode.)',
    );
  }
  console.log('  Press Ctrl+C to stop.');
});
