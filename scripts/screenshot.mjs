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
  page.on('console', (msg) =>
    console.log(`[browser ${msg.type()}]`, msg.text()),
  );
  page.on('pageerror', (err) => console.log('[browser pageerror]', err));
  await page.goto('http://localhost:5173', {
    waitUntil: 'domcontentloaded',
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

    // Optional: enable physics on imported USDZ (4th argv = "physics")
    const enablePhysics = process.argv[4] === 'physics';
    // Optional: import a USDZ if a path was passed as 3rd argv
    const usdzPath = process.argv[3];
    if (usdzPath) {
      const fileInput = await page.$('input[type=file][accept=".usdz"]');
      if (fileInput) {
        await fileInput.evaluate((el) =>
          el.scrollIntoView({ block: 'center' }),
        );
        // Read the local file → base64 → install via DataTransfer in the page.
        const fs = await import('node:fs/promises');
        const buf = await fs.readFile(usdzPath);
        const b64 = buf.toString('base64');
        const fileName = usdzPath.split('/').pop();
        await page.evaluate(
          async (b64, name) => {
            const bin = atob(b64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            const file = new File([arr], name, { type: 'model/vnd.usdz+zip' });
            const dt = new DataTransfer();
            dt.items.add(file);
            const input = document.querySelector(
              'input[type=file][accept=".usdz"]',
            );
            input.files = dt.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
          },
          b64,
          fileName,
        );
        // Poll until the asset count appears.
        let imported = false;
        for (let i = 0; i < 40; i++) {
          imported = await page.evaluate(() => {
            const h = [...document.querySelectorAll('h3')].find((el) =>
              el.textContent?.startsWith('Import'),
            );
            // Match the count parens: e.g. "Import (.usdz) (1)" → 1
            const m = h?.textContent?.match(/\((\d+)\)\s*$/);
            return !!(m && parseInt(m[1], 10) > 0);
          });
          if (imported) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        if (!imported) console.log('[script] USDZ import did not register');
        else console.log('[script] USDZ import succeeded');

        if (enablePhysics) {
          // Toggle the per-asset Physics checkbox on the just-imported asset.
          await page.evaluate(() => {
            const physChk = [...document.querySelectorAll('input[type=checkbox]')]
              .find((c) => c.parentElement?.textContent?.includes('Physics'));
            physChk?.click();
          });
          // Let physics settle.
          await new Promise((r) => setTimeout(r, 2500));
        }
      }
    }

    // Let physics settle and shadows render.
    await new Promise((r) => setTimeout(r, 2500));
  } else {
    await new Promise((r) => setTimeout(r, 2500));
  }

  await page.screenshot({ path: out, type: 'png' });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
