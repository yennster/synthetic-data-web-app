// Capture close-ups of individual sidebar cards for the blog post.
// Usage: node scripts/screenshot-cards.mjs
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'docs');
const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function shotCardByHeading(page, heading, outPath) {
  const handle = await page.evaluateHandle((h) => {
    const card = [...document.querySelectorAll('.card')].find(
      (c) => c.querySelector('h3')?.textContent?.trim() === h,
    );
    return card ?? null;
  }, heading);
  const el = handle.asElement();
  if (!el) {
    console.warn(`[script] no card found for heading "${heading}"`);
    return;
  }
  await el.scrollIntoView();
  await el.screenshot({ path: outPath, type: 'png' });
  console.log(`wrote ${outPath}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1500, height: 950, deviceScaleFactor: 2 },
});

try {
  const page = await browser.newPage();
  await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 800));

  // Motion mode is the default — capture procedural motions + auth card.
  await shotCardByHeading(
    page,
    'Procedural motions',
    path.join(outDir, 'screenshot-procedural-motions.png'),
  );
  await shotCardByHeading(
    page,
    'Edge Impulse · auth',
    path.join(outDir, 'screenshot-auth.png'),
  );

  // Switch to detection mode to grab the inference card.
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Object detection',
    );
    btn?.click();
  });
  await new Promise((r) => setTimeout(r, 800));
  await shotCardByHeading(
    page,
    'Inference (Edge Impulse model)',
    path.join(outDir, 'screenshot-inference.png'),
  );
} finally {
  await browser.close();
}
