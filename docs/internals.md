# Internals

Architecture, math, and tunables for people poking at the code.

## Project structure

```
src/
├── App.tsx                       // Mode-aware layout, resizable preview wrapper
├── main.tsx                      // React entry; reads URL params; applies theme
├── styles.css                    // Token-driven dark + light themes
├── components/
│   ├── Scene.tsx                 // r3f canvas, lighting, mode-aware scene tree
│   ├── SceneEnvironment.tsx      // Floor + walls + sky for each env preset
│   ├── CameraFeed.tsx            // Webcam + MediaPipe (motion mode)
│   ├── Hud.tsx                   // Top-left status pills
│   ├── Sidebar.tsx               // Mode switcher + panel router
│   ├── ThemeToggle.tsx           // Sun/moon button (light/dark theme)
│   ├── EiAuthCard.tsx            // Shared API-key / category card
│   ├── MotionPanel.tsx           // Motion-mode controls
│   ├── VisionPanel.tsx           // Detection / Anomaly controls
│   ├── RobotPanel.tsx            // Robotics-mode controls
│   ├── Conveyor.tsx              // Animated conveyor belt prop (incl. wall colliders)
│   ├── SpawnedObjects.tsx        // Multi-object spawn renderer (physics on/off)
│   ├── ImportedAssets.tsx        // USDZ asset renderer with transforms + bbox tags
│   ├── Rover.tsx                 // Rover rig + lidar fan + IMU sampler
│   ├── BraccioArm.tsx            // Braccio rig + IK controller + IMU sampler
│   ├── RobotPovCamera.tsx        // First-person preview overlay (rover/arm)
│   ├── VirtualCamera.tsx         // Capture camera, frustum gizmo, batch logic, live inference
│   └── InferenceOverlay.tsx      // HiDPI 2D bbox/centroid overlay on the preview canvas
├── lib/
│   ├── handTracking.ts           // HandLandmarker + pinch math
│   ├── usdz.ts                   // OpenUSD WASM loader wrapper, dispose helper
│   ├── beltDynamics.ts           // Shared belt geometry + transportable-bodies set
│   ├── rover.ts                  // Path generators + contact detector
│   ├── lidar.ts                  // Raycaster wrapper for the ToF / lidar ring
│   ├── braccio.ts                // Braccio joint limits + link lengths
│   ├── braccioIk.ts              // Analytical IK solver + lerp helper
│   ├── armTrajectories.ts        // Parametric joint-space trajectory generators
│   ├── imuNoise.ts               // LSM6DSO-calibrated synthetic noise model
│   ├── dragMove.ts               // Shift+drag pointer-event handlers (XZ plane)
│   ├── capture.ts                // Off-screen render, bbox projection, download helper
│   ├── edgeImpulse.ts            // Ingestion API + Studio API (list projects, fetch deployment)
│   ├── eiModel.ts                // EI WebAssembly model loader + classifier wrapper
│   ├── embed.ts                  // URL-param readers (apiKey / category / theme), iframe height
│   ├── useTheme.ts               // Theme state hook + setter (persisted in localStorage)
│   ├── zip.ts                    // Minimal browser zip writer (STORE)
│   └── zipReader.ts              // Browser zip reader (STORE + DEFLATE via DecompressionStream)
└── store/
    └── useStore.ts               // Zustand store (single source of truth)
```

## How the IMU signal is computed

A real IMU has two sensors: an accelerometer and a gyroscope. We emit both per tick.

**Accelerometer** measures **proper acceleration** — what you feel relative to free-fall, *not* coordinate acceleration:

```
a_proper = a_inertial − g_world
```

where `g_world = (0, −9.81, 0)`.

Per sampling tick (at most one per render frame, using the actual time elapsed since the last sample):

