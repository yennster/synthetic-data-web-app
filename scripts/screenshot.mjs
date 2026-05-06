// Headless screenshot for the README. Requires the dev server running on :5173.
// Usage: node scripts/screenshot.mjs
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(__dirname, '..', 'docs', 'screenshot.png');

const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
  ],
  defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 2 },
});

try {
  const page = await browser.newPage();
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle0', timeout: 30000 });
  // Wait for canvas + sidebar + scene to be present and settle.
  await page.waitForSelector('.sidebar', { timeout: 10000 });
  await page.waitForSelector('canvas', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 2500)); // let three.js render a few frames
  await page.screenshot({ path: out, type: 'png' });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
