#!/usr/bin/env node
// Tiny static file server that ships with the npm package. Serves the built
// app from ../dist with the COOP/COEP headers that the OpenUSD WASM runtime
// requires. Run via: `npx @yennster/synthetic-data-studio` (or after a global
// install, just `synthetic-data-studio`).
//
// Flags:
//   --port <n>   Listen on this port (default 5173, or $PORT)
//   --host <h>   Bind to this host (default 0.0.0.0)
//   --no-coep    Disable cross-origin-isolation headers (USDZ import will not
//                work, but everything else does)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const PORT = parseInt(arg('--port', process.env.PORT || '5173'), 10);
const HOST = arg('--host', '0.0.0.0');
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

const HEADERS = COEP
  ? {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    }
  : {};

try {
  await stat(DIST);
} catch {
  console.error(
    `Build output not found at ${DIST}. Reinstall the package, or run "npm run build" if you cloned the repo.`,
  );
  process.exit(1);
}

const server = createServer(async (req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url.endsWith('/')) url += 'index.html';
  const filePath = path.join(DIST, url);
  // Resolve must stay inside DIST (prevent path traversal).
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const s = await stat(filePath);
    const target = s.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    const data = await readFile(target);
    const ext = path.extname(target);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...HEADERS,
    });
    res.end(data);
  } catch {
    // SPA fallback to index.html for unknown routes (so refresh works).
    try {
      const data = await readFile(path.join(DIST, 'index.html'));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
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
