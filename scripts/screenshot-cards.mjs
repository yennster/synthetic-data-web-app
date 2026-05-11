// Close-up screenshots of every sidebar card in every mode. Output
// lands in docs/screenshots/, named card-<mode>-<slug>.png. Requires
// the dev server on :5173.
//
// Usage: node scripts/screenshot-cards.mjs [mode]
//   mode = motion | detection | anomaly | rover | arm | all (default)
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'docs', 'screenshots');
const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Find a card by its <h3> heading. The fast path matches the exact
 * heading string; the fallback matches by prefix so dynamic counts
 * like "Scene obstacles (4)" still resolve to "Scene obstacles".
 */
async function shotCardByHeading(page, heading, outPath) {
  const handle = await page.evaluateHandle((h) => {
    const cards = [...document.querySelectorAll('.card')];
    return (
      cards.find((c) => c.querySelector('h3')?.textContent?.trim() === h) ??
      cards.find((c) =>
        c.querySelector('h3')?.textContent?.trim().startsWith(h),
      ) ??
      null
    );
  }, heading);
  const el = handle.asElement();
  if (!el) {
    console.warn(`[script] no card found for heading "${heading}"`);
    return false;
  }
  await el.scrollIntoView();
  await sleep(200);
  await el.screenshot({ path: outPath, type: 'png' });
  console.log(`wrote ${outPath}`);
  return true;
}

async function setMode(page, mode) {
  await page.evaluate((m) => {
    const labels = {
      motion: 'Motion',
      detection: 'Object detection',
      anomaly: 'Visual anomaly',
      robot: 'Robotics',
    };
    const btn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === labels[m],
    );
    btn?.click();
  }, mode);
  await sleep(800);
}

async function seedScene(page, modeKey) {
  await page.evaluate((mode) => {
    const store = window.__useStore;
    const state = store.getState();
    if (mode === 'detection' || mode === 'anomaly') {
      state.setShowConveyor(true);
      state.clearSceneObjects();
      const seed = [
        ['cube', 'box', undefined, { position: [-0.4, 1.2, 0] }],
        ['sphere', 'ball', undefined, { position: [0.4, 1.2, -0.6] }],
        ['cone', 'cone', undefined, { position: [-0.3, 1.2, -1.2] }],
      ];
      for (const [k, l, o, p] of seed) {
        state.addSceneObject(k, l, o);
        const objs = store.getState().sceneObjects;
        store.getState().updateSceneObject(objs[objs.length - 1].id, p);
      }
    }
    if (mode === 'rover') {
      state.setRobot({
        kind: 'rover',
        roverEvent: 'collision',
        objectDetection: true,
        captureAtRest: false,
        objectDetectionImagesPerIteration: 3,
      });
      state.clearSceneObjects();
      const seed = [
        ['cube', 'crate', 'rover', { position: [0.8, 0.3, 1.2], scale: 0.8 }],
        ['cylinder', 'pillar', 'rover', { position: [-1.0, 0.3, 1.5], scale: 0.9 }],
      ];
      for (const [k, l, o, p] of seed) {
        state.addSceneObject(k, l, o);
        const objs = store.getState().sceneObjects;
        store.getState().updateSceneObject(objs[objs.length - 1].id, p);
      }
    }
    if (mode === 'arm') {
      const DEG = Math.PI / 180;
      state.setRobot({
        kind: 'arm',
        armTrajectory: 'pick_place',
        armCameraMount: 'wrist',
        armHomePose: [70 * DEG, 15 * DEG, 50 * DEG, 90 * DEG, 180 * DEG, 1],
        objectDetection: true,
        captureAtRest: false,
        objectDetectionImagesPerIteration: 2,
      });
      state.clearSceneObjects();
      ['cube', 'sphere', 'cone'].forEach((k) =>
        state.addArmPickupTarget(k, 'pickup'),
      );
    }
  }, modeKey);
  await sleep(1500);
}

/**
 * Every card we want a close-up of, keyed by mode. The strings are
 * the <h3> headings — `shotCardByHeading` also accepts a prefix so
 * "Scene obstacles" matches "Scene obstacles (N)".
 */
const CARDS = {
  motion: [
    'Mode',
    'Object',
    'Recording',
    'Procedural motions',
    'Edge Impulse · auth',
    'Upload to Edge Impulse',
  ],
  detection: [
    'Mode',
    'Scene',
    'Objects',
    'Import (.usdz)',
    'Capture from real life',
    'Virtual camera',
    'Capture',
    'Edge Impulse · auth',
    'Inference (Edge Impulse model)',
    'Upload to Edge Impulse',
  ],
  anomaly: [
    'Mode',
    'Scene',
    'Objects',
    'Import (.usdz)',
    'Capture from real life',
    'Virtual camera',
    'Capture',
    'Edge Impulse · auth',
    'Inference (Edge Impulse model)',
    'Upload to Edge Impulse',
  ],
  rover: [
    'Mode',
    'Robot',
    'Event',
    'Recording',
    'Scene obstacles',
    'Imported obstacles',
    'Lidar / ToF ring',
    'Sensor modality',
    'Object detection',
    'Edge Impulse · auth',
    'Inference (Edge Impulse model)',
    'Generate',
  ],
  arm: [
    'Mode',
    'Robot',
    'Trajectory',
    'POV camera mount',
    'Pickup objects',
    'Imported pickups',
    'Recording',
    'Object detection',
    'Edge Impulse · auth',
    'Inference (Edge Impulse model)',
    'Generate',
  ],
};

const MODE_TO_APPMODE = {
  motion: 'motion',
  detection: 'detection',
  anomaly: 'anomaly',
  rover: 'robot',
  arm: 'robot',
};

const requested = (process.argv[2] || 'all').toLowerCase();
const modes =
  requested === 'all' ? Object.keys(CARDS) : [requested];
for (const m of modes) {
  if (!CARDS[m]) {
    console.error(`Unknown mode "${m}". Use one of: ${[...Object.keys(CARDS), 'all'].join(', ')}`);
    process.exit(1);
  }
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
  await page.waitForFunction(() => window.__useStore, { timeout: 10000 });
  await sleep(800);

  for (const modeKey of modes) {
    await setMode(page, MODE_TO_APPMODE[modeKey]);
    await page.evaluate((modeKey) => {
      const s = window.__useStore.getState();
      if (modeKey === 'rover')
        s.setRobot({ kind: 'rover', objectDetection: true });
      if (modeKey === 'arm')
        s.setRobot({ kind: 'arm', objectDetection: true });
    }, modeKey);
    await sleep(500);
    await seedScene(page, modeKey);

    for (const heading of CARDS[modeKey]) {
      const out = path.join(outDir, `card-${modeKey}-${slug(heading)}.png`);
      await shotCardByHeading(page, heading, out);
    }
  }
} finally {
  await browser.close();
}
