// End-to-end iframe-embed verification. Spins up a tiny cross-origin
// parent server, embeds the running dev app on :5173, then drives a
// headless Chrome through the embed to confirm:
//
//   1. The iframe response is served from a different origin than the
//      parent (otherwise we're not actually testing cross-origin
//      embedding).
//   2. The iframe document is `crossOriginIsolated === true`, which is
//      the COI-chain property the README promises. Requires COOP+COEP
//      on both the iframe response AND the parent response, AND the
//      parent must delegate via `allow="cross-origin-isolated"`.
//   3. `SharedArrayBuffer` is defined inside the iframe — without it
//      USDZ import would fail with the
//      `SharedArrayBuffer transfer requires self.crossOriginIsolated`
//      error we saw when COOP/COEP were paused.
//   4. The app actually renders — a <canvas> mounts and the sidebar's
//      mode pill shows up.
//
// Usage:
//   1. Start the dev server: `npm run dev` (listens on :5173).
//   2. `npm run test:iframe` — this script.
//
// The script does NOT start the dev server itself (intentional: keeps
// the test fast and avoids racing two long-lived processes). If :5173
// isn't responding, the script exits 1 with a hint.
//
// Exit codes:
//   0 — all 4 checks passed.
//   1 — anything failed; stderr describes which check.

import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_PORT = Number(process.env.APP_PORT || 5173);
const PARENT_PORT = Number(process.env.PARENT_PORT || 5181);
const APP_ORIGIN = `http://localhost:${APP_PORT}`;
const PARENT_ORIGIN = `http://127.0.0.1:${PARENT_PORT}`; // distinct host = cross-origin
const APP_URL = `${APP_ORIGIN}/`;
const PARENT_URL = `${PARENT_ORIGIN}/`;

const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Parent HTML that embeds the app. Mirrors the README example exactly:
// same `allow` tokens, no extra `src` query string. The Cross-Origin-
// Isolated header chain only works if the parent itself is COI, so we
// set COOP+COEP on the parent response below.
const PARENT_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Synthetic Data Studio · iframe embed harness</title>
</head>
<body style="margin:0;padding:0;background:#111">
  <iframe
    id="app"
    src="${APP_URL}"
    allow="camera; autoplay; fullscreen; cross-origin-isolated"
    width="1200" height="800"
    style="border:0;display:block">
  </iframe>
</body>
</html>
`;

function fail(message) {
  console.error(`\n[test-iframe-embed] FAIL: ${message}`);
  process.exit(1);
}

async function checkAppIsUp() {
  try {
    const res = await fetch(APP_URL);
    if (!res.ok) {
      fail(
        `app at ${APP_URL} returned ${res.status}. Start the dev server with \`npm run dev\` first.`,
      );
    }
  } catch (err) {
    fail(
      `app at ${APP_URL} is not reachable (${err?.message ?? err}). Start the dev server with \`npm run dev\` first.`,
    );
  }
}

function startParentServer() {
  // Tiny server that ships ONE document with the COOP+COEP combo a
  // cross-origin-isolated parent must have. CORP doesn't matter on the
  // parent's own response — it matters on subresources/iframes (and we
  // set CORP on the iframe response from the app side).
  const server = createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'no-store',
    });
    res.end(PARENT_HTML);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(PARENT_PORT, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  console.log(`[test-iframe-embed] app:    ${APP_URL}`);
  console.log(`[test-iframe-embed] parent: ${PARENT_URL}`);

  await checkAppIsUp();
  const parentServer = await startParentServer();

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: 'new',
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--enable-unsafe-swiftshader',
      ],
      defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 1 },
    });

    const page = await browser.newPage();

    // Surface anything the parent or iframe yells about into our stdout.
    page.on('pageerror', (err) =>
      console.log(`[browser pageerror] ${err.message}`),
    );
    page.on('console', (msg) => {
      const t = msg.type();
      if (t === 'error' || t === 'warning') {
        console.log(`[browser ${t}] ${msg.text()}`);
      }
    });

    await page.goto(PARENT_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    // 1. The iframe element is in the parent DOM, and its src points to
    //    the cross-origin app.
    const iframeSrc = await page.$eval('#app', (el) => el.src);
    if (!iframeSrc.startsWith(APP_ORIGIN)) {
      fail(
        `iframe src is "${iframeSrc}", expected to start with ${APP_ORIGIN}.`,
      );
    }
    const parentOrigin = await page.evaluate(() => window.location.origin);
    if (parentOrigin === APP_ORIGIN) {
      fail(
        `parent and iframe share origin ${parentOrigin}; this isn't a real cross-origin embed.`,
      );
    }
    console.log(`[test-iframe-embed] OK  iframe is cross-origin (${parentOrigin} → ${APP_ORIGIN}).`);

    // 2. Get the iframe's content frame. Puppeteer's `page.frames()`
    //    returns once the iframe has navigated; we wait for it.
    const iframeHandle = await page.waitForSelector('#app', { timeout: 10000 });
    const frame = await iframeHandle.contentFrame();
    if (!frame) fail('iframe contentFrame() returned null.');

    // Give the SPA a moment to bootstrap — react-three-fiber's first
    // canvas paint lands ~600ms after the html parse on a warm cache.
    await frame.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 15000 },
    );

    // 3. crossOriginIsolated === true inside the iframe. This is the
    //    headline property that the README "iframe embed" example
    //    promises. If this fails, USDZ import will fail in real embeds.
    const isolated = await frame.evaluate(() => self.crossOriginIsolated);
    if (isolated !== true) {
      fail(
        `iframe is NOT cross-origin-isolated (self.crossOriginIsolated = ${isolated}). ` +
          `Check: (a) the app sends COOP+COEP+CORP, (b) the parent sends COOP+COEP, ` +
          `(c) the parent delegates via <iframe allow="cross-origin-isolated">.`,
      );
    }
    console.log(`[test-iframe-embed] OK  iframe is cross-origin-isolated.`);

    // 4. SharedArrayBuffer is reachable. USDZ (OpenUSD WASM) needs this.
    const sabAvailable = await frame.evaluate(
      () => typeof SharedArrayBuffer === 'function',
    );
    if (!sabAvailable) {
      fail(
        `SharedArrayBuffer is not defined inside the iframe even though crossOriginIsolated is true. ` +
          `This shouldn't happen — investigate the Chrome version.`,
      );
    }
    console.log(`[test-iframe-embed] OK  SharedArrayBuffer is available (USDZ-ready).`);

    // 5. The app actually mounted: at least one <canvas> and a HUD
    //    pill. The pill text varies by mode (motion: "Hand:", detection
    //    / anomaly: "Mode:", robotics: "Mode:") — match any of them.
    await frame.waitForSelector('canvas', { timeout: 15000 });
    await frame.waitForFunction(
      () => {
        const hasCanvas = document.querySelector('canvas') !== null;
        const text = document.body.innerText || '';
        const hasHud = /Mode:|Hand:|Pinch:/i.test(text);
        return hasCanvas && hasHud;
      },
      { timeout: 15000 },
    );
    console.log(`[test-iframe-embed] OK  app rendered (canvas + HUD pill mounted).`);

    console.log(`\n[test-iframe-embed] PASS: all 4 checks succeeded.`);
  } finally {
    if (browser) await browser.close();
    parentServer.close();
  }
}

main().catch((err) => {
  console.error(`[test-iframe-embed] unexpected error: ${err?.stack ?? err}`);
  process.exit(1);
});
