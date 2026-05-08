# Synthetic Data Studio

[![Release](https://img.shields.io/github/v/release/yennster/synthetic-data-studio?label=release&color=5eead4)](https://github.com/yennster/synthetic-data-studio/releases)
[![Tests](https://img.shields.io/github/actions/workflow/status/yennster/synthetic-data-studio/test.yml?label=tests&logo=vitest&logoColor=fff)](https://github.com/yennster/synthetic-data-studio/actions/workflows/test.yml)
[![CI](https://img.shields.io/github/actions/workflow/status/yennster/synthetic-data-studio/release.yml?label=release%20pipeline)](https://github.com/yennster/synthetic-data-studio/actions/workflows/release.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/yennster/synthetic-data-studio?style=flat&color=f59e0b)](https://github.com/yennster/synthetic-data-studio/stargazers)
[![Built with React](https://img.shields.io/badge/built%20with-React%2018-61dafb?logo=react&logoColor=fff)](https://react.dev)
[![Three.js](https://img.shields.io/badge/three.js-r169-000?logo=threedotjs&logoColor=fff)](https://threejs.org)
[![Edge Impulse](https://img.shields.io/badge/Edge%20Impulse-ingestion%20API-1a73e8)](https://www.edgeimpulse.com/)

A browser-based 3D tool for generating synthetic training data for [Edge Impulse](https://www.edgeimpulse.com/) projects. Three modes in one app:

- **Motion** — Manipulate a virtual object with hand-tracked pinch gestures via your webcam (or skip the camera entirely with the toggle off), capture realistic **6-channel IMU data** (3-axis accelerometer + 3-axis gyroscope, both in the object's body frame), and upload to Edge Impulse. Includes a **procedural drops** generator that auto-lifts the object to randomized heights, releases it, records each fall, and uploads each drop as its own labelled sample — produces dozens of physically-consistent training samples in seconds without you ever touching the mouse.
- **Object detection** — Drop objects (cube, sphere, cylinder, cone, torus, capsule, phone slab, soda can) into the scene, pick a backdrop (studio / warehouse / whitebox / outdoor), optionally onto a conveyor belt, point a virtual camera at them, capture single shots or randomized batches with bounding boxes auto-projected, save to a local directory, and upload as a labelled image dataset. Run a trained Edge Impulse model **directly in-browser** for live detection / FOMO inference with crisp 2D bounding boxes, labels, and centroid dots on the virtual-camera preview.
- **Visual anomaly detection** — Same capture pipeline as detection, but emits unlabelled images with a single batch-level label (e.g. `normal` / `anomaly`).

Created with Claude Code.

![Synthetic Data Studio · Object Detection mode](docs/screenshot-detection.png)

*Object detection mode: 6 labelled objects on a scrolling conveyor belt, virtual capture camera shown as the orange frustum gizmo, live preview in the bottom-left corner.*

![Synthetic Data Studio · Motion mode](docs/screenshot-motion.png)

*Motion mode: pinch the cube with your hand to grab it, throw it onto the ground, record the accelerometer trace.*

## Features

### Shared
- **Realistic 3D scene** — HDRI environment lighting (`warehouse` preset), ACES Filmic tone mapping, soft shadows, contact shadows, infinite ground grid.
- **Resizable corner overlay** — drag the bottom-right corner of the webcam (motion mode) or virtual-camera preview (vision modes) to make it as big as you like; aspect ratio is locked so the canvas content never distorts.
- **Live HUD** with mode-aware status pills.
- **Direct Edge Impulse upload** via the [Ingestion API](https://docs.edgeimpulse.com/reference/data-ingestion/ingestion-api).
- **API key never persisted** — held in memory for the session only.

### Motion mode
- **Hand tracking** via Google MediaPipe `HandLandmarker` (in-browser, GPU/WASM, ~60 fps). Toggle off in the Object card if you'd rather work cameraless — no permission prompt, no camera light.
- **Pinch-to-grab + rotate** — close thumb-to-index to grab; rotate your hand and the held body's orientation tracks your palm in real time (palm-up basis derived from MediaPipe landmarks, slerp-smoothed, composed with the camera yaw so orbiting the scene doesn't desync the rotation). Hysteresis on the pinch threshold keeps tracking jitter from dropping the object.
- **Throw / drop physics** — released objects inherit your hand's velocity.
- **6-channel IMU output** — accelerometer (m/s², proper acceleration: `+9.81` up when stationary, near-zero in freefall) **and** gyroscope (rad/s, angular velocity), both transformed from world space into the object's local body frame each tick. EI payload `sensors`: `[accX, accY, accZ, gyrX, gyrY, gyrZ]`.
- **All eight object kinds available** — cube, sphere, cylinder, cone, torus, capsule, phone slab, soda can. Pick one in the Object card; rapier auto-rebuilds the collider for the new shape.
- **Procedural motion generator** — pick a class (`drop`, `throw`, `push`, `shake`), set count (1–500), height range, and per-sample record duration, then click **⚡ Generate & upload N samples** when an API key is set, or **⚡ Generate & download N samples** for local files. Each sample lifts the body to a random `(x, y, z)` and a uniformly-random orientation, then runs the chosen motion: free-fall release for **drop**, accelerated kinematic launch with horizontal velocity + small upward arc for **throw**, low-altitude lateral shove that slides on friction for **push**, or sinusoidal oscillation along a random axis at 3–6 Hz for **shake**. The IMU trace is recorded and uploaded as a separate Edge Impulse sample labelled with the motion class (`{motion}_{i}.json`). Click **■ Stop** to cancel mid-run — the runner unwinds at the next checkpoint and packages whatever finished. Hand tracking is auto-paused for the duration.
- **Configurable sample rate** (20–500 Hz, default 100 Hz).
- HMAC-SHA256 signed uploads optional.
- **Auto-attached EI metadata** — every uploaded sample carries an `x-metadata` JSON header (per the [EI metadata API](https://docs.edgeimpulse.com/studio/projects/data-acquisition/metadata)) tagging it with `source: Synthetic Data Studio`, the page URL, the object kind, the motion class (motion mode) or scene contents (vision mode: shapes present, USDZ asset filenames + labels, environment preset, conveyor state, image dimensions, capture timestamp). Lets you filter the EI data view by where samples came from and how they were generated — no UI fields, fully automatic.

### Object detection / Visual anomaly mode
- **Environment presets** — pick a backdrop in the Scene card: **Studio** (dark, no walls — original look), **Warehouse** (procedurally-textured concrete floor with cracks/stains and painted concrete walls on all four sides), **White box** (cyclorama for product photography), **Outdoor** (procedural grass + sky-blue gradient backdrop visible to the virtual camera). All textures generated on the fly — no external assets to ship.
- **Custom textures** — upload tileable images (PNG, JPG, WebP, AVIF, or GIF) for three slots: **Floor**, **Wall**, and **Object**. Floor tiles 4× and walls tile 2× across the scene; uploading a wall texture also forces walls to render on `studio` / `outdoor` so the upload can't be silently invisible. The **Object** slot re-skins every default-shape mesh — both the motion-mode body and the detection/anomaly spawned cubes/spheres/etc. — with a single upload, so you can train a "wood cube vs. metal cube" classifier without reauthoring per-object materials. Bytes live in IndexedDB so a single texture can be many MB without bloating localStorage; metadata persists across reloads. **Reset scene** wipes all three slots back to defaults.
- **Multi-object spawning** — add any number of objects to the scene with custom labels and colors. Each new object's label auto-tracks the kind dropdown (pick "sphere" → label defaults to `sphere`), so you don't end up with five things all labelled "cube". Per-object **Size** slider + numeric input and **Physics** on/off toggle (turn physics off to pin a backdrop object to its position; turn it on for the ones you want falling/rolling/riding the belt).
- **Shift+drag to move** — hold Shift and click+drag any spawned object or physics-enabled imported asset to move it anywhere in 3D. The drag plane faces the camera, so pointer-right moves the object along the camera's right and pointer-up along the camera's up. Orbit to a top-down view to reposition on the floor, side view to lift, etc. While held, the body is kinematic — gravity is paused, so the object stays exactly where you put it.
  - **Press Alt / Option / Ctrl / Cmd mid-drag** to switch into **depth mode**: vertical cursor motion now brings the object closer (cursor up) or farther (cursor down) along the camera's gaze direction. Release the modifier to switch back to in-plane drag — the gesture re-anchors so there's no snap. On macOS, Alt and Option are the same key; we accept Ctrl and Cmd too so it doesn't matter which you reach for.
  - **Mouse wheel during drag** does the same closer/farther motion — useful when one hand is on the mouse and one isn't free for the keyboard.
  - When you release the mouse, the body switches back to dynamic. Velocity is zeroed first so it falls cleanly under gravity from rest instead of drifting. Drop it from any height to capture mid-fall.
  - Orbit/zoom keeps working without the Shift modifier.
- **USDZ asset import** — drop in `.usdz` files (Pixar Universal Scene Description). Powered by a full WASM build of OpenUSD with the **UsdSkel** schema plugins, so Apple's animated AR Quick Look samples (hummingbird, drummer, chameleon, …) play their baked skeletal animation as you record — not just static models. ASCII (`.usda`) and binary Crate (`.usdc`) payloads both work. Each imported asset gets per-instance scale / position / yaw / label controls, a play/pause toggle for animated stages, and an opt-in **Physics** toggle that wraps it in a Rapier RigidBody with a convex-hull collider — toggle it on and the asset falls under gravity, collides with the ground / belt / other bodies, and rides the conveyor like the spawned primitives. Bounding boxes are computed for the whole asset, not per child mesh.
- **Scene persists across reloads** — spawned primitives (with their per-object label / color / size / physics flag), conveyor + environment preset + virtual-camera settings, current mode, and every imported `.usdz` (with its position / scale / label / override material) come back exactly where you left them. Metadata lives in `localStorage`; the original `.usdz` bytes go in IndexedDB so they survive without re-importing. On startup the app re-runs the USDZ loader against the stored bytes to rebuild the live three.js scene. Removing an asset (or clearing the scene) wipes the matching IndexedDB entry; nothing is ever uploaded. API keys, in-memory captures, and the loaded EI model are *not* persisted.
- **Conveyor belt prop** — animated scrolling belt with rails, end rollers, and supports. **Actually transports spawned objects** along its length — drop a cube on it and it rides off the end. Speed-tunable from −2 m/s to +2 m/s (negative reverses direction). The belt collider extends below the visible surface and dynamic bodies have CCD enabled, so fast-falling objects don't tunnel through.
- **Virtual capture camera** — fully positionable (XYZ + target + FOV), with a frustum gizmo drawn into the scene so you can orbit around and see exactly what it sees.
- **Live capture preview** in the corner overlay, rendered with a HiDPI backing canvas so preview labels and inference overlays stay sharp on Retina displays.
- **Single-shot capture** — one button, one image saved.
- **Randomized batch capture** — capture *N* images while jittering camera position, light direction & intensity, and/or object positions/rotations between shots. Toggleable per axis. Each batch downloads as a single **zip file** (with the `bounding_boxes.labels` sidecar bundled in for detection mode), so you don't end up with N separate per-PNG download prompts.
- **Conveyor-aware batching** — when **Randomize Objects** is on AND the conveyor is on, randomized objects get dropped from above the belt and the batch waits for them to settle on the belt before each capture, so no image labels things mid-air.
- **Auto-projected bounding boxes** — for each labelled mesh in view, the 8 world-space AABB corners are projected to screen-space, clipped, and emitted as `{label, x, y, width, height}` in pixels.
- **File System Access API** — pick a directory once, all captures save directly into it. Falls back to per-file downloads in browsers without the API.
- **Edge Impulse `bounding_boxes.labels` sidecar** — write the file Edge Impulse expects when uploading pre-labelled detection data via the Studio.
- **Direct image upload** — multipart upload to `/api/{training,testing}/files` with bounding boxes attached via the `x-bounding-boxes` header.
- **One-click retrain after upload** — click **↻ Retrain model** from the upload card to start Edge Impulse Studio's retrain job for the selected project, reusing the last known DSP / learning block settings.

### Edge Impulse model inference (vision modes)
- **Fetch model from project** — paste your API key, click **🔑 List projects**, pick one, click **⤓ Fetch & load model**. The studio's WebAssembly deployment zip is downloaded, unpacked in-browser (`DecompressionStream` for DEFLATE), the `.js` + `.wasm` are extracted, and the model is initialized — all without leaving the page.
- **Or upload manually** — drop the `.js` + `.wasm` from a local EI WebAssembly deployment zip if you'd rather not paste an API key.
- **Retrain after adding data** — after uploading new captures, click **↻ Retrain model** to retrain the selected project's current impulse with the last known Studio settings. When retraining finishes, build a fresh WebAssembly deployment and fetch it again to update the in-browser model.
- **Live inference on the virtual-camera preview** — toggle ▶ Live for ~5 Hz continuous classification, or hit Run once for a single frame. Confidence threshold slider (5–95%) filters detections.
- **Bounding boxes (object detection / YOLO/MobileNet)** — drawn on top of the preview canvas with the class label and confidence; deeper colors per label, stable across frames.
- **FOMO centroid detection** — the same overlay treats small per-cell boxes as centroid dots, with a heavier dot in the middle of each cell.
- **Visual-anomaly heatmap** — `visual_ad_grid_cells` are rendered as translucent red overlays scaled to severity.

## Tech stack

| Layer | Library |
|---|---|
| Build | Vite + React 18 + TypeScript |
| 3D rendering | three.js + `@react-three/fiber` + `@react-three/drei` |
| Physics | Rapier (`@react-three/rapier`) |
| Hand tracking | `@mediapipe/tasks-vision` (HandLandmarker, GPU delegate) |
| USDZ import | `@needle-tools/usd` (OpenUSD WASM with UsdSkel — Crate + ASCII + skeletal animation) |
| EI model inference | Edge Impulse WebAssembly deployment (Embind) |
| ZIP read/write | Hand-rolled (STORE + DEFLATE via `DecompressionStream`) |
| State | Zustand |
| Disk saves | File System Access API (`showDirectoryPicker`) |
| Upload | Fetch + WebCrypto SubtleCrypto (for HMAC) |

## Quick start

Pick whichever fits:

### Option A — run the published package (no clone)

```bash
# Authenticate to GitHub Packages once (paste a personal access token with read:packages):
echo "//npm.pkg.github.com/:_authToken=YOUR_TOKEN" >> ~/.npmrc

# Then:
npx @yennster/synthetic-data-studio
```

Opens on http://localhost:5173 with COOP/COEP preconfigured. Add `--port 8080` to change port, `--no-coep` to disable cross-origin isolation (USDZ import will then fail but everything else works).

### Option B — download the release zip

Grab the latest `synthetic-data-studio-vX.Y.Z.zip` from [Releases](https://github.com/yennster/synthetic-data-studio/releases), unzip, and serve from any static host. The bundle includes a `_headers` file preconfigured for Netlify and Cloudflare Pages, and a `vercel.json` at the repo root for Vercel deployments — both wire up the cross-origin-isolation headers that the USDZ WASM loader needs.

### Option C — clone and run

```bash
git clone https://github.com/yennster/synthetic-data-studio
cd synthetic-data-studio
npm install
npm run dev
```

Open **http://localhost:5173** in a Chromium-based browser (Chrome, Edge, Brave). The File System Access API and MediaPipe both work best on Chromium; Safari/Firefox users will get per-file downloads instead of directory saves.

> **Camera permission is required for Motion mode.** Detection / Anomaly modes don't use the webcam and run anywhere.

## Workflows

### Recording motion data (manual)

1. Switch to **Motion** mode (default).
2. Pick the object kind in the Object card. Make sure **Webcam control** is on.
3. Show your hand to the camera. The pill in the top-left will read `Hand: tracked`.
4. **Pinch** (thumb + index together) to grab the object — it turns teal and follows your hand.
5. Move / shake / orient your hand. Release the pinch to drop or throw.
6. Click **● Record** before the gesture, **■ Stop** when done.
7. Paste your Edge Impulse API key, set a label, click **⤴ Upload**.
8. After uploading new samples, click **↻ Retrain model** from the upload card to start a Studio retrain job. Motion mode expects a project API key; if the key can access multiple projects, pick a project-specific key.

### Generating motion data procedurally (no webcam needed)

1. Switch to **Motion** mode and (optionally) turn **Webcam control** off so the camera light stays off.
2. Pick the object kind that matches the device you'd put a real IMU on (a soda can, phone slab, etc.).
3. In the **Procedural motions** card: pick a motion class (`drop`, `throw`, `push`, or `shake`), set the **count** (e.g. 50), and tweak **Drop height** range and **Per-drop ms** (record window per sample — 1500 ms covers free-fall + a few bounces).
4. Click **⚡ Generate & upload N samples** if an API key is set, or **⚡ Generate & download N samples** to save a local zip without signing in. The app:
   - Auto-disables hand tracking (so the camera and the script don't fight over the pinch target).
   - For each sample: lifts the object to a random `(x, y, z)` and orientation, performs the chosen motion (free-fall, throw, push, or shake), records the 6-channel IMU trace for the configured duration, and stores it as `{motion}_{i}.json`. The EI sample's `x-label` is set to the motion class so EI auto-classifies the data.
   - With an API key, each sample uploads to your project's `training` (or `testing`) bucket. Without an API key, the samples are bundled into one zip download.
   - Click **■ Stop** at any time to cancel — the runner unwinds at the next checkpoint and packages whatever finished.
   - After an uploaded batch, use **↻ Retrain model** in the upload card to retrain the project with the new samples.
   - Status updates after each sample; failures are tallied separately and don't stop the rest of the batch.

Run the generator once per class to build a balanced multi-class dataset (e.g. 50 `drop` + 50 `throw` + 50 `push` + 50 `shake`). The samples are independent in EI, so the model trains on the variation in initial pose, orientation, and trajectory — not on a single long take.

### Capturing object-detection data

1. Switch to **Object detection** mode.
2. Pick an **Environment** (Studio / Warehouse / White box / Outdoor) in the Scene card. (Optional) Toggle **Conveyor belt**.
3. Add objects from the **Objects** card — pick a kind, type a label, hit **+ Add**. Repeat for as many objects/classes as you need. Edit the label or **Size** inline, toggle **Physics** off if you want it pinned in place; remove with `×`.
3a. (Optional) Drop `.usdz` files into the **Import (.usdz)** card to bring in real assets. Each gets its own scale / position / yaw / label and an opt-in physics toggle.
4. Position the **Virtual camera** in the Virtual Camera card. The orange frustum gizmo updates live in the scene; the corner preview shows the captured framing — drag its bottom-right corner to enlarge.
5. Click **Choose directory…** and pick where the PNGs go (Chromium only). On Safari/Firefox they'll just download.
6. Click **📸 Capture frame** for one image, or set a batch count + randomization toggles and click **⚡ Batch (N)** — batches download as a single zip including `bounding_boxes.labels` for detection.
7. (Optional) Click **💾 Write bounding_boxes.labels** to save the sidecar JSON separately if you didn't run a batch.
8. Or upload directly: paste your API key and click **⤴ Upload N images**. Each image is sent with its bounding boxes.
9. After uploading new training data, click **↻ Retrain model** in the Upload card. If your API key can access multiple projects, pick the project in the Inference card first.

### Running an Edge Impulse model in-browser

After uploading some captures and training a YOLO / MobileNet / FOMO model in the Edge Impulse Studio:

1. In the studio: **Deployment → WebAssembly → Build**. (Build once; the studio caches the result.)
2. In the app, in the **Inference (Edge Impulse model)** card, click **🔑 List projects**. With your API key set, the app calls `/v1/api/projects` and shows a dropdown.
3. Pick the project, click **⤓ Fetch & load model**. The deployment zip is downloaded over HTTPS, unpacked in-browser, and the model is initialized.
4. Click **▶ Live** to run inference on the virtual-camera preview at ~5 Hz, or **Run once** for a single frame.
5. Bounding boxes and centroid dots appear over the virtual-camera preview. Adjust **Threshold** to filter weak detections.

Alternatively, unzip the WebAssembly deployment locally and upload `edge-impulse-standalone.js` + `edge-impulse-standalone.wasm` via the **From file** field — same result without the API call.

### Capturing visual-anomaly data

1. Switch to **Visual anomaly** mode.
2. Set up scene + camera the same way.
3. Type a batch label (e.g. `normal` or `anomaly`).
4. Capture frames or batches — each image gets the batch label. Bounding boxes are not attached.
5. Save to disk and/or upload to Edge Impulse.

## Edge Impulse setup

1. **Dashboard → Keys** in your Edge Impulse project.
2. Copy the **API key** (`ei_…`). For motion mode, optionally also copy the **HMAC key** for signed uploads.
3. Paste into the sidebar; choose **Training** or **Testing**.

### Payload formats

**Motion mode** (`/api/{training,testing}/data`):

```json
{
  "protected": { "ver": "v1", "alg": "none|HS256", "iat": 1717000000 },
  "signature": "<64-char hex>",
  "payload": {
    "device_name": "synthetic-hand-3d",
    "device_type": "WEB_SIMULATOR",
    "interval_ms": 10,
    "sensors": [
      { "name": "accX", "units": "m/s2" },
      { "name": "accY", "units": "m/s2" },
      { "name": "accZ", "units": "m/s2" },
      { "name": "gyrX", "units": "rad/s" },
      { "name": "gyrY", "units": "rad/s" },
      { "name": "gyrZ", "units": "rad/s" }
    ],
    "values": [[ax, ay, az, gx, gy, gz], ...]
  }
}
```

**Detection / Anomaly mode** (`/api/{training,testing}/files`, multipart):

- Form field `data` = the PNG blob
- Header `x-label` = label
- Header `x-bounding-boxes` (detection only) = `[{"label":"cube","x":120,"y":80,"width":56,"height":56}, ...]`

The `bounding_boxes.labels` sidecar (written via the **💾** button) follows the [Edge Impulse uploader format](https://docs.edgeimpulse.com/docs/edge-impulse-studio/data-acquisition/uploader#bounding-boxes):

```json
{
  "version": 1,
  "type": "bounding-box-labels",
  "boundingBoxes": {
    "frame.2026-05-06T11-00-00.0000.png": [
      { "label": "cube", "x": 120, "y": 80, "width": 56, "height": 56 }
    ]
  }
}
```

## Project structure

```
src/
├── App.tsx                       // Mode-aware layout, resizable preview wrapper
├── main.tsx                      // React entry
├── styles.css                    // Dark theme
├── components/
│   ├── Scene.tsx                 // r3f canvas, lighting, mode-aware scene tree
│   ├── SceneEnvironment.tsx      // Floor + walls + sky for each env preset
│   ├── CameraFeed.tsx            // Webcam + MediaPipe (motion mode)
│   ├── Hud.tsx                   // Top-left status pills
│   ├── Sidebar.tsx               // Mode switcher + panel router
│   ├── EiAuthCard.tsx            // Shared API-key / category card
│   ├── MotionPanel.tsx           // Motion-mode controls
│   ├── VisionPanel.tsx           // Detection / Anomaly controls
│   ├── Conveyor.tsx              // Animated conveyor belt prop (incl. wall colliders)
│   ├── SpawnedObjects.tsx        // Multi-object spawn renderer (physics on/off)
│   ├── ImportedAssets.tsx        // USDZ asset renderer with transforms + bbox tags
│   ├── VirtualCamera.tsx         // Capture camera, frustum gizmo, batch logic, live inference
│   └── InferenceOverlay.tsx      // HiDPI 2D bbox/centroid overlay on the preview canvas
├── lib/
│   ├── handTracking.ts           // HandLandmarker + pinch math
│   ├── usdz.ts                   // OpenUSD WASM loader wrapper, dispose helper
│   ├── beltDynamics.ts           // Shared belt geometry + transportable-bodies set
│   ├── dragMove.ts               // Shift+drag pointer-event handlers (XZ plane)
│   ├── capture.ts                // Off-screen render, bbox projection, FS Access
│   ├── edgeImpulse.ts            // Ingestion API + Studio API (list projects, fetch deployment)
│   ├── eiModel.ts                // EI WebAssembly model loader + classifier wrapper
│   ├── zip.ts                    // Minimal browser zip writer (STORE)
│   └── zipReader.ts              // Browser zip reader (STORE + DEFLATE via DecompressionStream)
└── store/
    └── useStore.ts               // Zustand store (single source of truth)
```

## USDZ import — what's supported

The app uses [`@needle-tools/usd`](https://www.npmjs.com/package/@needle-tools/usd), a WASM build of Pixar / Autodesk's OpenUSD with a three.js Hydra render delegate, and supports the formats most production tools emit:

- ✅ `.usdz` containing **ASCII USD** (`.usda`) — exported by Blender's "USD" exporter, Maya, Houdini.
- ✅ `.usdz` containing **binary Crate USD** (`.usdc`) — what NVIDIA Omniverse, Reality Composer, and Apple's tools produce by default. *This is what most modern `.usdz` files are.*
- ✅ **Animated USD with `UsdSkel` rigs** — Apple's animated AR Quick Look samples (hummingbird, drummer, chameleon, robot, etc.) play their baked skeletal animation in-browser. Each animated asset shows a play/pause toggle in the import panel.
- ⚠️ Plain `.usd`, `.usda`, `.usdc` files (not zipped) — convert to `.usdz` first (see below).

### Capturing real-world objects as USDZ

The **Capture from real life** card (in the Detection / Anomaly sidebar, above the **Import (.usdz)** card) routes you to Apple's [RealityKit Object Capture](https://developer.apple.com/documentation/realitykit/realitykit-object-capture) pipeline — the studio detects whether you're on iOS 17+ or macOS 12+ and tailors the instructions accordingly. Object Capture is native-only (no JavaScript API), so the workflow is:

1. **On iPhone (iOS 17+)**: install [RealityScan](https://apps.apple.com/us/app/realityscan-mobile/id1584832280) (Epic Games, free, built on Object Capture). Walk around the object taking ~50–200 overlapping photos under even lighting (avoid shiny / transparent / featureless surfaces). Export as `.usdz`.
2. **On Mac (macOS 12+)**: run Apple's [`HelloPhotogrammetry`](https://developer.apple.com/documentation/realitykit/creating-a-photogrammetry-command-line-app) command-line sample on a folder of photos to produce a USDZ headlessly.
3. AirDrop / copy the resulting `.usdz` over and drop it into the **Import (.usdz)** card. From there it has scale / position / yaw / label / physics controls just like any other imported asset.

### Converting `.usd` / `.usda` / `.usdc` to `.usdz`

If you have a non-zipped USD file, you can package it with the OpenUSD CLI tools:

```bash
# Install: pip install usd-core
usdzip my_scene.usdz my_scene.usda
```

Or in Blender: **File → Export → Universal Scene Description (.usd)**, then choose `.usdz` as the extension.

Or via NVIDIA Omniverse: **File → Save As → .usdz**.

### Asset shows up flat magenta / pink

That's three.js's "no material bound" placeholder. The most common cause is **Omniverse MDL materials**: if the asset was authored in Omniverse and exported with its native MDL material network, the OpenUSD WASM runtime in the browser can't translate those materials into three.js's PBR pipeline and falls back to magenta.

Fixes, in order of effort:

1. **Tick "Override material" on the asset row.** This swaps every mesh in the imported subtree to a plain MeshStandardMaterial with a color/roughness/metalness you choose. You lose the original textures but the geometry is usable (and the bounding-box projection still works).
2. **Re-export from Omniverse using USD Preview Surface materials** instead of MDL. In Omniverse, this usually means converting MDL → UsdPreviewSurface before saving, or selecting "USD Preview Surface" as the export shader.
3. **In Blender**, just re-import the USD and re-export — Blender's USD exporter writes UsdPreviewSurface materials by default, which the WASM loader handles.

### Texture missing entirely

`usdzip` zips a `.usd` / `.usda` file together with referenced textures into a `.usdz`. If the original USD references a texture by **absolute path** or by a path that doesn't exist on disk at zip time, the texture won't be in the archive. Check by unzipping the `.usdz` (it's a regular zip): `unzip -l my_scene.usdz`. Re-export with relative texture paths or use the Override material toggle.

### Omniverse scene templates / room-scale USD references

NVIDIA's Omniverse scene templates (and most production USD layouts) heavily use **`References`** — the top-level `.usd` is a thin layout that points at separate `.usd` files for each prop / wall / fixture. `usdzip` does **not** chase those references by default, so you end up with a `.usdz` containing only the layout and missing all the geometry — which renders as nothing, or as the magenta placeholder if the layout itself has any prims.

The fix is to **flatten** the scene before zipping. Run from a shell with the OpenUSD CLI tools installed (`pip install usd-core` is enough):

```bash
usdcat --flatten room.usd --out room_flat.usda
usdzip room.usdz room_flat.usda
```

`usdcat --flatten` resolves all `References` / `Payloads` / `SubLayers` and writes a single self-contained `.usda` with everything inlined. Then `usdzip` packages that one file plus its textures.

**Caveat**: even after flattening, Omniverse scenes typically use **MDL materials**, which the OpenUSD WASM runtime can't translate. After import, the studio auto-enables the **Override material** toggle for assets where >50% of meshes are placeholder-shaded — flip it on yourself if it didn't trigger and pick a colour. The geometry will still be correct (you can see the room outlines, train detection on its layout, etc.) — just unshaded.

**Another option**: open the Omniverse asset in Blender (4.0+ has a USD importer), let Blender translate MDL → Principled BSDF → UsdPreviewSurface on export, and use Blender's USD exporter directly. The output works without flattening or material overrides.

### Import diagnostics

After every import the status bar shows what was loaded:

```
Imported room_flat.usdz: 142 meshes · 2,815,432 tris · 9.83m max · 142/142 default-material (override auto-enabled)
```

That tells you how much geometry came in, how big the asset is, and whether materials translated. If `default-material` is 0, you're getting real PBR shading.

### Cross-origin isolation requirement

The OpenUSD WASM uses `SharedArrayBuffer`, which requires the page to be served with **cross-origin isolation** headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

The Vite dev server is preconfigured to send these. If you self-host the production build, your static host needs to send them too:

- **Netlify / Cloudflare Pages** — pick up the `_headers` file shipped in the build output automatically.
- **Vercel** — uses the `vercel.json` at the repo root. The committed copy already maps both headers to every path. (Note: Vercel does **not** read `_headers`, so the `_headers` file alone won't work there.)
- **Other static hosts (Caddy, nginx, S3+CloudFront)** — set the two headers via your host's config.

## How the IMU signal is computed

A real IMU has two sensors: an accelerometer and a gyroscope. We emit both per tick.

**Accelerometer** measures **proper acceleration** — what you feel relative to free-fall, *not* coordinate acceleration:

```
a_proper = a_inertial − g_world
```

where `g_world = (0, −9.81, 0)`.

Per sampling tick: read Rapier `linvel` → numerically differentiate → subtract gravity → rotate into the body's local frame using the inverse orientation quaternion → push to buffer.

So: stationary object reads `(0, +9.81, 0)` (ground pushes up against gravity), freefall reads `(0, 0, 0)`, hand-driven shake gives a realistic IMU waveform.

**Gyroscope** measures **angular velocity** in the sensor's own body frame, in rad/s. Rapier reports `body.angvel()` in world space; we rotate it by the body's inverse orientation quaternion (the same `qInv` used for the accelerometer transform) to land in body coordinates. So: stationary object reads `(0, 0, 0)`, a body spinning around its own up-axis at 90°/s reads `(0, ~1.57, 0)`, etc.

Both sensors share the same per-sample timestamp so EI's signal-processing blocks can do windowed feature extraction (DSP, spectral analysis) across all 6 channels.

## How bounding boxes are computed

For each mesh tagged with `userData.label`:

1. Compute (or read cached) **local-space AABB** from `geometry.boundingBox`.
2. Transform all 8 corners by `mesh.matrixWorld` → world space.
3. Project each corner with the capture camera (`vector.project(camera)`) → NDC.
4. Discard corners behind the near plane.
5. Convert NDC → pixel coordinates with the capture resolution; track min/max x and y.
6. Clip to the image rectangle, drop boxes < 4×4 px (degenerate / fully occluded).

Result: tight axis-aligned 2D boxes in pixel coordinates with top-left origin — exactly what Edge Impulse expects.

## Tuning

| What | Where | Default |
|---|---|---|
| Pinch-on / pinch-off thresholds | `CameraFeed.tsx` | 0.65 / 0.45 |
| Kinematic follow smoothing | `Scene.tsx` `FOLLOW_LERP` | 0.35 |
| Restitution (bounciness) | `Scene.tsx` `RigidBody` | 0.45 |
| Friction | `Scene.tsx` `Ground` | 0.8 |
| Sample rate | UI / `useStore.ts` | 100 Hz |
| Capture resolution | UI | 640 × 480 |
| Camera-jitter radius (batch) | `VirtualCamera.tsx` `r` | 0.6 m |
| Light-intensity jitter range | `VirtualCamera.tsx` | ±0.8 |
| Conveyor belt size | `beltDynamics.ts` | 1.6 × 8 m |
| Conveyor sideways-damping factor | `Conveyor.tsx` `lv.x * 0.4` | 0.4 |

## Privacy notes

- The webcam stream **never leaves the browser** in any mode. MediaPipe runs locally; only data you explicitly capture/upload is sent anywhere.
- API keys are kept in JavaScript memory only — not in `localStorage`, `sessionStorage`, cookies, or any file. Reload = wiped.
- Image saves go to your local disk (or downloads); only Edge Impulse uploads leave the machine, over HTTPS to `ingestion.edgeimpulse.com`.
- **Scene state is persisted locally** so it survives reloads — spawned primitives, conveyor / environment / capture settings, current mode, and any imported `.usdz` files (metadata in `localStorage`, the original USDZ bytes in IndexedDB). Nothing is uploaded; this is per-browser, per-origin storage on your own machine. Clear it via your browser's site-data settings, by removing each asset from the UI, or with the **Clear** controls in the Scene / Imported assets cards.
- Captures (rendered images and IMU samples) are **not** persisted — they live in memory until you save or upload them.
- Because the local persistence above is strictly to deliver functionality you explicitly requested (importing assets, building a scene), it falls under the ePrivacy Directive's "strictly necessary" exemption — no consent banner is required. Not legal advice; verify for your jurisdiction.

## Troubleshooting

**Camera permission denied** (motion mode) — Allow camera in your browser's site settings, then reload.

**Directory picker doesn't appear** — Use Chrome / Edge / Brave. Safari/Firefox don't yet support `showDirectoryPicker`; you'll get per-file downloads.

**Bounding boxes look wrong** — Make sure the object is fully on-screen in the virtual camera preview. Boxes are clipped at image edges, and very small / occluded objects are dropped.

**USDZ import: "module could not initialize"** — the page isn't cross-origin-isolated. Check that your static host is sending `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`. The dev server already does. **Vercel users**: make sure `vercel.json` is at the repo root (not just `_headers` in `public/` — Vercel doesn't read that file). You can verify with `curl -I https://your-deployment.vercel.app/` and look for both headers in the response.

**USDZ import: file imported but invisible** — the asset may have been auto-scaled too small; drag the **Scale** slider in its row, or check the **Y** position (e.g. lift it onto the belt at `y = 0.1`).

**Edge Impulse 401 / 403** — API key missing or invalid. Double-check **Dashboard → Keys** in your project.

**Edge Impulse "invalid signature"** (motion only) — Either fill in the HMAC key from your project, or leave it blank to send unsigned (`alg: "none"`). HMAC is **only** for the JSON data-acquisition format used by motion uploads; image / file uploads (vision modes) authenticate with the API key alone, so there's no HMAC field there.

**"No WebAssembly deployment built yet"** when fetching a model — go to the Edge Impulse Studio: **Deployment → WebAssembly → Build**. Once the build completes the studio caches it and the app's Fetch & load button will work.

**Retrain says "Pick a project"** — click **🔑 List projects** in the Inference card and select the Edge Impulse project you uploaded to. If your API key only has one accessible project, the app can auto-select it for retraining.

**Model load hangs at `onRuntimeInitialized`** — use `edge-impulse-standalone.js` plus the matching `.wasm` from the WebAssembly deployment. The loader supports both MODULARIZE browser builds and newer non-MODULARIZE Emscripten outputs, but Node-only wrappers such as `run-impulse.js`, `run-classifier.js`, or `index.js` cannot run in the browser.

**Model loaded but `bounding_boxes` is empty** — your model probably isn't an object-detection model. Classification heads return `classification` only; for boxes you need a YOLO/MobileNet object detector or a FOMO model. Check the line `… · obj-det` in the loaded-model summary.

## Testing

```bash
npm test               # one-shot run (CI mode)
npm run test:watch     # interactive watch mode
npm run test:coverage  # with v8 coverage report
```

Stack: **Vitest** + **happy-dom** for the DOM-touching tests. Pure-logic libraries (`handMath`, `beltDynamics`, `capture` helpers, `edgeImpulse` payload + HMAC, store transitions) are covered. The MediaPipe / OpenUSD / Rapier wrappers are stubbed in test config since they're browser-runtime-only — those are exercised in the headless screenshot script and end-to-end manual testing.

A GitHub Actions workflow ([`.github/workflows/test.yml`](.github/workflows/test.yml)) runs `tsc --noEmit` + `npm test` on every push to `main` and every PR.

## Build for production

```bash
npm run build
npm run preview
```

The output in `dist/` is a static bundle — host on any static host. All processing is client-side.

## Regenerating screenshots

```bash
npm run dev          # in one terminal
npm run screenshot detection   # writes docs/screenshot-detection.png
npm run screenshot motion      # writes docs/screenshot-motion.png
```

Requires Google Chrome installed at the standard macOS path; override with `CHROME_PATH=/path/to/chrome`.

## License

[Apache-2.0](LICENSE) — permissive open source. You can use, modify, and redistribute this code commercially, including as a service, provided you keep the copyright notice and `NOTICE` file (if any). Includes an explicit patent grant.

Note: this project depends on [`@needle-tools/usd`](https://www.npmjs.com/package/@needle-tools/usd) for USDZ rendering, which is **not** Apache-licensed and asks you to contact `hi@needle.tools` for commercial use of *that* package. That obligation is between you and Needle and does not affect the Apache-2.0 grant on the code in this repository.
