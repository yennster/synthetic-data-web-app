// End-to-end iframe-embed verification across realistic embedder
// configurations. Each scenario spins up a fresh parent server on a
// distinct cross-origin (127.0.0.1:<port>) that serves a single HTML
// page embedding the running dev app on :5173 — with the headers and
// iframe attributes that scenario specifies. A headless Chrome opens
// the parent, and the script asserts whether the iframe is COI, has
// SharedArrayBuffer, and renders.
//
// USDZ import requires `crossOriginIsolated === true` inside the
// iframe, which requires the full chain:
//   1. Our iframe response sends COOP + COEP + CORP (shipped).
//   2. The parent itself is COI (sends COOP + COEP on its response).
//   3. The parent delegates COI to us via
//      <iframe allow="cross-origin-isolated">.
// Drop any link and USDZ fails. The scenarios below cover what happens
// at each break, plus a realistic studio.edgeimpulse.com-style embed.
//
// Usage:
//   1. `npm run dev` (listens on :5173). The script polls and exits 1
//      if it can't reach the dev server — no auto-start.
//   2. `npm run test:iframe`
//      Run all scenarios; exit 1 if any fail.
//   3. `npm run test:iframe -- <scenario-name>`
//      Run a single scenario by name.
//
// Exit codes:
//   0 — every scenario's actual results matched its `expect` block.
//   1 — at least one scenario diverged, or the dev server wasn't up.
//
// Environment:
//   APP_PORT     — app dev-server port (default 5173).
//   CHROME_PATH  — Chrome / Chromium executable. macOS default below;
//                  in CI set this to whatever `setup-chrome` outputs.
//   CI           — if set, adds --no-sandbox + --disable-dev-shm-usage
//                  to Chrome launch args (required on GitHub-hosted
//                  Ubuntu runners).

import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';

const APP_PORT = Number(process.env.APP_PORT || 5173);
const APP_ORIGIN = `http://localhost:${APP_PORT}`;
const APP_URL = `${APP_ORIGIN}/`;
const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const IS_CI = !!process.env.CI;

