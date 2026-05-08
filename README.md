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

- **Motion** — pinch a virtual object with hand-tracked gestures (or use the procedural generator with no webcam) and capture realistic 6-channel IMU data (3-axis accel + 3-axis gyro, body-local).
- **Object detection** — drop labelled objects into a 3D scene (4 environment presets, optional conveyor belt, USDZ import), point a virtual camera, capture single shots or randomized batches with auto-projected bounding boxes.
- **Visual anomaly detection** — same capture pipeline as detection, batch-labelled (`normal` / `anomaly`).

Run trained Edge Impulse YOLO / MobileNet / FOMO models **directly in-browser** for live inference on the virtual-camera preview.

Created with Claude Code.

![Synthetic Data Studio · Object Detection mode](docs/screenshot-detection.png)

*Object detection mode: 6 labelled objects on a scrolling conveyor belt, virtual capture camera shown as the orange frustum gizmo, live preview in the bottom-left corner.*

![Synthetic Data Studio · Motion mode](docs/screenshot-motion.png)

*Motion mode: pinch the cube with your hand to grab it, throw it onto the ground, record the accelerometer trace.*

## Features

**Shared**
- HDRI-lit 3D scene with ACES tone mapping, contact shadows.
- Light / dark theme toggle (defaults to dark; persists; URL-overridable).
- Live HUD with mode-aware status pills.
- Direct upload to the [Edge Impulse Ingestion API](https://docs.edgeimpulse.com/reference/data-ingestion/ingestion-api).
- API keys held in memory only — never persisted.
- Auto-attached EI metadata on every sample (page URL, mode, scene contents, capture timestamp). [More →](docs/internals.md#auto-attached-ei-metadata)

**Motion mode**
- Hand tracking (Google MediaPipe `HandLandmarker`, in-browser, ~60 fps); toggle off for cameraless work.
- Pinch-to-grab + rotate; release inherits hand velocity for throws.
- 6-channel IMU output (`accX/Y/Z` m/s² + `gyrX/Y/Z` rad/s, body frame).
- 8 object kinds (cube, sphere, cylinder, cone, torus, capsule, phone, soda can).
- **Procedural motion generator** — pick `drop` / `throw` / `push` / `shake`, set count, height range, and per-sample duration; auto-runs through the batch. Upload directly or download as a zip.
- Configurable sample rate (20–500 Hz, default 100). Optional HMAC-SHA256 signed uploads.

**Object detection / Visual anomaly mode**
- 4 environment presets (Studio / Warehouse / White box / Outdoor) plus per-slot custom textures (Floor / Wall / Object) stored in IndexedDB.
- Multi-object spawning with custom labels, colors, sizes, and per-object physics on/off.
- Shift+drag to position objects; Alt/Option/Ctrl/Cmd mid-drag for depth mode; mouse wheel during drag for push/pull.
- USDZ import (Crate + ASCII + UsdSkel animation). [More →](docs/usdz.md)
- Conveyor belt that actually transports spawned bodies (speed-tunable −2 to +2 m/s).
- Virtual capture camera (XYZ + target + FOV) with frustum gizmo.
- Single-shot capture downloads as a zip with the PNG + matching `bounding_boxes.labels` sidecar; batch capture randomizes camera / lighting / object positions and zips the whole batch.
- Direct upload to EI with bounding boxes attached; one-click retrain.
- Scene state persists across reloads (primitives, USDZ assets, camera settings).

**Edge Impulse model inference (vision modes)**
- Fetch a built WebAssembly deployment straight from your project, or upload `.js` + `.wasm` manually.
- Live inference at ~5 Hz on the virtual-camera preview; bounding boxes / FOMO centroids / visual-anomaly heatmap.

## Tech stack

| Layer | Library |
|---|---|
| Build | Vite + React 18 + TypeScript |
| 3D rendering | three.js + `@react-three/fiber` + `@react-three/drei` |
| Physics | Rapier (`@react-three/rapier`) |
| Hand tracking | `@mediapipe/tasks-vision` (HandLandmarker, GPU delegate) |
| USDZ import | `@needle-tools/usd` (OpenUSD WASM with UsdSkel) |
| EI model inference | Edge Impulse WebAssembly deployment (Embind) |
| ZIP read/write | Hand-rolled (STORE + DEFLATE via `DecompressionStream`) |
| State | Zustand |
| Upload | Fetch + WebCrypto SubtleCrypto (HMAC) |

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

Open **http://localhost:5173** in a Chromium-based browser (Chrome, Edge, Brave).

> **Camera permission is required for Motion mode.** Detection / Anomaly modes don't use the webcam and run anywhere.

## Workflows

Step-by-step instructions for each mode are in **[docs/workflows.md](docs/workflows.md)**:

- [Recording motion data (manual)](docs/workflows.md#recording-motion-data-manual)
- [Generating motion data procedurally](docs/workflows.md#generating-motion-data-procedurally-no-webcam-needed)
- [Capturing object-detection data](docs/workflows.md#capturing-object-detection-data)
- [Running an Edge Impulse model in-browser](docs/workflows.md#running-an-edge-impulse-model-in-browser)
- [Capturing visual-anomaly data](docs/workflows.md#capturing-visual-anomaly-data)

## Edge Impulse setup

1. **Dashboard → Keys** in your Edge Impulse project.
2. Copy the **API key** (`ei_…`). For motion mode, optionally also copy the **HMAC key** for signed uploads.
3. Paste into the sidebar; choose **Training** or **Testing**.

For the exact JSON / multipart payloads sent to the ingestion API, see [docs/internals.md#edge-impulse-payload-formats](docs/internals.md#edge-impulse-payload-formats).

## URL parameters

The app reads a few query parameters at load so you can deep-link a configured studio (especially handy when embedding in an iframe):

| Param      | Values                                                  | Effect                                                                 |
| ---------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `apiKey`   | An `ei_…` key                                           | Pre-fills the Edge Impulse API key.                                    |
| `category` | `training`, `testing`, `split` (also `train`, `test`)   | Pre-selects the upload bucket dropdown. `split` routes 80/20 per sample. |
| `theme`    | `dark`, `light`                                         | Forces the chrome theme on this load. Overrides the persisted choice for the session, then is itself persisted, so a later toggle still works. |

Examples:

```
https://your-host/?theme=light
https://your-host/?apiKey=ei_abc123&category=testing
https://your-host/?theme=dark&category=split
```

Unknown values are ignored — the app falls back to whatever was stored or the built-in default (dark theme, training bucket). The values are case-insensitive.

## Privacy notes

- The webcam stream **never leaves the browser** in any mode. MediaPipe runs locally; only data you explicitly capture/upload is sent anywhere.
- API keys are kept in JavaScript memory only — not in `localStorage`, `sessionStorage`, cookies, or any file. Reload = wiped.
- Image saves go to your local disk (or downloads); only Edge Impulse uploads leave the machine, over HTTPS to `ingestion.edgeimpulse.com`.
- **Scene state is persisted locally** so it survives reloads — spawned primitives, conveyor / environment / capture settings, current mode, theme preference, and any imported `.usdz` files (metadata in `localStorage`, the original USDZ bytes in IndexedDB). Nothing is uploaded; this is per-browser, per-origin storage on your own machine. Clear it via your browser's site-data settings, by removing each asset from the UI, or with the **Clear** controls in the Scene / Imported assets cards.
- Captures (rendered images and IMU samples) are **not** persisted — they live in memory until you save or upload them.
- Because the local persistence above is strictly to deliver functionality you explicitly requested (importing assets, building a scene), it falls under the ePrivacy Directive's "strictly necessary" exemption — no consent banner is required. Not legal advice; verify for your jurisdiction.

## More docs

- **[docs/workflows.md](docs/workflows.md)** — step-by-step instructions for every mode.
- **[docs/usdz.md](docs/usdz.md)** — USDZ import: what's supported, capturing real-world objects, format conversion, MDL/Omniverse caveats, cross-origin isolation setup.
- **[docs/internals.md](docs/internals.md)** — project structure, IMU math, bbox projection, tunables, EI payload formats.
- **[docs/troubleshooting.md](docs/troubleshooting.md)** — common errors and fixes.

## Testing

```bash
npm test               # one-shot run (CI mode)
npm run test:watch     # interactive watch mode
npm run test:coverage  # with v8 coverage report
```

Stack: **Vitest** + **happy-dom**. Pure-logic libraries (`handMath`, `beltDynamics`, `capture` helpers, `edgeImpulse` payload + HMAC, store transitions, theme state, zip read/write, URL-param parsing) are covered. The MediaPipe / OpenUSD / Rapier wrappers are stubbed in test config since they're browser-runtime-only — those are exercised in the headless screenshot script and end-to-end manual testing.

A GitHub Actions workflow ([`.github/workflows/test.yml`](.github/workflows/test.yml)) runs `tsc --noEmit` + `npm test` on every push to `main` and every PR.

## Build for production

```bash
npm run build
npm run preview
```

The output in `dist/` is a static bundle — host on any static host. All processing is client-side.

Regenerate screenshots with `npm run screenshot detection` / `motion` (requires Chrome at the standard macOS path; override with `CHROME_PATH=…`).

## License

[Apache-2.0](LICENSE) — permissive open source. You can use, modify, and redistribute this code commercially, including as a service, provided you keep the copyright notice and `NOTICE` file (if any). Includes an explicit patent grant.

Note: this project depends on [`@needle-tools/usd`](https://www.npmjs.com/package/@needle-tools/usd) for USDZ rendering, which is **not** Apache-licensed and asks you to contact `hi@needle.tools` for commercial use of *that* package. That obligation is between you and Needle and does not affect the Apache-2.0 grant on the code in this repository.
