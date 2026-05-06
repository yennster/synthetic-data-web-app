// Headless screenshot for the README. Requires the dev server running on :5173.
// Usage: node scripts/screenshot.mjs [mode]
//   mode = motion (default) | detection | anomaly
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] || 'detection';
const out = path.join(__dirname, '..', 'docs', `screenshot-${mode}.png`);

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
  defaultViewport: { width: 1500, height: 950, deviceScaleFactor: 2 },
});

try {
  const page = await browser.newPage();
  await page.goto('http://localhost:5173', {
    waitUntil: 'networkidle0',
    timeout: 30000,
  });
  await page.waitForSelector('.sidebar', { timeout: 10000 });
  await page.waitForSelector('canvas', { timeout: 10000 });

  if (mode !== 'motion') {
    // Click the mode button (Object detection or Visual anomaly).
    const buttonText = mode === 'detection' ? 'Object detection' : 'Visual anomaly';
    await page.evaluate((label) => {
      const btn = [...document.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === label,
      );
      btn?.click();
    }, buttonText);

    // Toggle conveyor and add a few objects so the scene is interesting.
    await page.evaluate(() => {
      const useStore = (window).__store;
      // Use the global hook escape: walk the React tree is brittle. Instead, dispatch DOM events.
      const conveyorChk = [...document.querySelectorAll('input[type=checkbox]')]
        .find((c) => c.parentElement?.textContent?.includes('Conveyor'));
      if (conveyorChk && !conveyorChk.checked) conveyorChk.click();
    });

    // Add objects via clicking the + Add button several times, switching the kind each time.
    const kinds = ['cube', 'sphere', 'cylinder', 'cone', 'torus', 'capsule'];
    for (const k of kinds) {
      await page.evaluate((kind) => {
        const sel = document.querySelector('select');
        // Find the "kind" select inside the Objects card. The Objects card is the second select in DOM order
        // (first is Mode buttons render isn't a select; first select is the Add Object selector since Sidebar
        // shows it before EI category selectors).
        const selects = document.querySelectorAll('select');
        const objSelect = [...selects].find((s) =>
          s.parentElement?.parentElement?.textContent?.includes('+ Add'),
        );
        if (objSelect) {
          objSelect.value = kind;
          objSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, k);
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(
          (b) => b.textContent?.trim() === '+ Add',
        );
        btn?.click();
      });
      await new Promise((r) => setTimeout(r, 50));
    }

    // Let physics settle and shadows render.
    await new Promise((r) => setTimeout(r, 2000));
  } else {
    await new Promise((r) => setTimeout(r, 2500));
  }

  await page.screenshot({ path: out, type: 'png' });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
