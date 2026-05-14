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
 * Find a card by its heading. Matches against:
 *   - a static `<h3>` (used by the Sidebar Mode card and the
 *     webcam-control "Object detection" card)
 *   - a `.card-heading-toggle <span>` (used by every CollapsibleCard)
 * Exact match first, then prefix so dynamic counts like
 * "Scene obstacles (4)" still resolve to "Scene obstacles".
 *
 * If the card is a CollapsibleCard in the collapsed state, the toggle
 * is clicked open before the screenshot so the docs show the card's
 * full contents, not just the heading bar.
 */
async function shotCardByHeading(page, heading, outPath) {
  const handle = await page.evaluateHandle((h) => {
    const cards = [...document.querySelectorAll('.card')];
    const headingText = (c) =>
      c.querySelector('.card-heading-toggle span')?.textContent?.trim() ??
      c.querySelector('h3')?.textContent?.trim() ??
      '';
    return (
      cards.find((c) => headingText(c) === h) ??
      cards.find((c) => headingText(c).startsWith(h)) ??
      null
    );
  }, heading);
  const el = handle.asElement();
  if (!el) {
    console.warn(`[script] no card found for heading "${heading}"`);
    return false;
  }
  // Expand the card body if it's a CollapsibleCard sitting closed —
  // otherwise the screenshot is just a single-line heading bar.
  await page.evaluate((card) => {
    const toggle = card.querySelector('button.card-heading-toggle');
    if (toggle && toggle.getAttribute('aria-expanded') === 'false') {
      toggle.click();
    }
  }, el);
  await sleep(250);
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
    // Light the Realism card up so its screenshot shows the full
    // feature surface (mode picker + five sliders + randomize toggle)
    // instead of the empty Off state. Applies to every mode that
    // renders RealismCard.
    if (
      mode === 'detection' ||
      mode === 'anomaly' ||
      mode === 'rover' ||
      mode === 'arm'
    ) {
      state.setRealism({ mode: 'random', randomize: true });
    }
    if (mode === 'detection' || mode === 'anomaly') {
      state.setShowConveyor(true);
      state.clearSceneObjects();
      const seed = [
        ['cube', 'box', undefined, { position: [-0.4, 1.2, 0] }],
        ['sphere', 'ball', undefined, { position: [0.4, 1.2, -0.6] }],
        ['torus', 'ring', undefined, { position: [-0.3, 1.25, -1.2] }],
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
      ['cube', 'sphere', 'cylinder'].forEach((k) =>
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
    'Realism',
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
    'Realism',
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
    'Realism',
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
    'Realism',
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