// Each scenario gets its own port so any port-stuck-from-a-previous-run
// failure mode is localized. Origins are cross-origin to the app
// (different port AND different host: 127.0.0.1 vs localhost).
const SCENARIOS = [
  {
    name: 'plain-parent',
    description:
      'Bare HTML parent, no security headers. Minimal embedder, no COI.',
    parentPort: 5181,
    parentHeaders: {},
    iframe: { allow: 'camera; autoplay; fullscreen; cross-origin-isolated' },
    expect: { coi: false, sab: false, render: true },
    // Parent isn't COI itself, so the iframe can't be COI either,
    // regardless of the `allow="cross-origin-isolated"` delegation.
  },
  {
    name: 'coi-parent-delegates',
    description:
      'Parent has COOP+COEP AND delegates cross-origin-isolated. Full feature embed.',
    parentPort: 5182,
    parentHeaders: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    iframe: { allow: 'camera; autoplay; fullscreen; cross-origin-isolated' },
    expect: { coi: true, sab: true, render: true },
  },
  {
    name: 'coi-parent-no-delegation',
    description:
      'COI parent but missing allow="cross-origin-isolated". USDZ breaks; everything else works.',
    parentPort: 5183,
    parentHeaders: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    iframe: { allow: 'camera; autoplay; fullscreen' },
    expect: { coi: false, sab: false, render: true },
  },
  {
    name: 'studio-edgeimpulse-mimic',
    description:
      'Mimics studio.edgeimpulse.com headers (strict CSP, X-headers, no COOP/COEP).',
    parentPort: 5184,
    // Real headers from `curl -I https://studio.edgeimpulse.com/` on
    // 2026-05-15, with one local relaxation: Studio's frame-src lists
    // edgeimpulse.com / *.edgeimpulse.com / youtube — for the test to
    // load OUR iframe we add http://localhost:* to frame-src so the
    // browser will load the embed. Everything else is real Studio.
    // Studio does NOT set COOP/COEP, so the iframe is not COI here.
    parentHeaders: {
      'Content-Security-Policy': [
        "default-src 'self' blob: edgeimpulse.com *.edgeimpulse.com",
        "img-src 'self' 'unsafe-inline' edgeimpulse.com *.edgeimpulse.com data:",
        "media-src 'self' edgeimpulse.com *.edgeimpulse.com blob: data:",
        "script-src 'self' 'unsafe-inline' blob:",
        "connect-src 'self' edgeimpulse.com *.edgeimpulse.com",
        "style-src 'self' 'unsafe-inline' edgeimpulse.com *.edgeimpulse.com",
        "base-uri 'self' edgeimpulse.com *.edgeimpulse.com",
        "frame-ancestors 'self' edgeimpulse.com *.edgeimpulse.com",
        "form-action 'self' edgeimpulse.com *.edgeimpulse.com",
        // Real Studio frame-src + http://localhost:* / http://127.0.0.1:*
        // so the test parent can actually embed the local dev app.
        "frame-src 'self' edgeimpulse.com *.edgeimpulse.com http://localhost:* http://127.0.0.1:*",
        "font-src 'self' edgeimpulse.com *.edgeimpulse.com",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin',
      // No COOP/COEP — matches real Studio. Iframe can't be COI.
    },
    iframe: { allow: 'camera; autoplay; fullscreen' },
    expect: { coi: false, sab: false, render: true },
  },
  {
    name: 'studio-edgeimpulse-with-coi',
    description:
      'Studio-like CSP + COOP/COEP + cross-origin-isolated delegation (the configuration Studio would need for USDZ to work inside its iframe).',
    parentPort: 5185,
    parentHeaders: {
      'Content-Security-Policy': [
        "default-src 'self' blob: edgeimpulse.com *.edgeimpulse.com",
        "img-src 'self' 'unsafe-inline' edgeimpulse.com *.edgeimpulse.com data:",
        "script-src 'self' 'unsafe-inline' blob:",
        "connect-src 'self' edgeimpulse.com *.edgeimpulse.com",
        "style-src 'self' 'unsafe-inline' edgeimpulse.com *.edgeimpulse.com",
        "frame-ancestors 'self' edgeimpulse.com *.edgeimpulse.com",
        "frame-src 'self' edgeimpulse.com *.edgeimpulse.com http://localhost:* http://127.0.0.1:*",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    iframe: { allow: 'camera; autoplay; fullscreen; cross-origin-isolated' },
    expect: { coi: true, sab: true, render: true },
  },
  {
    name: 'sandboxed-iframe',
    description:
      'Parent uses <iframe sandbox> with the typical relaxations a security-conscious embedder would set.',
    parentPort: 5186,
    parentHeaders: {},
    iframe: {
      allow: 'camera; autoplay; fullscreen',
      // The flags an embedder needs to keep the app functional:
      // - allow-scripts: app JS
      // - allow-same-origin: IndexedDB (textures), localStorage (theme)
      // - allow-forms: <input type="file">
      // - allow-downloads: <a download> for capture zips
      // - allow-popups: target="_blank" doc links
      sandbox:
        'allow-scripts allow-same-origin allow-forms allow-downloads allow-popups',
    },
    expect: { coi: false, sab: false, render: true },
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildParentHtml({ parentPort, iframe }) {
  const sandboxAttr = iframe.sandbox ? ` sandbox="${iframe.sandbox}"` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>iframe embed harness · port ${parentPort}</title>
</head>
<body style="margin:0;padding:0;background:#111">
  <iframe
    id="app"
    src="${APP_URL}"
    allow="${iframe.allow}"${sandboxAttr}
    width="1200" height="800"
    style="border:0;display:block">
  </iframe>
</body>
</html>
`;
}

async function checkAppIsUp() {
  try {
    const res = await fetch(APP_URL);
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (err) {
    console.error(
      `\n[test-iframe-embed] FATAL: app at ${APP_URL} is not reachable (${err?.message ?? err}).`,
    );
    console.error('Start the dev server with `npm run dev` first.');
    process.exit(1);
  }
}

function startParentServer(scenario) {
  const html = buildParentHtml(scenario);
  const server = createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...scenario.parentHeaders,
    });
    res.end(html);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(scenario.parentPort, '127.0.0.1', () => resolve(server));
  });
}

async function runScenario(browser, scenario) {
  const parentOrigin = `http://127.0.0.1:${scenario.parentPort}`;
  const parentUrl = `${parentOrigin}/`;
  console.log(`\n[${scenario.name}] ${scenario.description}`);
  console.log(`[${scenario.name}] parent=${parentUrl}  iframe=${APP_URL}`);

  const parentServer = await startParentServer(scenario);
  const page = await browser.newPage();
  const browserErrors = [];
  page.on('pageerror', (err) => browserErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') browserErrors.push(`console: ${msg.text()}`);
  });

  const failures = [];
  try {
    await page.goto(parentUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    // The iframe element must be in the parent DOM and point at the
    // cross-origin app.
    const iframeSrc = await page.$eval('#app', (el) => el.src);
    if (!iframeSrc.startsWith(APP_ORIGIN)) {
      failures.push(`iframe src is "${iframeSrc}", expected ${APP_ORIGIN}`);
    }
    const observedParentOrigin = await page.evaluate(() => window.location.origin);
    if (observedParentOrigin === APP_ORIGIN) {
      failures.push(
        `parent and iframe share origin ${observedParentOrigin} (not a real cross-origin embed)`,
      );
    }

    const handle = await page.waitForSelector('#app', { timeout: 10000 });
    const frame = await handle.contentFrame();
    if (!frame) {
      failures.push('iframe contentFrame() returned null — frame blocked?');
    } else {
      // Wait for the iframe doc to be ready. Sandboxed iframes still
      // navigate; CSP-blocked iframes return null (handled above).
      try {
        await frame.waitForFunction(
          () => document.readyState === 'complete',
          { timeout: 20000 },
        );
      } catch {
        failures.push('iframe document did not reach readyState=complete');
      }

      // Give react-three-fiber a beat to mount the canvas.
      await sleep(800);

      const coi = await frame.evaluate(() => self.crossOriginIsolated).catch(() => null);
      const sab = await frame
        .evaluate(() => typeof SharedArrayBuffer === 'function')
        .catch(() => false);
      const rendered = await frame
        .evaluate(() => {
          const hasCanvas = document.querySelector('canvas') !== null;
          const text = (document.body && document.body.innerText) || '';
          const hasHud = /Mode:|Hand:|Pinch:/i.test(text);
          return hasCanvas && hasHud;
        })
        .catch(() => false);

      const want = scenario.expect;
      if (coi !== want.coi) {
        failures.push(`crossOriginIsolated: expected ${want.coi}, got ${coi}`);
      }
      if (sab !== want.sab) {
        failures.push(`SharedArrayBuffer available: expected ${want.sab}, got ${sab}`);
      }
      if (rendered !== want.render) {
        failures.push(`canvas+HUD rendered: expected ${want.render}, got ${rendered}`);
      }
    }
  } finally {
    await page.close();
    parentServer.close();
  }

  const status = failures.length === 0 ? 'PASS' : 'FAIL';
  console.log(`[${scenario.name}] ${status}`);
  for (const f of failures) console.log(`  • ${f}`);
  if (browserErrors.length && failures.length) {
    console.log(`  browser errors:`);
    for (const e of browserErrors.slice(0, 5)) console.log(`    ${e}`);
  }
  return failures.length === 0;
}

async function main() {
  const arg = process.argv[2];
  const scenariosToRun = arg
    ? SCENARIOS.filter((s) => s.name === arg)
    : SCENARIOS;
  if (arg && scenariosToRun.length === 0) {
    console.error(`Unknown scenario "${arg}". Available:`);
    for (const s of SCENARIOS) console.error(`  - ${s.name}`);
    process.exit(1);
  }

  console.log(`[test-iframe-embed] app=${APP_URL}`);
  console.log(`[test-iframe-embed] running ${scenariosToRun.length} scenario(s)`);
  await checkAppIsUp();

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      ...(IS_CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ],
    defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 1 },
  });

  let passed = 0;
  let failed = 0;
  try {
    for (const scenario of scenariosToRun) {
      const ok = await runScenario(browser, scenario);
      if (ok) passed += 1;
      else failed += 1;
    }
  } finally {
    await browser.close();
  }

  console.log(
    `\n[test-iframe-embed] ${passed} passed, ${failed} failed (${scenariosToRun.length} total)`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`[test-iframe-embed] unexpected error: ${err?.stack ?? err}`);
  process.exit(1);
});
