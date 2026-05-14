// Headless screenshots for the README/docs. Requires the dev server on :5173.
// Usage: node scripts/screenshot.mjs [target] [optional-usdz-path] [physics]
//   target = motion | detection | anomaly | robotics | rover | arm | all
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rawTarget = (process.argv[2] || 'detection').toLowerCase();
const outDir = path.join(__dirname, '..', 'docs', 'screenshots');
const usdzPath = process.argv[3];
const enablePhysics = process.argv[4] === 'physics';

const TARGETS = {
  motion: {
    appMode: 'motion',
    fileName: 'screenshot-motion.png',
  },
  detection: {
    appMode: 'detection',
    fileName: 'screenshot-detection.png',
    visionScene: true,
  },
  anomaly: {
    appMode: 'anomaly',
    fileName: 'screenshot-anomaly.png',
    visionScene: true,
  },
  robotics: {
    appMode: 'robot',
    robotKind: 'rover',
    fileName: 'screenshot-robotics.png',
    roboticsScene: true,
  },
  rover: {
    appMode: 'robot',
    robotKind: 'rover',
    fileName: 'screenshot-robotics-rover.png',
    roboticsScene: true,
  },
  arm: {
    appMode: 'robot',
    robotKind: 'arm',
    fileName: 'screenshot-robotics-arm.png',
    roboticsScene: true,
  },
};

const ALIASES = {
  robot: 'robotics',
  robots: 'robotics',
  'robotics-rover': 'rover',
  'robotics-arm': 'arm',
};

function normalizeTarget(target) {
  const normalized = ALIASES[target] ?? target;
  if (!TARGETS[normalized]) {
    const supported = [...Object.keys(TARGETS), 'all'].join(', ');
    throw new Error(`Unknown screenshot target "${target}". Use one of: ${supported}`);
  }
  return normalized;
}

const targetNames =
  rawTarget === 'all'
    ? Object.keys(TARGETS)
    : [normalizeTarget(rawTarget)];

const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  for (const targetName of targetNames) {
    const target = TARGETS[targetName];
    await captureTarget(target);
  }
} finally {
  await browser.close();
}

