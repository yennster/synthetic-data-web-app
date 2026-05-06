# Synthetic Data Studio

A browser-based 3D tool for generating synthetic training data for [Edge Impulse](https://www.edgeimpulse.com/) projects. Three modes in one app:

- **Motion** — Manipulate a virtual object with hand-tracked pinch gestures via your webcam, capture realistic 3-axis accelerometer data, and upload to Edge Impulse.
- **Object detection** — Drop objects (cube, sphere, cylinder, cone, torus, capsule, phone slab) into the scene, optionally onto a conveyor belt, point a virtual camera at them, capture single shots or randomized batches with bounding boxes auto-projected, save to a local directory, and upload as a labelled image dataset.
- **Visual anomaly detection** — Same capture pipeline as detection, but emits unlabelled images with a single batch-level label (e.g. `normal` / `anomaly`).

Created with Claude Code.

![Synthetic Data Studio · Object Detection mode](docs/screenshot-detection.png)

*Object detection mode: 6 labelled objects on a scrolling conveyor belt, virtual capture camera shown as the orange frustum gizmo, live preview in the bottom-left corner.*

![Synthetic Data Studio · Motion mode](docs/screenshot-motion.png)

*Motion mode: pinch the cube with your hand to grab it, throw it onto the ground, record the accelerometer trace.*

## Features

### Shared
- **Realistic 3D scene** — HDRI environment lighting (`warehouse` preset), ACES Filmic tone mapping, soft shadows, contact shadows, infinite ground grid.
- **Live HUD** with mode-aware status pills.
- **Direct Edge Impulse upload** via the [Ingestion API](https://docs.edgeimpulse.com/reference/data-ingestion/ingestion-api).
- **API key never persisted** — held in memory for the session only.

### Motion mode
- **Hand tracking** via Google MediaPipe `HandLandmarker` (in-browser, GPU/WASM, ~60 fps).
- **Pinch-to-grab** with thumb–index distance, hysteresis-filtered.
- **Throw / drop physics** — released objects inherit your hand's velocity.
- **Proper-acceleration math** — emits the signal a real IMU would (`+9.81 m/s²` up when stationary, near-zero in freefall), transformed into the object's local body frame.
- **Configurable sample rate** (20–500 Hz, default 100 Hz).
- HMAC-SHA256 signed uploads optional.

### Object detection / Visual anomaly mode
- **Multi-object spawning** — add any number of objects to the scene with custom labels and colors. Each new object's label auto-tracks the kind dropdown (pick "sphere" → label defaults to `sphere`), so you don't end up with five things all labelled "cube". Objects fall under physics onto the ground or conveyor.
- **Shift+drag to move** — hold Shift and click+drag any spawned object or physics-enabled imported asset to move it anywhere in 3D. The drag plane faces the camera, so pointer-right always moves the object along the camera's right and pointer-up along the camera's up. Orbit to a top-down view to reposition on the floor, side view to lift, etc.
  - **Shift+Alt+drag** locks motion to world Y (lift / drop) — handy for touchpad users who don't want to fight with wheel events.
  - **Mouse wheel during drag** pushes/pulls along the camera's gaze direction (mouse-only — touchpad users use Alt instead).
  - Velocity is zeroed at the start of each drag so released objects fall cleanly under gravity instead of drifting. Release the mouse mid-air and physics resumes from rest at whatever height.
  - Orbit/zoom keeps working without the Shift modifier.
- **USDZ asset import** — drop in `.usdz` files (Pixar Universal Scene Description). Powered by a WASM build of OpenUSD, supporting both ASCII (`.usda`) and binary Crate (`.usdc`) payloads. Each imported asset gets per-instance scale / position / yaw / label controls and an opt-in **Physics** toggle that wraps it in a Rapier RigidBody with a convex-hull collider — toggle it on and the asset falls under gravity, collides with the ground / belt / other bodies, and rides the conveyor like the spawned primitives. Bounding boxes are computed for the whole asset, not per child mesh.
- **Conveyor belt prop** — animated scrolling belt with rails, end rollers, and supports. **Actually transports spawned objects** along its length — drop a cube on it and it rides off the end. Speed-tunable from −2 m/s to +2 m/s (negative reverses direction). The belt collider extends below the visible surface and dynamic bodies have CCD enabled, so fast-falling objects don't tunnel through.
- **Virtual capture camera** — fully positionable (XYZ + target + FOV), with a frustum gizmo drawn into the scene so you can orbit around and see exactly what it sees.
- **Live capture preview** in the corner overlay.
- **Single-shot capture** — one button, one image saved.
- **Randomized batch capture** — capture *N* images while jittering camera position, light direction & intensity, and/or object positions/rotations between shots. Toggleable per axis.
- **Auto-projected bounding boxes** — for each labelled mesh in view, the 8 world-space AABB corners are projected to screen-space, clipped, and emitted as `{label, x, y, width, height}` in pixels.
- **File System Access API** — pick a directory once, all captures save directly into it. Falls back to per-file downloads in browsers without the API.
- **Edge Impulse `bounding_boxes.labels` sidecar** — write the file Edge Impulse expects when uploading pre-labelled detection data via the Studio.
- **Direct image upload** — multipart upload to `/api/{training,testing}/files` with bounding boxes attached via the `x-bounding-boxes` header.

## Tech stack

| Layer | Library |
|---|---|
| Build | Vite + React 18 + TypeScript |
| 3D rendering | three.js + `@react-three/fiber` + `@react-three/drei` |
| Physics | Rapier (`@react-three/rapier`) |
| Hand tracking | `@mediapipe/tasks-vision` (HandLandmarker, GPU delegate) |
| USDZ import | `three-usdz-loader` (OpenUSD WASM, supports Crate + ASCII) |
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
npx @yennster/synthetic-data-web-app
```

Opens on http://localhost:5173 with COOP/COEP preconfigured. Add `--port 8080` to change port, `--no-coep` to disable cross-origin isolation (USDZ import will then fail but everything else works).

### Option B — download the release zip

Grab the latest `synthetic-data-web-app-vX.Y.Z.zip` from [Releases](https://github.com/yennster/synthetic-data-web-app/releases), unzip, and serve from any static host. The bundle includes a `_headers` file preconfigured for Netlify and Cloudflare Pages.

### Option C — clone and run

```bash
git clone https://github.com/yennster/synthetic-data-web-app
cd synthetic-data-web-app
npm install
npm run dev
```

Open **http://localhost:5173** in a Chromium-based browser (Chrome, Edge, Brave). The File System Access API and MediaPipe both work best on Chromium; Safari/Firefox users will get per-file downloads instead of directory saves.

> **Camera permission is required for Motion mode.** Detection / Anomaly modes don't use the webcam and run anywhere.

## Workflows

### Recording motion data

1. Switch to **Motion** mode (default).
2. Show your hand to the camera. The pill in the top-left will read `Hand: tracked`.
3. **Pinch** (thumb + index together) to grab the object — it turns teal and follows your hand.
4. Move / shake / orient your hand. Release the pinch to drop or throw.
5. Click **● Record** before the gesture, **■ Stop** when done.
6. Paste your Edge Impulse API key, set a label, click **⤴ Upload**.

### Capturing object-detection data

1. Switch to **Object detection** mode.
2. (Optional) Toggle **Conveyor belt** in the Scene card.
3. Add objects from the **Objects** card — pick a kind, type a label, hit **+ Add**. Repeat for as many objects/classes as you need. Edit the label of any object inline; remove with `×`.
3a. (Optional) Drop `.usdz` files into the **Import (.usdz)** card to bring in real assets. Each gets its own scale / position / yaw / label.
4. Position the **Virtual camera** in the Virtual Camera card. The orange frustum gizmo updates live in the scene; the corner preview shows the captured framing.
5. Click **Choose directory…** and pick where the PNGs go (Chromium only). On Safari/Firefox they'll just download.
6. Click **📸 Capture frame** for one image, or set a batch count + randomization toggles and click **⚡ Capture batch (N)**.
7. (Optional) Click **💾 Write bounding_boxes.labels** to save the Edge Impulse sidecar JSON alongside your images — you can then drag the whole folder into the Edge Impulse Studio uploader.
8. Or upload directly: paste your API key and click **⤴ Upload N images**. Each image is sent with its bounding boxes.

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
      { "name": "accZ", "units": "m/s2" }
    ],
    "values": [[ax, ay, az], ...]
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
├── App.tsx                       // Mode-aware layout
├── main.tsx                      // React entry
├── styles.css                    // Dark theme
├── components/
│   ├── Scene.tsx                 // r3f canvas, lighting, mode-aware scene tree
│   ├── CameraFeed.tsx            // Webcam + MediaPipe (motion mode)
│   ├── Hud.tsx                   // Top-left status pills
│   ├── Sidebar.tsx               // Mode switcher + panel router
│   ├── MotionPanel.tsx           // Motion-mode controls
│   ├── VisionPanel.tsx           // Detection / Anomaly controls
│   ├── Conveyor.tsx              // Animated conveyor belt prop
│   ├── SpawnedObjects.tsx        // Multi-object spawn renderer
│   ├── ImportedAssets.tsx        // USDZ asset renderer with transforms + bbox tags
│   └── VirtualCamera.tsx         // Capture camera, frustum gizmo, batch logic
├── lib/
│   ├── handTracking.ts           // HandLandmarker + pinch math
│   ├── usdz.ts                   // OpenUSD WASM loader wrapper, dispose helper
│   ├── beltDynamics.ts           // Shared belt geometry + transportable-bodies set
│   ├── dragMove.ts               // Shift+drag pointer-event handlers (XZ plane)
│   ├── capture.ts                // Off-screen render, bbox projection, FS Access
│   └── edgeImpulse.ts            // Ingestion API: motion + image+bbox uploads
└── store/
    └── useStore.ts               // Zustand store (single source of truth)
```

## USDZ import — what's supported

The app uses `three-usdz-loader`, which bundles a WASM build of Pixar / NVIDIA's OpenUSD and supports the formats most production tools emit:

- ✅ `.usdz` containing **ASCII USD** (`.usda`) — exported by Blender's "USD" exporter, Maya, Houdini.
- ✅ `.usdz` containing **binary Crate USD** (`.usdc`) — what NVIDIA Omniverse, Reality Composer, and Apple's tools produce by default. *This is what most modern `.usdz` files are.*
- ⚠️ Plain `.usd`, `.usda`, `.usdc` files (not zipped) — convert to `.usdz` first (see below).

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

The Vite dev server is preconfigured to send these. If you self-host the production build, your static host needs to send them too — Netlify, Vercel, and Cloudflare Pages all support this via headers config.

## How the accelerometer signal is computed

A real IMU measures **proper acceleration** — what you feel relative to free-fall, *not* coordinate acceleration:

```
a_proper = a_inertial − g_world
```

where `g_world = (0, −9.81, 0)`.

Per sampling tick: read Rapier `linvel` → numerically differentiate → subtract gravity → rotate into the body's local frame using the inverse orientation quaternion → push to buffer.

So: stationary object reads `(0, +9.81, 0)` (ground pushes up against gravity), freefall reads `(0, 0, 0)`, hand-driven shake gives a realistic IMU waveform.

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

## Troubleshooting

**Camera permission denied** (motion mode) — Allow camera in your browser's site settings, then reload.

**Directory picker doesn't appear** — Use Chrome / Edge / Brave. Safari/Firefox don't yet support `showDirectoryPicker`; you'll get per-file downloads.

**Bounding boxes look wrong** — Make sure the object is fully on-screen in the virtual camera preview. Boxes are clipped at image edges, and very small / occluded objects are dropped.

**USDZ import: "module could not initialize"** — the page isn't cross-origin-isolated. Check that your static host is sending `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`. The dev server already does.

**USDZ import: file imported but invisible** — the asset may have been auto-scaled too small; drag the **Scale** slider in its row, or check the **Y** position (e.g. lift it onto the belt at `y = 0.1`).

**Edge Impulse 401 / 403** — API key missing or invalid. Double-check **Dashboard → Keys** in your project.

**Edge Impulse "invalid signature"** (motion only) — Either fill in the HMAC key from your project, or leave it blank to send unsigned (`alg: "none"`).

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

MIT
