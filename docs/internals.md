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
│   ├── rover.ts                  // Procedural path generators (cruise / collision / stuck)
│   ├── lidar.ts                  // Raycaster wrapper for the ToF / lidar ring
│   ├── braccio.ts                // Braccio joint limits + link lengths
│   ├── braccioIk.ts              // Analytical IK solver + lerp helper
│   ├── armTrajectories.ts        // Parametric joint-space trajectory generators
│   ├── imuNoise.ts               // LSM6DSO-calibrated synthetic noise model
│   ├── mujoco/                   // MuJoCo (WebAssembly) physics + sensor pipeline
│   │   ├── runtime.ts            //   Lazy WASM loader (singleton, ?url-resolved binary)
│   │   ├── imuSensor.ts          //   sampleImu() — single IMU codepath across all modes
│   │   ├── braccioMjcf.ts        //   MJCF for the arm + pickup target
│   │   ├── BraccioSim.ts         //   Arm wrapper: step, set joint targets, read sensors
│   │   ├── roverDims.ts          //   Shared chassis / wheel dimensions
│   │   ├── roverMjcf.ts          //   MJCF generator (chassis + dynamic obstacles)
│   │   ├── RoverSim.ts           //   Rover wrapper: planar chassis + MJCF rebuild
│   │   ├── motionMjcf.ts         //   MJCF templates per ObjectKind
│   │   └── MotionSim.ts          //   Motion-mode wrapper: grab/release via weld eq
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

## Physics + sensors: one pipeline (MuJoCo WASM)

Every scene that records IMU data — motion mode, the Braccio arm, the rover — runs on **MuJoCo**, compiled to WebAssembly via [`@mujoco/mujoco`](https://www.npmjs.com/package/@mujoco/mujoco). The visual rigs are still three.js (and still in React Three Fiber's `useFrame` loop); MuJoCo owns the dynamics, contact solver, and sensors. Each mode has a small `*Sim` wrapper in `lib/mujoco/` that owns one `MjModel` + `MjData` pair and exposes a handful of typed methods:

| Mode    | Wrapper      | Body topology                                                |
|---------|--------------|--------------------------------------------------------------|
| Motion  | `MotionSim`  | Free-joint manipulated body + mocap "hand" + weld equality. The shape (cube/sphere/phone/…) is baked into a per-kind MJCF that gets recompiled on `loadShape()`. |
| Arm     | `BraccioSim` | 5 revolute joints + 2 mirrored slide fingers + free-joint pickup target. Position actuators on every joint; the pickup target is moved with `placeTarget()` and grasped via friction. |
| Rover   | `RoverSim`   | Planar chassis (x slide, z slide, yaw hinge) + N static obstacle bodies. `rebuildWithObstacles()` recompiles the model when the scene's rover obstacles change. |

The WASM binary is ~8.6 MB and only loads when one of these scenes mounts (lazy `import()` in `lib/mujoco/runtime.ts`). Vite's `?url` import + an Emscripten `locateFile` hook resolve the `.wasm` next to the JS module.

### IMU readout — one codepath

Each `*Sim` implements `ImuSource`:

```ts
interface ImuSource {
  readImu(): {
    accel: [number, number, number]; // body-frame, gravity-included (m/s²)
    gyro:  [number, number, number]; // body-frame angular velocity (rad/s)
    quat:  [number, number, number, number]; // world orientation, (w, x, y, z)
    pos:   [number, number, number];         // world position (m)
  };
}
```

`accel` / `gyro` come straight from MuJoCo's `accelerometer` and `gyro` sensors attached to a site at the IMU mount point. No finite-difference math, no body-frame rotation in JS — MuJoCo does the physics. Both `BraccioSim`, `RoverSim`, and `MotionSim` produce the same shape.

`sampleImu(source, noiseStateRef, cfg, dt)` in `lib/mujoco/imuSensor.ts` is the single entry point every per-frame sampler calls. It:

1. Reads the IMU off the source.
2. Lazily initializes the LSM6DSO-calibrated noise state (`lib/imuNoise.ts`) — Allan-variance bias drift + per-axis scale-factor errors.
3. Applies noise in place so the drift accumulator advances between calls.
4. Stamps the sample with `performance.now()` and returns it.

Stationary body → `accel ≈ (0, +9.81, 0)` (gravity-loaded reaction); free-fall → `≈ (0, 0, 0)`; a body spinning at 1 rad/s about its own up-axis → `gyro ≈ (0, ~1, 0)`. Same convention everywhere.

### Motion mode: grab / release without body-type switching

The manipulated body is a real free-joint body in MuJoCo. A mocap body called `hand` represents where the user's pinch is in world space, and a `weld` equality constraint between the two is toggled via `data.eq_active[0]`:

- **Grab** (`sim.grab(pos, quat)`) → set `eq_active[0] = 1` and write `mocap_pos` / `mocap_quat`. The weld pulls the body to follow the hand; the integrator runs normally, so the accelerometer reads true proper acceleration of the constrained motion.
- **Pose updates** while grabbed (`sim.setHandPose(...)`) → just rewrite the mocap pose.
- **Release** (`sim.release({ linvel?, angvel? })`) → set `eq_active[0] = 0` and optionally write velocity into `qvel`. Gravity takes over from the next step.

`nextReleaseAngVel` in the store still exists — the procedural-motion runner writes a one-shot angvel hint before release so a symmetric cube doesn't land with a dead-flat gyroscope channel. Magnitudes are tuned per class (drop ≈ 3 rad/s, push ≈ 2 rad/s, throw ≈ 5 rad/s).

### Arm: real grasping

The Braccio MJCF contains a free-joint cube body (`target`) and high-friction gripper finger geoms. At the start of a `pick_place` run, `BraccioSim.placeTarget(pos)` writes the cube to the user's selected scene position with zero velocity. The trajectory's IK keyframes close the gripper at the right time and the fingers physically trap the cube via Coulomb friction. `SpawnedObjects` in `Scene.tsx` filters the active target id so the visual scene doesn't draw two cubes (the kinematic three.js mesh and MuJoCo's owned mesh would otherwise overlap).

### Rover: MuJoCo-native collisions

When the rover's "Reset scene" auto-spawns obstacles or the user adds them, `RoverSim.rebuildWithObstacles()` recompiles the model with one static cylinder body per obstacle. `mj_step()` runs MuJoCo's contact solver each frame, and `sim.chassisInContact()` reads `data.ncon` + the contact list to flip the bumper indicator. The accelerometer spike on impact comes from the solver's constraint forces — no hand-tuned `qfrc_applied` magnitude, no disc-circle math. Trajectory generation still uses the obstacle disc representation for path planning (the trajectory code is unchanged).

Lidar stays on three.js raycasts against the obstacle group — pulling N rangefinder sites into the MJCF would add overhead per `lidarBins` setting without a measurable signal-quality gain.

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
| Pinch follow smoothing | `Scene.tsx` `PINCH_LERP` | 0.35 |
| Motion-mode geom friction / mass | `motionMjcf.ts` (per-kind) | 0.6 friction · ~0.12 kg |
| Weld constraint compliance | `motionMjcf.ts` `solref` | `"0.015 1"` (15 ms time constant) |
| Floor friction | `motionMjcf.ts` / `roverMjcf.ts` / `braccioMjcf.ts` | 0.6 – 0.8 |
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
| MuJoCo timestep | per-MJCF `<option timestep>` | 2 ms (arm) · 5 ms (rover, motion) |
| Step catch-up cap | each `*Sim.step()` | 25 steps / frame (~50–125 ms wall-clock) |

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