async function captureTarget(target) {
  const page = await browser.newPage();
  page.on('console', (msg) =>
    console.log(`[browser ${msg.type()}]`, msg.text()),
  );
  page.on('pageerror', (err) => console.log('[browser pageerror]', err));

  const params = new URLSearchParams({ mode: target.appMode });
  if (target.robotKind) params.set('robot', target.robotKind);
  await page.goto(`http://localhost:5173?${params.toString()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await waitForApp(page);
  await seedScene(page, target);

  if (target.visionScene && usdzPath) {
    await importUsdz(page, usdzPath, enablePhysics);
  }

  await sleep(target.appMode === 'motion' ? 2500 : 3000);

  const out = path.join(outDir, target.fileName);
  await page.screenshot({ path: out, type: 'png' });
  console.log(`wrote ${out}`);
  await page.close();
}

async function waitForApp(page) {
  await page.waitForSelector('.sidebar', { timeout: 10000 });
  await page.waitForSelector('canvas', { timeout: 10000 });
  await page.waitForFunction(() => window.__useStore, { timeout: 10000 });
  await sleep(800);
}

async function seedScene(page, target) {
  if (target.appMode === 'motion') return;

  await page.evaluate((target) => {
    const store = window.__useStore;
    const state = store.getState();

    state.setMode(target.appMode);
    state.clearSceneObjects();
    state.setShowConveyor(false);
    state.setRoverPose(null);
    state.setRoverInContact(false);
    state.setArmJoints(null);
    state.setArmTargetId(null);

    const addSceneObject = (kind, label, owner, patch = {}) => {
      store.getState().addSceneObject(kind, label, owner);
      const objects = store.getState().sceneObjects;
      const obj = objects[objects.length - 1];
      if (obj) store.getState().updateSceneObject(obj.id, patch);
      return obj?.id;
    };

    if (target.visionScene) {
      state.setShowConveyor(true);
      const objects = [
        ['cube', 'box', undefined, { position: [-0.45, 1.15, 0.15] }],
        ['sphere', 'ball', undefined, { position: [0.42, 1.2, -0.2] }],
        ['cylinder', 'can', undefined, { position: [-0.35, 1.2, -0.9] }],
        ['torus', 'ring', undefined, { position: [-0.45, 1.25, -1.8] }],
        ['capsule', 'capsule', undefined, { position: [0.4, 1.25, -2.0] }],
      ];
      for (const obj of objects) addSceneObject(...obj);
      return;
    }

    if (!target.roboticsScene) return;

    if (target.robotKind === 'arm') {
      const DEG = Math.PI / 180;
      state.setRobot({
        kind: 'arm',
        armTrajectory: 'pick_place',
        armCameraMount: 'wrist',
        armHomePose: [
          70 * DEG,
          15 * DEG,
          50 * DEG,
          90 * DEG,
          180 * DEG,
          1,
        ],
        count: 10,
        durationMs: 3000,
      });
      const targets = [
        ['cube', 'pickup cube', { color: '#5eead4' }],
        ['sphere', 'pickup ball', { color: '#f59e0b' }],
        ['cylinder', 'pickup can', { color: '#f472b6' }],
      ];
      for (const [kind, label, patch] of targets) {
        const id = store.getState().addArmPickupTarget(kind, label);
        store.getState().updateSceneObject(id, {
          ...patch,
          physics: false,
        });
      }
      const firstArmObject = store
        .getState()
        .sceneObjects.find((o) => o.owner === 'arm');
      state.setArmTargetId(firstArmObject?.id ?? null);
      // Mirror the rover screenshot: expose object detection + the
      // shared inference card in the arm-specific docs image.
      state.setRobot({
        objectDetection: true,
        captureAtRest: false,
        objectDetectionImagesPerIteration: 2,
      });
      return;
    }

    state.setRobot({
      kind: 'rover',
      roverEvent: target.fileName.includes('rover')
        ? 'collision'
        : 'cruise',
      lidarBins: 24,
      lidarMaxRange: 5,
      uploadModality: 'fused',
      rosExport: target.fileName.includes('rover'),
      count: 10,
      durationMs: 3000,
      // Show the object-detection + inference cards in the rover
      // dedicated screenshot so the docs reflect the new feature.
      objectDetection: target.fileName.includes('rover'),
      captureAtRest: false,
      objectDetectionImagesPerIteration: 3,
    });
    const obstacles = [
      [
        'cube',
        'crate',
        'rover',
        {
          position: [0.95, 0.26, 1.25],
          scale: 0.85,
          color: '#f59e0b',
          physics: false,
        },
      ],
      [
        'cylinder',
        'pillar',
        'rover',
        {
          position: [-1.15, 0.36, 1.85],
          scale: 0.9,
          color: '#38bdf8',
          physics: false,
        },
      ],
      [
        'cylinder',
        'pillar',
        'rover',
        {
          position: [0.45, 0.3, -1.05],
          scale: 0.75,
          color: '#e36a30',
          physics: false,
        },
      ],
      [
        'sphere',
        'marker',
        'rover',
        {
          position: [-0.75, 0.24, -1.6],
          scale: 0.6,
          color: '#a78bfa',
          physics: false,
        },
      ],
    ];
    for (const obj of obstacles) addSceneObject(...obj);
  }, target);
}

async function importUsdz(page, usdzPath, enablePhysics) {
  const fileInput = await page.$('input[type=file][accept=".usdz"]');
  if (!fileInput) return;

  await fileInput.evaluate((el) => el.scrollIntoView({ block: 'center' }));
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

  let imported = false;
  for (let i = 0; i < 40; i++) {
    imported = await page.evaluate(() => {
      const h = [...document.querySelectorAll('h3')].find((el) =>
        el.textContent?.startsWith('Import'),
      );
      const m = h?.textContent?.match(/\((\d+)\)\s*$/);
      return !!(m && parseInt(m[1], 10) > 0);
    });
    if (imported) break;
    await sleep(250);
  }
  if (!imported) {
    console.log('[script] USDZ import did not register');
    return;
  }
  console.log('[script] USDZ import succeeded');

  if (enablePhysics) {
    await page.evaluate(() => {
      const physChk = [...document.querySelectorAll('input[type=checkbox]')]
        .find((c) => c.parentElement?.textContent?.includes('Physics'));
      physChk?.click();
    });
    await sleep(2500);
  }
}
