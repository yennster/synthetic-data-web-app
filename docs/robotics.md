# Robotics mode

Two synthetic-robot rigs in one mode, each producing time-series training data
for the canonical Edge Impulse robotics datasets:

- **Rover** — differential-drive ground robot with a configurable lidar / ToF
  ring (default 16 beams), driven through `cruise` / `collision` / `stuck`
  events. Outputs a combined 6-channel chassis IMU + N-channel lidar
  time-series per recording window.
- **Arm (Arduino TinkerKit Braccio)** — 6-DOF stationary arm with animated
  gripper, driving through `pick_place` / `sweep` / `wave` / `random_pose` /
  `draw_circle` joint trajectories. Outputs end-effector IMU per window and,
  for pick-and-place, metadata describing whether the pickup actually
  succeeded.

Both rigs share a small first-person POV preview canvas (the corner overlay)
so you can see the scene the robot's onboard camera would see, matching how
real Arduino rover / arm setups typically include a forward-facing module.

The robot mode is geared toward two well-known TinyML datasets:

- **Rover collision detection.** Train a tiny model to classify the chassis
  IMU window into `cruise` (clean drive), `collision` (bumper-style impact),
  or `stuck` (wheel pinned, vibrating in place). The lidar channels give the
  model a "did we see it coming" feature alongside the bumper signal.
- **Arm motion classification.** Train a model to recognize what the arm is
  doing from the end-effector IMU — useful for anomaly detection (the arm
  jammed mid-cycle), pick-and-place verification, or remote teleop coaching.

These are the kinds of demos that ship as published Edge Impulse tutorials,
so the synthetic data here can be uploaded to a real EI project, used to
seed an enterprise model, or replayed to bootstrap a real-hardware
collection campaign.

## Sensors

