# Robotics mode

Two synthetic-robot rigs in one mode, each producing time-series training data
for the canonical Edge Impulse robotics datasets:

- **Rover** — differential-drive ground robot with a 16-beam lidar / ToF ring,
  driven through `cruise` / `collision` / `stuck` events. Outputs a combined
  6-channel chassis IMU + N-channel lidar time-series per recording window.
- **Arm (Arduino TinkerKit Braccio)** — 6-DOF stationary arm with animated
  gripper, driving through `pick_place` / `sweep` / `wave` / `random_pose` /
  `draw_circle` joint trajectories. Outputs end-effector IMU per window.

Both rigs share a small first-person POV preview canvas (the corner overlay)
so you can see the scene the robot's onboard camera would see, matching how
real Arduino rover / arm setups typically include a forward-facing module.

## Use cases

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

### Rover

- **Chassis IMU** (6-channel) — body-local proper acceleration + gyroscope,
  computed from kinematic pose deltas via `computeImuReading` (the same
  helper Motion mode uses). On contact, a penetration-scaled impulse is
  injected along the contact normal so the accelerometer spike matches what
  a real bumper switch would feel.
- **2D lidar / ToF ring** (configurable bins, default 16) — `THREE.Raycaster`
  fans cast horizontally from the rover head against the obstacle group
  every frame. Beams that don't hit anything within `lidarMaxRange` clamp
  to that value, matching how a real ToF reports "no return". Bin 0 points
  along the rover's forward heading; bins sweep counter-clockwise.

Both sensors sample at 20 Hz during a recording. The Edge Impulse upload
packs them into a single time-series sample with one timestep per row and
6 + N columns (`accX`, `accY`, `accZ`, `gyrX`, `gyrY`, `gyrZ`, `r0`, …,
`rN-1`).

### Arm

- **End-effector IMU** (6-channel) — body-local proper acceleration +
  gyroscope, derived from world-pose deltas of the gripper-carrier group
  (the chain is kinematic, so we use pose differences instead of reading
  rapier velocity). Sampled at 20 Hz during a recording.

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
| `pick_place`   | 7-keyframe pick-and-place: rest → above target → on target → grasp → lift → above destination → release → rest. The pickup target is one of your scene objects (use **+ Pickup target** to spawn one); the destination is the diametrically-opposite point on the same radial ring. IK keeps the gripper pointing down throughout. |
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

- **Reset scene** — regenerate the obstacle field, clear the rover pose
  and any in-flight recording.
- **Randomize obstacles** — re-roll obstacle positions only; keeps the
  rover and recording state.
- **Randomize obstacles each iteration** (rover only) — re-roll the
  obstacle field at the start of every recording iteration so the batch
  contains spatial variety.
- **Drag obstacles / scene objects** — the same Shift+drag controls as
  detection / anomaly modes work on every robot-scene mesh:
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

## Edge Impulse upload

Both rigs upload to the standard Edge Impulse data acquisition endpoint.
The label is the event class (rover) or trajectory class (arm); metadata
includes the iteration index, total batch size, sensor parameters, and
duration so you can filter on those in the EI Studio. With no API key
configured, the runner zips the per-iteration JSON payloads and triggers
a download.

## Architecture

```
src/lib/
  rover.ts              event-aware path generators + contact detector
                        + obstacle placer
  lidar.ts              raycaster wrapper for the ToF / lidar ring
  braccio.ts            published Braccio joint limits + link lengths
  braccioIk.ts          analytical IK solver + lerp helper
  armTrajectories.ts    parametric joint-space trajectory generators

src/components/
  Rover.tsx             rover rig + lidar fan + IMU sampler + path follower
  RobotObstacles.tsx    draggable, store-driven obstacle field
  BraccioArm.tsx        Braccio rig + IMU sampler + trajectory controller
  RobotPovCamera.tsx    first-person preview camera (rover front / arm wrist)
  RobotPanel.tsx        sidebar UI: kind, event/trajectory, count, scene reset
```

The procedural runner in `RobotPanel.tsx` mirrors the motion-mode runner:
it bumps an epoch counter that the in-canvas controller listens to, sleeps
for the recording window, snapshots the per-modality sample arrays, and
either uploads to EI or writes a zip.