- **Dynamic body** — read Rapier's integrator state (`body.linvel()`), differentiate once over `sampleDt` to get inertial acceleration, subtract `g_world`, rotate into the body's local frame.
- **Kinematic body** (held by a pinch, or driven by the procedural-motions controller) — Rapier reports `linvel = 0`, so we fall back to a single position-delta over `sampleDt` for the velocity estimate, then differentiate as above.

This is one finite-difference, not two. An earlier version chained two — pos → velocity → accel, each divided by the nominal period — and combined with multiple sample emissions per frame produced ±500 m/s² aliasing spikes (the same body position got read twice in one frame, the second sample's "velocity" collapsed to zero, and the next frame's first sample saw `(V − 0)/period` ≈ 100 × V).

So: stationary object reads `(0, +9.81, 0)` (ground pushes up against gravity), freefall reads `(0, 0, 0)`, hand-driven shake gives a realistic IMU waveform.

### Initial spin on procedural release

Rapier zeroes a kinematic body's angular velocity when it switches back to dynamic, and a symmetric cube can land flat with no post-impact torque — both of which leave the gyroscope channel as a flat zero line. The procedural-motion runner therefore writes a one-shot `nextReleaseAngVel` hint into the store before each `releaseBody()` call, and the manipulator's kinematic→dynamic transition consumes it via `body.setAngvel(...)`. Magnitudes are tuned per motion class (drop ≈ 3 rad/s, push ≈ 2 rad/s, throw ≈ 5 rad/s) — a real-world drop almost always carries some initial spin, so matching that gives EI a richer 6-channel signal to discriminate from. User-driven manual recordings don't set the hint, so they keep the natural release behavior.

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
| Sample rate (motion) | UI / `useStore.ts` | 100 Hz |
| Sample rate (robotics) | `docs/robotics.md` | 20 Hz |
| Capture resolution | UI | 640 × 480 |
| Camera-jitter radius (batch) | `VirtualCamera.tsx` `r` | 0.6 m |
| Light-intensity jitter range | `VirtualCamera.tsx` | ±0.8 |
| Conveyor belt size | `beltDynamics.ts` | 1.6 × 8 m |
| Conveyor sideways-damping factor | `Conveyor.tsx` `lv.x * 0.4` | 0.4 |
| Lidar bins | UI / `useStore.ts` | 16 |
| Lidar max range | UI / `useStore.ts` | 20 m |
| Braccio rest pose | `braccio.ts` | all joints at 0 rad (aperture 0) |

## Edge Impulse payload formats

**Motion mode / Robotics mode (Arm)** (`/api/{training,testing}/data`):

Standard 6-channel IMU JSON format (accel + gyro).

**Robotics mode (Rover)** (`/api/{training,testing}/data`):

Depending on **Modality**, the `sensors` array contains:
- **Fused**: `accX/Y/Z`, `gyrX/Y/Z`, plus `r0` through `rN-1` for lidar range bins.
- **IMU only**: 6 IMU channels.
- **Lidar only**: N range channels.

**Detection / Anomaly mode** (`/api/{training,testing}/files`, multipart):


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

When you save a single detection-mode capture to disk, it downloads as a `.zip` containing the PNG plus a `bounding_boxes.labels` sidecar keyed to that filename — drop the unzipped folder straight into the EI uploader. Batch saves zip the whole batch with one shared sidecar. The sidecar follows the [Edge Impulse uploader format](https://docs.edgeimpulse.com/docs/edge-impulse-studio/data-acquisition/uploader#bounding-boxes):

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

## Auto-attached EI metadata

Every uploaded sample carries an `x-metadata` JSON header (per the [EI metadata API](https://docs.edgeimpulse.com/studio/projects/data-acquisition/metadata)) tagging it with:

- `source: Synthetic Data Studio`
- The page URL
- The object kind
- Motion class (motion mode) or scene contents (vision mode: shapes present, USDZ asset filenames + labels, environment preset, conveyor state, image dimensions, capture timestamp)

Lets you filter the EI data view by where samples came from and how they were generated — no UI fields, fully automatic.