Both robots run on **MuJoCo** (WebAssembly). The visual three.js rigs read
their pose from `data.xpos` / `data.xquat` each frame; sensors come from
MuJoCo's native `accelerometer` + `gyro` at an IMU site on the relevant
body. See [Internals → Physics + sensors](internals.md#physics--sensors-one-pipeline-mujoco-wasm).

### Rover

- **Chassis IMU** (6-channel) — body-local proper acceleration + gyroscope
  from the IMU site at the chassis center. Position-actuator dynamics +
  body mass mean the IMU reads physical acceleration, not finite-
  differenced pose deltas.
- **Contact detection** — MuJoCo's contact solver runs each step.
  `RoverSim.chassisInContact()` reads `data.ncon` + the contact list to
  flip the bumper indicator; the accelerometer spike on impact comes
  from the solver's constraint response, no hand-tuned magnitude.
- **2D lidar / ToF ring** (configurable bins, default 16) — `THREE.Raycaster`
  fans cast horizontally from the rover head against the three.js
  obstacle group every frame. Beams that don't hit anything within
  `lidarMaxRange` clamp to that value, matching how a real ToF reports
  "no return". Bin 0 points along the rover's forward heading; bins
  sweep counter-clockwise.

Both sensors sample at 20 Hz during a recording. The Edge Impulse upload
packs them into a single time-series sample with one timestep per row and
6 + N columns (`accX`, `accY`, `accZ`, `gyrX`, `gyrY`, `gyrZ`, `r0`, …,
`rN-1`).

### Arm

- **End-effector IMU** (6-channel) — body-local proper acceleration +
  gyroscope from the IMU site at the gripper carrier. Trajectories push
  target joint angles into MuJoCo's position actuators; the integrator
  drives the chain there under realistic joint inertia + gravity
  loading, and the IMU reads what an MEMS sensor on the gripper would
  feel. Sampled at 20 Hz.
- **Pickup target** — a free-joint box body in the MJCF, snapped to the
  user's selected scene position at the start of a `pick_place` run.
  Primitive pickups use the default 3 cm cube proxy; imported USDZ
  pickups rebuild the MuJoCo target to the imported asset's scaled
  bounds, with the visual asset following the simulated body. The
  gripper fingers close on it physically (high-friction Coulomb
  contacts) and the integrator handles the lift + place arc.
- **Pickup validation** — during the close / lift window the arm checks
  whether the target has tipped past 40 degrees or drifted outside its
  footprint tolerance. Ungraspable targets are not counted as successful
  pickups, and the gripper is kept open rather than pretending the
  grasp worked. The IK target is also clamped so the finger pads cannot
  be commanded through the floor while reaching for floor-resting
  objects.

The arm's POV camera shares the corner overlay so you can see the scene
the gripper-mounted camera would see during the trajectory — useful for
visualizing pick-and-place targeting before wiring up vision capture.

## Path / trajectory generators

### Rover events

| Event       | Behavior |
|-------------|----------|
| `cruise`    | Smooth straight-line traverse through the obstacle field that's been validated to clear every obstacle by ≥ chassis half-diagonal. Falls back to a wide orbital arc if no straight-line solution is found. |
| `collision` | Aim from a launch point straight at a randomly-chosen obstacle; the contact detector trips ~60 % through the window. |
| `stuck`     | Pin the rover's chassis disc just inside an obstacle, oscillate by ~3 cm at 5–8 Hz. Contact stays continuous for the whole window. |

All generators take a uniform RNG so tests can pass a seeded sequence and
get reproducible paths. Each is parametric over `t ∈ [0, 1]`, with the
runner advancing `t` so the recording window covers exactly one full
traversal.

### Arm trajectories

| Trajectory     | Behavior |
|----------------|----------|
| `pick_place`   | 7-keyframe pick-and-place: rest → above target → on target → grasp → lift → above destination → release → rest. The pickup target is one of your scene objects (use **+ Pickup target** to spawn one, or import a USDZ pickup); the destination is the diametrically-opposite point on the same radial ring. IK keeps the gripper pointing down throughout. Tipped or drifted objects are marked failed in metadata instead of being treated as successful grasps. |
| `sweep`        | Base servo sweeps across most of its 0–180° range at fixed shoulder / elbow. |
| `wave`         | Wrist pitch oscillates two cycles across most of its range at fixed shoulder / elbow. |
| `random_pose`  | Interpolate (cosine-eased) between two random reachable joint vectors. |
| `draw_circle`  | End-effector traces a horizontal circle (radius 8 cm, height 18 cm) via planar IK. |

The IK solver in [`braccioIk.ts`](../src/lib/braccioIk.ts) is analytical:
yaw + 2-link planar (shoulder/elbow) + tip-down approach for the wrist. It
clamps to the published Braccio servo limits (`BRACCIO_LIMITS_RAD`) so
unreachable targets resolve to the closest reachable pose instead of
faulting — the same saturating behavior an Arduino sketch would show on
the physical arm.

## Scene controls

- **Reset scene** — clear the rover pose, reset the arm to its home
  pose, and clear any in-flight recording.
- **Imported USDZ assets** — use **Imported pickups** for Braccio
  pick-and-place targets or **Imported obstacles** for rover lidar /
  MuJoCo collision obstacles. Arm pickups use a box collision proxy
  derived from the imported asset's scaled bounds; rover obstacles use
  their imported footprint for collision and lidar raycasts. Imported
  robot assets are kept separate from the detection / anomaly scene pool.
- **Drag scene objects** — the same Shift+drag controls as detection /
  anomaly modes work on every robot-scene mesh:
  - `Shift+drag` — camera-aligned plane (free XYZ via orbit)
  - `Shift+(Alt|Option|Ctrl|Cmd)+drag` — depth mode along camera gaze
  - `Shift+drag + wheel` — push/pull along camera gaze (mouse-only)

## Deep links

The mode picker is URL-overridable. Useful for sharing a robot rig with
a teammate without making them click around:

```
?mode=robotics            # land in robot mode (any persisted kind)
?mode=robotics&robot=arm  # land in arm mode specifically
?mode=robotics&robot=rover  # land in rover mode specifically
```

Aliases accepted for `?mode=`: `robot`, `robotics`, `rover`, `arm`.

## Sensor modality (rover)

The rover panel exposes a three-way picker for which sensor channels
land in the EI payload:

| Modality       | Channels                          | Use case |
|----------------|-----------------------------------|----------|
| **Fused** *(default)* | 6 IMU + N lidar in one sample | Sensor-fusion classifiers — what makes the rover dataset interesting. |
| **IMU only**   | 6 IMU channels                    | Train collision detection on the bumper signal alone, the way a sensorless rover would. |
| **Lidar only** | N range channels                  | Train environment classification (open / corridor / corner) without IMU. |

The IMU and lidar are recorded in lockstep at 20 Hz regardless of
modality, so switching is purely a payload-shape choice — nothing
about the synthesis changes.

## ROS 2 export

Toggle **ROS export** in the Sensor modality card to also write a
`<event>_<i>.rosbag.jsonl` next to each EI payload. Rover exports include
IMU + LaserScan messages; arm exports include end-effector IMU + JointState
messages. Each line is one canonical ROS 2 message:

```json
{"topic":"/imu/data","msg":{"header":{"stamp":{"sec":1,"nanosec":500000000},"frame_id":"imu_link"},"linear_acceleration":{...},"angular_velocity":{...},"orientation":{...},...}}
{"topic":"/scan","msg":{"header":{...,"frame_id":"laser_link"},"angle_min":0,"angle_max":...,"ranges":[...],...}}
{"topic":"/joint_states","msg":{"header":{...},"name":["M1","M2","M3","M4","M5","M6"],"position":[...]}}
```

Topics + frames follow REP-105 / REP-103:

| Topic        | Type                  | Frame        |
|--------------|-----------------------|--------------|
| `/imu/data`  | `sensor_msgs/Imu`     | `imu_link`   |
| `/scan`      | `sensor_msgs/LaserScan` | `laser_link` (rover only) |
| `/joint_states` | `sensor_msgs/JointState` | n/a (arm only) |

JSONL replays trivially (`ros2 run rosbag2_play_jsonl rosbag.jsonl`
with any user-side player) and the message shapes match `ros2 msg show`
exactly so a deserializer is a one-liner. Bundles into the same zip
as the EI payload — works whether the robot is uploading to EI or
just downloading samples.

## Synthetic IMU noise model

Every IMU sample (motion mode, rover chassis, arm end-effector) is
post-processed through a MathWorks `imuSensor`-style noise model in
[`lib/imuNoise.ts`](../src/lib/imuNoise.ts). The clean inertial
reading is degraded by:

- **Allan-variance noise density** — gaussian per-sample noise scaled
  by `density · √Hz`. Defaults match an LSM6DSO at ±4 g / ±2000 dps
  (`5.9e-4 m/s²/√Hz` accel, `1.2e-4 rad/s/√Hz` gyro).
- **Bias instability** — slow random walk of the per-axis zero offset.
  Makes the recorded trace exhibit realistic bias wandering rather
  than a flat baseline.
- **Per-axis scale-factor error** — a fixed `1 ± ε` gain sampled once
  per IMU instance (defaults to ±0.5 %).
- **Saturation** — clip to the configured dynamic range (defaults to
  ±4 g accel, ±2000 dps gyro).
- **ADC quantization** — round to the configured LSB (defaults to
  16-bit-effective).

Disable the model by toggling `imuNoise.enabled` to false in the
store (or your own UI control) — the clean underlying inertial
reading flows straight through. The defaults are calibrated for the
LSM6DSO in the Arduino Nano 33 BLE Sense / RP2040 Connect, the boards
Edge Impulse users typically deploy to.

## Edge Impulse upload

Both rigs build Edge Impulse data-acquisition JSON samples, then upload
them through the Ingestion API `/files` endpoint as multipart `data`
files. The label is the event class (rover) or trajectory class (arm).
Direct uploads attach metadata via `x-metadata`; local downloads include
the same labels and metadata in an `info.labels` sidecar next to the
per-iteration JSON payloads.

Shared robotics metadata includes the iteration index, total batch size,
sensor parameters, duration, and upload split bucket when applicable.
Arm `pick_place` samples also include `pickup_attempted`, `pickup_success`,
`pickup_max_lift_m`, `pickup_graspable`, and failure details such as
`pickup_failure_reason`, max tilt, and horizontal drift.

## Architecture

```
src/lib/
  rover.ts              event-aware path generators + contact detector
  lidar.ts              raycaster wrapper for the ToF / lidar ring
  braccio.ts            published Braccio joint limits + link lengths
  braccioIk.ts          analytical IK solver + lerp helper
  armTrajectories.ts    parametric joint-space trajectory generators
  armPickupGeometry.ts  floor-safe pick-and-place gripper tip helpers
  armPickupOutcome.ts   pickup success / failure observation + metadata
  importedAssetBounds.ts imported-asset bounds normalization helpers

src/components/
  Rover.tsx             rover rig + lidar fan + IMU sampler + path follower
  SpawnedObjects.tsx    primitive pickup / obstacle meshes
  ImportedAssets.tsx    USDZ pickup / obstacle meshes
  BraccioArm.tsx        Braccio rig + IMU sampler + floor-safe pickup controller
  RobotPovCamera.tsx    first-person preview camera (rover front / arm wrist)
  RobotPanel.tsx        sidebar UI: kind, event/trajectory, count, scene reset
```

The procedural runner in `RobotPanel.tsx` mirrors the motion-mode runner:
it bumps an epoch counter that the in-canvas controller listens to, sleeps
for the recording window, snapshots the per-modality sample arrays, and
either uploads to EI or writes a zip.
