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
//   --no-coep    Disable cross-origin-isolation headers (USDZ import will not
//                work, but everything else does)

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

// Defense-in-depth response headers. CSP allows the WASM eval that the
// OpenUSD + MuJoCo runtimes need; everything else stays on `'self'`.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    // cdn.jsdelivr.net hosts the MediaPipe `tasks-vision` WASM loader
    // that hand tracking calls via FilesetResolver. The loader script
    // is fetched as code, so it needs script-src too — not just
    // connect-src. storage.googleapis.com hosts the hand-landmarker
    // model file (fetched as bytes only).
    //
    // 'unsafe-eval' is required by the @mujoco/mujoco Emscripten
    // runtime, which uses `new Function(...)` for dynamic dispatch
    // during init. 'wasm-unsafe-eval' alone covers WebAssembly
    // compilation but not JS eval, so without 'unsafe-eval' MuJoCo
    // refuses to load and Motion mode's cube physics is silently
    // broken.
    //
    // 'unsafe-inline' is required because `index.html` runs two pre-
    // paint bootstrap blocks inline (theme persistence + ?clearStore
    // handler) that must execute synchronously before any module
    // loads. Without it, the page reloads in dark mode briefly even
    // when the user's persisted theme is light.
    //
    // blob: is required so `eiModel.ts` can dynamically `import()` a
    // blob URL containing the user's Edge Impulse model JS (ESM
    // fallback path C). Without it, ESM-style models silently fail.
    //
    // All three are tradeoffs against the original strict CSP but are
    // necessary for the features this app actually ships.
    "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' 'unsafe-inline' blob: https://va.vercel-scripts.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "connect-src 'self' https://*.edgeimpulse.com https://api-inference.huggingface.co https://va.vercel-scripts.com https://*.vercel-insights.com https://cdn.jsdelivr.net https://storage.googleapis.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    // The app ships a documented `?embed=1` mode (see
    // docs/url-parameters.md) for being iframed from external sites.
    // `frame-ancestors 'self'` would block every cross-origin
    // embedder. Use `*` so the documented embed feature works; tighten
    // to a specific allowlist if/when the set of embedders is known.
    "frame-ancestors *",
  ].join('; '),
};

const HEADERS = COEP
  ? {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      // Lets a cross-origin parent with `Cross-Origin-Embedder-Policy:
      // require-corp` embed this app in an iframe. Without it, strict-
      // COEP parents would block the iframe entirely. Paired with the
      // `frame-ancestors *` CSP for the documented `?embed=1` mode.
      'Cross-Origin-Resource-Policy': 'cross-origin',
      ...SECURITY_HEADERS,
    }
  : {
      'Cross-Origin-Resource-Policy': 'cross-origin',
      ...SECURITY_HEADERS,
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
      ...HEADERS,
    });
    res.end(data);
  } catch {
    // SPA fallback to index.html for unknown routes (so refresh works).
    try {
      const data = await readFile(path.join(DIST, 'index.html'));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        ...HEADERS,
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
