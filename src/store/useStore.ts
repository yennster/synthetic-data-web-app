import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Group } from 'three';
import type { NeedleThreeHydraHandle } from '@needle-tools/usd';
import { clearAssetBlobs, deleteAssetBlob } from '../lib/assetStore';
import type { EiModelInfo, EiResult, LoadedEiModel } from '../lib/eiModel';
import {
  ALL_ARM_TRAJECTORIES as _ALL_ARM_TRAJECTORIES,
  type ArmTrajectory as _ArmTrajectory,
} from '../lib/armTrajectories';
import {
  DEFAULT_IMU_NOISE,
  type ImuNoiseConfig,
} from '../lib/imuNoise';
import {
  createArmPickupObservation,
  updateArmPickupGraspAssessment,
  updateArmPickupObservation,
  type ArmPickupGraspAssessment,
  type ArmPickupObservation,
} from '../lib/armPickupOutcome';
import { BRACCIO_REST_RAD } from '../lib/braccio';
import type { ImportedAssetBounds } from '../lib/importedAssetBounds';

export type ObjectKind =
  | 'cube'
  | 'sphere'
  | 'phone'
  | 'capsule'
  | 'cylinder'
  | 'torus'
  | 'soda_can';

/** Visual environment presets — controls the floor material and optional
 * back-wall geometry. "studio" is the original dark backdrop. */
export type EnvPreset = 'studio' | 'warehouse' | 'whitebox' | 'outdoor';

export type AppMode = 'motion' | 'detection' | 'anomaly' | 'robot';

/** Procedural motion generator class. Each kind is recorded as its own
 * label so EI receives correctly-classed training data. */
export type MotionKind = 'drop' | 'throw' | 'push' | 'shake';

export const ALL_MOTION_KINDS: MotionKind[] = [
  'drop',
  'throw',
  'push',
  'shake',
];

/** Robot mode picks one of two rigs. The two rigs synthesize different
 * sensor modalities — the rover emits a 2D lidar/ToF ring scan per tick,
 * the arm emits chassis-frame IMU readings from its end-effector. */
export type RobotKind = 'rover' | 'arm';

/** Event classes for the rover — what's happening to the chassis
 * during a recording window. Replaces the earlier "trajectory shape"
 * labels because the shape can be recovered from heading/odometry,
 * which makes it a trivial ML target. Event classification on the
 * chassis IMU is the canonical Edge Impulse rover dataset. */
export type RoverEvent = 'cruise' | 'collision' | 'stuck';

export const ALL_ROVER_EVENTS: RoverEvent[] = ['cruise', 'collision', 'stuck'];

/** Selects which sensor modalities go into the EI payload for the
 * rover. `fused` packs both IMU and lidar into one multi-channel
 * sample (the default — sensor fusion is what makes the rover dataset
 * interesting). `imu` and `lidar` constrain the upload to a single
 * modality so the user can train one tower at a time, or compare
 * model accuracy with vs. without the second sensor. */
export type RoverUploadModality = 'fused' | 'imu' | 'lidar';

export const ALL_ROVER_UPLOAD_MODALITIES: RoverUploadModality[] = [
  'fused',
  'imu',
  'lidar',
];


/** Joint-space trajectory classes for the Braccio arm. Re-exported
 * from `../lib/armTrajectories` so the store stays the single source
 * of truth for app-shape types while the trajectory implementations
 * live in pure-helper land. */
export type ArmTrajectory = _ArmTrajectory;
export const ALL_ARM_TRAJECTORIES = _ALL_ARM_TRAJECTORIES;

/** One scan from the rover's lidar/ToF ring. `ranges[i]` is the distance
 * to the nearest obstacle along the i-th angular bin, in meters; the bin
 * spacing is `2π / ranges.length`, starting at the rover's forward
 * heading and sweeping counter-clockwise. Bins that hit nothing within
 * `lidarMaxRange` are clamped to that max value (matches how a real
 * VL53L0X/lidar reports an out-of-range hit). */
export type LidarSample = {
  t: number;
  ranges: number[];
};

/** Per-tick IMU sample. `a*` are accelerometer readings (m/s², body-local
 * proper acceleration — what a real IMU measures: stationary = +9.81 on
 * the up axis, freefall = 0). `g*` are gyroscope readings (rad/s,
 * body-local angular velocity). */
export type AccelSample = {
  t: number;
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
};

/** An imported `.usdz` asset, treated as a single labelled unit for bbox. */
export type ImportedAsset = {
  id: string;
  name: string;
  label: string;
  object: Group; // three.js group; rendered via <primitive>
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number;
  /** Local-space size recorded at import time. Used by robotics mode to
   * approximate imported assets as pickup centers / rover collision
   * footprints without walking the three.js subtree every frame. */
  bounds?: ImportedAssetBounds;
  /** When true, wrap the asset in a Rapier RigidBody (convex-hull collider)
   * so it falls under gravity, collides with other bodies, and is carried by
   * the conveyor. Toggling remounts the body. */
  physics: boolean;
  /** When true, replace all materials on the imported geometry with a plain
   * MeshStandardMaterial of `overrideColor`. Useful when a USDZ from
   * Omniverse arrives with MDL materials (which can't be translated to
   * three.js) and would otherwise render as flat magenta. */
  overrideMaterial: boolean;
  overrideColor: string;
  overrideRoughness: number;
  overrideMetalness: number;
  /** Live needle hydra handle — held so we can call `handle.update(dt)` per
   * frame to advance baked time-sample animation (Apple's animated AR Quick
   * Look samples, etc.) and to `dispose()` on remove. Null for assets
   * imported before this field existed. */
  handle?: NeedleThreeHydraHandle | null;
  /** Set at import time when the underlying stage has authored time samples
   * (endTimeCode > startTimeCode). Drives the play/pause UI. */
  isAnimated: boolean;
  /** When true and `isAnimated`, the renderer advances animation each frame.
   * Toggled from the asset's play/pause control in the panel. */
  animationPlaying: boolean;
  /** Mode-context that owns this asset. Same semantics as `SceneObject.owner`
   * — drives both panel-side filtering (the arm panel only edits arm-owned
   * USDZs, etc.) and scene-side filtering (the arm scene only renders
   * arm-owned imported assets). Omitting it puts the asset in the legacy
   * "vision" pool used by detection / anomaly. */
  owner?: SceneObjectOwner;
};

/** Serializable subset of `ImportedAsset` written to localStorage. The live
 * three.js Group + needle hydra handle aren't included — those get rebuilt
 * by re-running `loadUsdz()` against the original `.usdz` bytes stored in
 * IndexedDB during rehydration. */
export type PersistedAsset = {
  id: string;
  name: string;
  label: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number;
  bounds?: ImportedAssetBounds;
  physics: boolean;
  overrideMaterial: boolean;
  overrideColor: string;
  overrideRoughness: number;
  overrideMetalness: number;
  isAnimated: boolean;
  animationPlaying: boolean;
  /** See `ImportedAsset.owner`. Persisted so rehydrated assets land
   * in the right scene-mode pool. */
  owner?: SceneObjectOwner;
};

/** Which mode-context owns a `SceneObject`. Drives both the rendering
 * filter (rover scene only renders rover-owned objects, arm scene only
 * arm-owned, etc.) and the panel-side editor filter so detection-mode
 * objects don't bleed into the robotics panels and vice-versa.
 * Undefined / missing = the legacy "vision" pool used by detection and
 * anomaly modes; preserves backward compat with persisted state. */
export type SceneObjectOwner = 'rover' | 'arm';

// A spawned object in the scene, used in detection / anomaly modes
// AND in robotics mode (per-kind, gated by the `owner` field).
export type SceneObject = {
  id: string;
  kind: ObjectKind;
  label: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: number;
  color: string;
  metalness: number;
  roughness: number;
  /** When true, the object has a Rapier RigidBody and falls / collides /
   * rides the conveyor. When false it's a static visual at its position
   * (still draggable with Shift+drag). Defaults to true. */
  physics: boolean;
  /** Mode-context that owns this object. See `SceneObjectOwner`. */
  owner?: SceneObjectOwner;
};

export type EdgeImpulseConfig = {
  apiKey: string;
  hmacKey: string;
  /** EI ingestion bucket. `split` is a client-side mode that randomly
   * routes each sample to training or testing on an 80:20 split per
   * roll — the actual API call still hits the per-bucket endpoint. */
  category: 'training' | 'testing' | 'split';
  label: string;
  device: string;
};

/** Per-iteration camera path used by batch capture. `random` is the
 * legacy jitter-around-the-base-pose pass. The named trajectories sweep
 * the camera along a deterministic path orbiting the current
 * `camTarget`, sampled at the iteration count — useful for generating
 * datasets that systematically vary the viewpoint rather than scatter
 * it. */
export type CameraTrajectory =
  | 'random'
  | 'circle'
  | 'figure8'
  | 'arc'
  | 'spiral'
  | 'orbit_dome';

export const ALL_CAMERA_TRAJECTORIES: CameraTrajectory[] = [
  'random',
  'circle',
  'figure8',
  'arc',
  'spiral',
  'orbit_dome',
];

export type CaptureSettings = {
  width: number;
  height: number;
  // Camera controls
  camPos: [number, number, number];
  camTarget: [number, number, number];
  fov: number;
  // Randomization toggles
  randomizeCamera: boolean;
  randomizeLighting: boolean;
  randomizeObjects: boolean;
  // Batch
  batchCount: number;
  // Lighting amplitude
  lightIntensity: number;
  envRotation: number;
  /** Path the camera traces during batch capture. See `CameraTrajectory`.
   * When set to anything other than `random`, the per-iteration camera
   * position is computed by `sampleCameraTrajectory` and the
   * `randomizeCamera` jitter is skipped (the path itself provides the
   * variation). */
  cameraTrajectory: CameraTrajectory;
  /** Horizontal radius of the trajectory around `camTarget`, in meters. */
  trajectoryRadius: number;
  /** Vertical amplitude / height the trajectory uses (semantics vary by
   * path — see `sampleCameraTrajectory`). */
  trajectoryHeight: number;
};

export type BoundingBox = {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Post-capture "realism" pass that runs over every captured PNG before
 * it lands in EI or the local zip. `off` is the raw render. `random`
 * applies a stack of cheap CPU-side pixel transforms (film grain,
 * chromatic aberration, vignette, color jitter, JPEG re-encode) to
 * narrow the sim-to-real gap. `diffusion` is reserved for a future
 * server-side endpoint hitting img2img / ControlNet — wiring lives
 * here so the UI doesn't need to be reshaped when it lands.
 *
 * Bounding boxes are structural and don't move during the random pass,
 * so the EI labels stay valid regardless of the chosen mode.
 */
export type RealismMode = 'off' | 'random' | 'diffusion';

/** Per-effect intensities (0..1) for the Photo FX realism pass. Each
 * knob is independent so users can dial in, e.g., heavy grain with
 * no vignette, or strong JPEG artifacts with subtle CA. `jpeg` of 0
 * skips the JPEG round-trip entirely.
 *
 * `randomize` is an orthogonal toggle: when true, each capture
 * re-samples its effective intensities in [0, slider value], so a
 * batch sees varied realism instead of identical settings on every
 * PNG. When false, the slider values are applied verbatim. */
export type RealismConfig = {
  mode: RealismMode;
  grain: number;
  chromatic: number;
  vignette: number;
  jitter: number;
  jpeg: number;
  randomize: boolean;
};

/** Average across the five effect knobs — used as a convenience
 * for places (EI metadata fallback) where a single 0..1 value is
 * still useful even though the pass no longer has a master slider. */
export function realismAverage(r: RealismConfig): number {
  return (r.grain + r.chromatic + r.vignette + r.jitter + r.jpeg) / 5;
}

/** Default per-effect intensities. 0.5 across the board matches the
 * old single-slider default at 0.5. */
export const DEFAULT_REALISM: RealismConfig = {
  mode: 'off',
  grain: 0.5,
  chromatic: 0.5,
  vignette: 0.3,
  jitter: 0.5,
  jpeg: 0.5,
  randomize: false,
};

export type Capture = {
  id: string;
  filename: string;
  blob: Blob;
  boxes: BoundingBox[];
  label: string; // batch-level label (anomaly mode) or '' for detection
  width: number;
  height: number;
  ts: number;
  /** Default shape kinds (cube/sphere/…) present in the scene at capture
   * time, deduped. Sent as `shapes` in EI sample metadata. */
  shapes?: string[];
  /** Imported USDZ assets present in the scene at capture time. Sent as
   * `asset_files` / `asset_labels` in EI sample metadata. */
  assetSnapshot?: { name: string; label: string }[];
};

type State = {
  mode: AppMode;
  setMode: (m: AppMode) => void;

  // ---------- Motion mode ----------
  objectKind: ObjectKind;
  setObjectKind: (k: ObjectKind) => void;

  isGrabbed: boolean;
  setGrabbed: (b: boolean) => void;

  pinchTarget: [number, number, number] | null;
  setPinchTarget: (p: [number, number, number] | null) => void;

  /** Optional kinematic rotation override (quaternion x,y,z,w) applied while
   * the body is grabbed. Used by the procedural drop generator to randomize
   * each drop's starting orientation; null = leave the body's current
   * rotation alone. */
  pinchRotation: [number, number, number, number] | null;
  setPinchRotation: (q: [number, number, number, number] | null) => void;

  isRecording: boolean;
  startRecording: () => void;
  stopRecording: () => void;
  samples: AccelSample[];
  pushSample: (s: AccelSample) => void;
  clearSamples: () => void;

  sampleRateHz: number;
  setSampleRateHz: (n: number) => void;

  handDetected: boolean;
  setHandDetected: (b: boolean) => void;
  pinchStrength: number;
  setPinchStrength: (n: number) => void;
  /** Multiplier applied to the hand-tracker's per-frame target coords
   * before they're written to `pinchTarget`. Scaled from 1 → ~3 based
   * on the OrbitControls camera distance from the scene anchor so the
   * user can drop / throw from higher up the more they zoom out. The
   * camera rig writes this each frame; CameraFeed reads it inside the
   * MediaPipe callback. */
  handMappingScale: number;
  setHandMappingScale: (n: number) => void;
  /** Master toggle for the webcam + MediaPipe hand-tracking pipeline. When
   * off, the CameraFeed component doesn't mount, so the camera light never
   * turns on and no permission prompt fires. The procedural drops feature
   * needs this off to drive the manipulated body without conflict. */
  handTrackingEnabled: boolean;
  setHandTrackingEnabled: (b: boolean) => void;

  /** One-shot hint consumed by the next kinematic→dynamic release in
   * Scene's ManipulatedObject. The procedural-motion runner sets this so
   * the released body has visible spin in the captured IMU data — a clean
   * kinematic hold leaves Rapier's angular velocity at zero, and a
   * symmetric cube can otherwise land flat with no post-impact torque, so
   * the gyroscope channel reads as a flat line. Cleared back to null
   * after Scene applies it. */
  nextReleaseAngVel: [number, number, number] | null;
  setNextReleaseAngVel: (v: [number, number, number] | null) => void;

  /** Procedural motion-generator config. Each batch produces N labelled
   * IMU samples for the selected `motion` class. */
  drops: {
    count: number;
    heightMin: number;
    heightMax: number;
    /** How long to record after each release before stopping that sample. */
    durationMs: number;
    motion: MotionKind;
    /** Horizontal release speed for the throw motion (m/s). */
    throwSpeed: number;
    /** Horizontal release speed for the push motion (m/s). */
    pushSpeed: number;
    /** Oscillation frequency for the shake motion (Hz). */
    shakeFreq: number;
    /** Peak displacement amplitude for the shake motion (m). */
    shakeAmp: number;
  };
  setDrops: (patch: Partial<State['drops']>) => void;
  /** True while a procedural drop sequence is running. UI uses this to show
   * progress and disable the trigger. */
  dropsRunning: boolean;
  setDropsRunning: (b: boolean) => void;
  /** Set to true to ask an in-progress procedural run to stop at the next
   * cancellation checkpoint (between iterations / sleeps). The runner
   * resets this back to false on its next start. */
  dropsCancelRequested: boolean;
  setDropsCancelRequested: (b: boolean) => void;

  // ---------- Robot mode ----------
  /** Procedural robotics-data generator config. The rover (ground vehicle
   * recording chassis IMU + lidar through cruise / collision / stuck
   * events) and the Braccio arm (6-DOF stationary arm picking up scene
   * objects) live in the same mode behind a `kind` toggle because they
   * share the procedural-runner shape, EI upload path, and sidebar
   * surface. */
  robot: {
    kind: RobotKind;
    /** Currently-selected rover event class — also the EI label written
     * onto the next batch of recordings. */
    roverEvent: RoverEvent;
    armTrajectory: ArmTrajectory;
    /** How many trajectories to record this batch — one EI sample each. */
    count: number;
    /** Recording window per trajectory. */
    durationMs: number;
    /** Number of angular bins in the rover's lidar ring (≥3). */
    lidarBins: number;
    /** Maximum reportable distance for the lidar — readings beyond this
     * are clamped, matching a real ToF/lidar's "no return" behavior. */
    lidarMaxRange: number;
    /** Which sensor modalities go into the EI payload for the rover.
     * `fused` packs IMU + lidar into one multi-channel sample (default,
     * since sensor fusion is what makes the rover dataset interesting).
     * `imu` and `lidar` constrain the upload to a single modality so
     * the user can train one tower at a time, or compare model accuracy
     * with vs. without the second sensor. */
    uploadModality: RoverUploadModality;
    /** When true, the runner additionally writes a `rosbag.jsonl` next
     * to each EI payload (or into the zip, when no API key is set)
     * with the same data formatted as canonical ROS 2 sensor messages
     * — `sensor_msgs/Imu`, `sensor_msgs/LaserScan`, `nav_msgs/Odometry`.
     * Useful for ROS users who want to replay the synthetic data
     * through `ros2 bag play` or feed it to a real navigation stack. */
    rosExport: boolean;
    /** Six-component home pose for the Braccio (M1..M6 in the same
     * units as `BRACCIO_REST_RAD`: joints 0..4 are servo radians,
     * joint 5 is normalized aperture in [0, 1]). The rig renders
     * this when no trajectory is driving the arm; trajectories
     * pull it as their "rest" reference so e.g. `pick_place` returns
     * to the user's chosen home. Sliders in the arm panel clamp each
     * value to the published `BRACCIO_LIMITS_RAD` so the user can't
     * ask the physical arm to overextend. */
    armHomePose: [number, number, number, number, number, number];
    /** Which point on the arm the wrist-mounted POV camera is
     * actually attached to. The component reads
     * `arm-pov-${armCameraMount}` and `arm-pov-${armCameraMount}-look`
     * scene-graph anchors each frame, so adding a new mount just
     * means adding a pair of named groups in `BraccioArm.tsx`. */
    armCameraMount: 'base' | 'shoulder' | 'elbow' | 'wrist' | 'gripper';
    /** When true, the procedural runner re-samples a random reachable
     * position for every arm-owned pickup object at the start of each
     * `pick_place` iteration. Useful for generating diverse training
     * data without dragging the cube between runs. The sampler stays
     * inside the published Braccio reach envelope (radius 8–18 cm,
     * base-yaw half-circle) so every randomized target is graspable. */
    armRandomizeTarget: boolean;
    /** Enable an "object detection" capture pass alongside the sensor
     * recording. Each iteration the runner also snaps a high-res image
     * from the rover/arm POV camera (mid-motion) with bounding boxes
     * computed from labelled scene meshes — i.e. the same 2D-projection
     * pipeline detection-mode uses. The image stream lands either in
     * the Edge Impulse project (object-detection sample) or in the
     * downloaded zip depending on what the target project already
     * contains; the sensor stream is routed the opposite way when the
     * project type would conflict. */
    objectDetection: boolean;
    /** When `objectDetection` is on, also capture one image per
     * iteration with the robot at rest (rover stopped at the starting
     * pose; arm at the home pose) in addition to the in-motion capture.
     * Doubles the per-iteration image count. */
    captureAtRest: boolean;
    /** Output resolution for object-detection captures. The live POV
     * preview canvas can be tiny (overlay in the corner), so the
     * runner renders into a fresh offscreen canvas at this size when
     * the user wants higher-quality training images. */
    objectDetectionWidth: number;
    objectDetectionHeight: number;
    /** How many object-detection images to snap each iteration. In
     * motion-phase mode the runner spaces them evenly across the
     * recording window; in at-rest mode they fire back-to-back at
     * the start. Range [1, 20]. */
    objectDetectionImagesPerIteration: number;
  };
  setRobot: (patch: Partial<State['robot']>) => void;
  /** True while a procedural robot run is active. */
  robotRunning: boolean;
  setRobotRunning: (b: boolean) => void;
  robotCancelRequested: boolean;
  setRobotCancelRequested: (b: boolean) => void;
  /** Successful captures produced by the in-progress (or last-completed)
   * robotics run. Lives in the store so the HUD can show a live count
   * for robotics mode — the vision `captures` array is image-only and
   * stays empty in robotics. Reset at the start of each run and on
   * `resetRobotScene`. */
  robotCaptures: number;
  bumpRobotCaptures: () => void;
  resetRobotCaptures: () => void;
  /** Lidar/ToF time-series for the in-progress (or just-finished) rover
   * recording. Distinct from the IMU `samples` array because the per-tick
   * payload is N range bins, not a 6-channel reading. Cleared at the
   * start of each rover trajectory the same way `samples` is. */
  lidarSamples: LidarSample[];
  pushLidarSample: (s: LidarSample) => void;
  clearLidarSamples: () => void;

  /** Live kinematic pose for the rover, written by the trajectory
   * controller and read by the rig component every frame. The position
   * is on the ground plane (y = 0); `heading` is yaw in radians measured
   * from world +Z, counter-clockwise about +Y (so `heading = 0` faces
   * +Z, `π/2` faces +X). Null while no rig is active. */
  roverPose: { x: number; z: number; heading: number } | null;
  setRoverPose: (p: State['roverPose']) => void;
  /** Bumped by the procedural runner once per recording iteration. The
   * in-canvas `RoverController` listens on this counter; on bump it
   * builds a fresh random path for the currently-selected event class
   * and starts driving the rover from `t = 0`. Bumping (rather than
   * writing the path itself) keeps the path closure off zustand's
   * structural-clone path — RNG-bound closures don't survive `set`. */
  roverEpoch: number;
  bumpRoverEpoch: () => void;

  /** Reset the robot scene: regenerate a fresh procedurally-placed
   * obstacle field, clear pose / samples, and reset the runner state.
   * Also clears `armTargetId` so a stale target doesn't reference a
   * deleted scene object. */
  resetRobotScene: () => void;

  /** Chassis-frame IMU samples recorded during the in-progress (or
   * just-finished) rover run. Same 6-channel shape as motion mode —
   * accelerometer + gyroscope, body local. Cleared per iteration. */
  robotImuSamples: AccelSample[];
  pushRobotImuSample: (s: AccelSample) => void;
  clearRobotImuSamples: () => void;

  /** Joint-position samples recorded during an arm run. Each entry is
   * a timestamp + six-vector (M1..M6 in the same units the rest of
   * the arm code uses: joints 0..4 in radians, joint 5 normalized
   * gripper aperture). Populated by the BraccioArm IMU sampler at the
   * same cadence as `robotImuSamples`, so a ROS `JointState` message
   * series and the end-effector `Imu` series line up tick-for-tick.
   * Cleared per iteration alongside the IMU buffer. */
  armJointSamples: { t: number; joints: number[] }[];
  pushArmJointSample: (s: { t: number; joints: number[] }) => void;
  clearArmJointSamples: () => void;

  /** Per-iteration pick-and-place outcome observed from the MuJoCo target
   * body. The arm target renderer updates the max lift while the robot is
   * running; the panel snapshots it into EI metadata when the sample ends. */
  armPickupObservation: ArmPickupObservation | null;
  resetArmPickupObservation: (targetId: string | null) => void;
  observeArmPickupLift: (targetId: string, liftM: number) => void;
  observeArmPickupGrasp: (
    targetId: string,
    assessment: ArmPickupGraspAssessment,
  ) => void;

  /** True when the rover's contact detector reports overlap with at
   * least one obstacle this frame. The IMU sampler reads this to
   * inject a brief impulse along the contact axis (so the recorded
   * sample carries a real "collision" signature) and the runner uses
   * it to flag the recording's `event_observed` metadata. */
  roverInContact: boolean;
  setRoverInContact: (b: boolean) => void;

  /** Live joint angles for the Braccio arm, in radians. Six channels:
   * base yaw, shoulder, elbow, wrist pitch, wrist roll, gripper aperture
   * (0 = fully closed, 1 = fully open in the published spec mapping).
   * Null while no arm is active. */
  armJoints: [number, number, number, number, number, number] | null;
  setArmJoints: (j: State['armJoints']) => void;

  /** Bumped by the arm runner once per recording iteration to ask the
   * `ArmController` to start a fresh trajectory. Same pattern as
   * `roverEpoch`. */
  armEpoch: number;
  bumpArmEpoch: () => void;

  /** Bumped by the robot runner when it wants the POV camera bridge to
   * synchronously capture the current frame for object-detection. The
   * actual blob + bounding boxes flow back through the Promise queue
   * in `lib/robotCapture.ts` — this counter is just the "trigger"
   * edge the bridge component listens on. */
  robotCaptureSignal: number;
  triggerRobotCapture: () => void;

  /** ID of the scene object the arm is currently targeting for
   * pick-and-place. Null when no target is selected. The arm picks
   * one randomly per iteration when `pick_place` is the trajectory
   * class. */
  armTargetId: string | null;
  setArmTargetId: (id: string | null) => void;

  // ---------- Selection ----------
  /** IDs of currently-selected scene objects (primitives + imported
   * assets). The keyboard handler in Scene.tsx rotates this selection
   * around Y when `[` or `]` is pressed. Empty array = no selection,
   * in which case the rotation hotkeys fall back to operating on every
   * spawned object in the active mode pool. */
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  toggleSelectedId: (id: string) => void;
  clearSelection: () => void;

  // ---------- Scene (detection/anomaly) ----------
  sceneObjects: SceneObject[];
  addSceneObject: (
    kind: ObjectKind,
    label?: string,
    owner?: SceneObjectOwner,
  ) => void;
  /** Like `addSceneObject` but tuned for the Braccio arm — small
   * (~3 cm cube), placed on the table at a random arm-reachable
   * radius. Auto-tags the object with `owner: 'arm'` so it appears
   * only in the arm scene and the arm panel's pickup-target list.
   * Returns the new object's id so the caller can target it for
   * pick-and-place. */
  addArmPickupTarget: (kind?: ObjectKind, label?: string) => string;
  /** Re-sample a random reachable position for every arm-owned pickup
   * object, including imported USDZ assets. Primitive object positions
   * stay at their center (y = 0.015 for the default 3 cm cube); imported
   * assets keep their floor-origin convention (y = 0). xz is drawn
   * uniformly from the Braccio's
   * reachable workspace (radius 8–18 cm, base-yaw half-circle
   * 0–π). Called by the BraccioArm controller on each iteration when
   * `armRandomizeTarget` is on. */
  randomizeArmPickupPositions: (rng?: () => number) => void;
  removeSceneObject: (id: string) => void;
  updateSceneObject: (id: string, patch: Partial<SceneObject>) => void;
  clearSceneObjects: () => void;

  showConveyor: boolean;
  setShowConveyor: (b: boolean) => void;
  conveyorSpeed: number;
  setConveyorSpeed: (n: number) => void;

  /** Visual environment preset — swaps the floor material and optionally
   * adds back walls for more realistic synthetic backgrounds. */
  envPreset: EnvPreset;
  setEnvPreset: (p: EnvPreset) => void;

  /** Metadata for user-uploaded floor / wall textures. The actual image
   * bytes live in IndexedDB (`textureStore.ts`); persisting just the file
   * name here keeps the localStorage payload tiny while letting the UI
   * show "Floor: my_oak.jpg" and the rehydrate path know to load from
   * IDB. `null` means "use the procedural texture for the active env
   * preset". A non-null value forces walls to render even on presets
   * that wouldn't normally show them, so the upload isn't silently
   * invisible. */
  customFloorTexture: { name: string } | null;
  setCustomFloorTexture: (t: { name: string } | null) => void;
  customWallTexture: { name: string } | null;
  setCustomWallTexture: (t: { name: string } | null) => void;

  // Imported USDZ assets
  assets: ImportedAsset[];
  addAsset: (a: ImportedAsset) => void;
  removeAsset: (id: string) => void;
  updateAsset: (id: string, patch: Partial<ImportedAsset>) => void;
  clearAssets: () => void;

  /** Asset metadata pulled from localStorage on startup, waiting for the
   * USDZ rehydration hook to fetch the matching `.usdz` blob from IDB,
   * call `loadUsdz()`, and convert each entry into a live `ImportedAsset`
   * via `addAsset`. The hook clears this once it finishes. We persist
   * metadata here rather than in `assets` because `assets` carries live
   * three.js / WASM objects that can't be JSON-serialized. */
  pendingAssets: PersistedAsset[];
  setPendingAssets: (a: PersistedAsset[]) => void;

  /** Live progress for the post-reload USDZ rehydrate. `phase: 'busy'`
   * means the rehydrate hook is walking pendingAssets and re-running
   * loadUsdz against each stored blob; `done` increments per restored
   * asset. `phase: 'success'` is held briefly after the loop finishes
   * so the HUD pill flashes confirmation before disappearing.
   * `phase: 'idle'` hides the pill. */
  restoringAssets: {
    done: number;
    total: number;
    phase: 'idle' | 'busy' | 'success';
  };
  setRestoringAssets: (p: {
    done: number;
    total: number;
    phase: 'idle' | 'busy' | 'success';
  }) => void;

  // ---------- Virtual camera & capture ----------
  capture: CaptureSettings;
  setCapture: (patch: Partial<CaptureSettings>) => void;
  captures: Capture[];
  addCapture: (c: Capture) => void;
  removeCapture: (id: string) => void;
  clearCaptures: () => void;
  // signal counter to trigger captures from CaptureViewport
  captureSignal: number;
  triggerCapture: () => void;
  batchSignal: number;
  triggerBatch: () => void;

  // anomaly batch label
  anomalyLabel: string;
  setAnomalyLabel: (s: string) => void;

  /** Synthetic-IMU noise model parameters (MathWorks `imuSensor`-style:
   * Allan-variance noise density, bias instability, scale-factor
   * error, dynamic range, ADC quantization). Applied to every IMU
   * sample produced by motion mode, the rover chassis sampler, and
   * the arm end-effector sampler. Toggle off to get the clean
   * underlying inertial reading. */
  imuNoise: ImuNoiseConfig;
  setImuNoise: (patch: Partial<ImuNoiseConfig>) => void;

  /** Realism post-process applied to every captured PNG before EI
   * upload / local zip. See `RealismConfig` and `lib/realism.ts`. */
  realism: RealismConfig;
  setRealism: (patch: Partial<RealismConfig>) => void;

  // ---------- Edge Impulse ----------
  ei: EdgeImpulseConfig;
  setEi: (patch: Partial<EdgeImpulseConfig>) => void;

  status: { kind: 'idle' | 'ok' | 'err' | 'busy'; msg: string };
  setStatus: (kind: State['status']['kind'], msg: string) => void;

  /** Persisted open/closed state for every CollapsibleCard. Keyed by a
   * stable string (each card's `storageKey` prop, falling back to the
   * heading text for cards with stable headings). Undefined entries
   * fall back to the card's `defaultOpen` prop on first render, then
   * track the user's toggling thereafter — so re-opening a card you
   * collapsed survives a reload. */
  cardOpen: Record<string, boolean>;
  setCardOpen: (key: string, open: boolean) => void;

  // ---------- Inference (Edge Impulse local model) ----------
  /** Loaded EI model, if any. Hidden from devtools to avoid serializing the
   * Emscripten module. */
  eiModel: LoadedEiModel | null;
  eiModelInfo: EiModelInfo | null;
  eiModelName: string | null;
  setEiModel: (m: LoadedEiModel | null, name?: string | null) => void;
  /** Confidence threshold for showing detection boxes (0..1). */
  eiThreshold: number;
  setEiThreshold: (n: number) => void;
  /** Live inference toggle — when on, we run on the preview at PREVIEW_HZ. */
  eiLive: boolean;
  setEiLive: (b: boolean) => void;
  /** Latest result, used to drive the overlay. */
  eiResult: EiResult | null;
  setEiResult: (r: EiResult | null) => void;
  /** Bumped to request a one-shot inference run on the next preview frame. */
  inferenceSignal: number;
  triggerInference: () => void;
};

const defaultObject = (kind: ObjectKind, idx: number): SceneObject => {
  const isCan = kind === 'soda_can';
  return {
    id: crypto.randomUUID(),
    kind,
    label: kind,
    // Spawn above belt-top + a little headroom so they fall onto whatever
    // surface is under them. Two columns at x = ±0.4 keep every spawn
    // within the belt's ±0.8 inner-rail extent (BELT_WIDTH/2 = 0.8 in
    // beltDynamics) so the conveyor actually carries them — the previous
    // 5-column ±1.8 spread dropped 4 of every 5 objects onto the floor
    // beside the belt, where the user saw them sit still while the belt
    // texture scrolled past, looking like a texture-vs-body speed bug.
    position: [(idx % 2) * 0.8 - 0.4, 1.2, Math.floor(idx / 2) * -0.9],
    rotation: [0, Math.random() * Math.PI * 2, 0],
    scale: 1,
    color: isCan
      ? '#dc2626'
      : ['#f59e0b', '#38bdf8', '#a78bfa', '#34d399', '#f472b6'][idx % 5],
    metalness: isCan ? 0.85 : 0.2,
    roughness: isCan ? 0.25 : 0.5,
    physics: true,
  };
};

const OLD_BRACCIO_REST_RAD: [
  number,
  number,
  number,
  number,
  number,
  number,
] = [
  Math.PI / 2,
  Math.PI / 2,
  Math.PI / 2,
  Math.PI / 2,
  Math.PI / 2,
  0.5,
];

function isPose(
  pose: unknown,
  expected: [number, number, number, number, number, number],
): boolean {
  return (
    Array.isArray(pose) &&
    pose.length === expected.length &&
    pose.every(
      (v, i) =>
        typeof v === 'number' && Math.abs(v - expected[i]) < 1e-9,
    )
  );
}

export const useStore = create<State>()(
  persist(
    (set) => ({
  mode: 'motion',
  setMode: (m) => set({ mode: m }),

  // motion
  objectKind: 'cube',
  setObjectKind: (k) => set({ objectKind: k }),
  isGrabbed: false,
  setGrabbed: (b) => set({ isGrabbed: b }),
  pinchTarget: null,
  setPinchTarget: (p) => set({ pinchTarget: p }),

  pinchRotation: null,
  setPinchRotation: (q) => set({ pinchRotation: q }),
  isRecording: false,
  startRecording: () => set({ isRecording: true, samples: [] }),
  stopRecording: () => set({ isRecording: false }),
  samples: [],
  pushSample: (s) =>
    set((state) =>
      state.isRecording ? { samples: [...state.samples, s] } : state,
    ),
  clearSamples: () => set({ samples: [] }),
  sampleRateHz: 100,
  setSampleRateHz: (n) => set({ sampleRateHz: n }),
  handDetected: false,
  setHandDetected: (b) => set({ handDetected: b }),
  handMappingScale: 1,
  setHandMappingScale: (n) => set({ handMappingScale: n }),
  pinchStrength: 0,
  setPinchStrength: (n) => set({ pinchStrength: n }),
  handTrackingEnabled: true,
  setHandTrackingEnabled: (b) => set({ handTrackingEnabled: b }),

  nextReleaseAngVel: null,
  setNextReleaseAngVel: (v) => set({ nextReleaseAngVel: v }),

  drops: {
    count: 10,
    heightMin: 1.0,
    heightMax: 2.5,
    durationMs: 1500,
    motion: 'drop',
    throwSpeed: 4,
    pushSpeed: 3,
    shakeFreq: 4.5,
    shakeAmp: 0.2,
  },
  setDrops: (patch) => set((s) => ({ drops: { ...s.drops, ...patch } })),
  dropsRunning: false,
  setDropsRunning: (b) => set({ dropsRunning: b }),
  dropsCancelRequested: false,
  setDropsCancelRequested: (b) => set({ dropsCancelRequested: b }),

  // robot
  robot: {
    kind: 'rover',
    roverEvent: 'cruise',
    armTrajectory: 'pick_place',
    count: 10,
    durationMs: 3000,
    lidarBins: 16,
    lidarMaxRange: 6,
    uploadModality: 'fused',
    rosExport: false,
    armHomePose: [...BRACCIO_REST_RAD],
    armCameraMount: 'wrist',
    armRandomizeTarget: false,
    objectDetection: false,
    captureAtRest: false,
    objectDetectionWidth: 640,
    objectDetectionHeight: 480,
    objectDetectionImagesPerIteration: 1,
  },
  setRobot: (patch) => set((s) => ({ robot: { ...s.robot, ...patch } })),
  robotRunning: false,
  setRobotRunning: (b) => set({ robotRunning: b }),
  robotCancelRequested: false,
  setRobotCancelRequested: (b) => set({ robotCancelRequested: b }),
  robotCaptures: 0,
  bumpRobotCaptures: () => set((s) => ({ robotCaptures: s.robotCaptures + 1 })),
  resetRobotCaptures: () => set({ robotCaptures: 0 }),
  lidarSamples: [],
  pushLidarSample: (s) =>
    set((state) =>
      state.robotRunning ? { lidarSamples: [...state.lidarSamples, s] } : state,
    ),
  clearLidarSamples: () => set({ lidarSamples: [] }),
  roverPose: null,
  setRoverPose: (p) => set({ roverPose: p }),
  roverEpoch: 0,
  bumpRoverEpoch: () => set((s) => ({ roverEpoch: s.roverEpoch + 1 })),

  resetRobotScene: () => {
    set((state) => {
      // Drop only the current-kind's objects so the user's other-mode
      // setup survives a Reset (a rover scene reset shouldn't wipe
      // arm pickup targets, and vice-versa). Vision-mode objects
      // (no owner) are also preserved.
      const kind = state.robot.kind;
      return {
        robot:
          kind === 'arm'
            ? { ...state.robot, armHomePose: [...BRACCIO_REST_RAD] }
            : state.robot,
        sceneObjects: state.sceneObjects.filter((o) => o.owner !== kind),
        roverPose: null,
        lidarSamples: [],
        robotImuSamples: [],
        armJoints: null,
        armTargetId: null,
        armPickupObservation: null,
        roverInContact: false,
        robotCancelRequested: false,
        robotCaptures: 0,
      };
    });
  },

  robotImuSamples: [],
  pushRobotImuSample: (s) =>
    set((state) =>
      state.robotRunning
        ? { robotImuSamples: [...state.robotImuSamples, s] }
        : state,
    ),
  clearRobotImuSamples: () => set({ robotImuSamples: [] }),
  armJointSamples: [],
  pushArmJointSample: (s) =>
    set((state) =>
      state.robotRunning
        ? { armJointSamples: [...state.armJointSamples, s] }
        : state,
    ),
  clearArmJointSamples: () => set({ armJointSamples: [] }),
  armPickupObservation: null,
  resetArmPickupObservation: (targetId) =>
    set({ armPickupObservation: createArmPickupObservation(targetId) }),
  observeArmPickupLift: (targetId, liftM) =>
    set((state) => {
      const next = updateArmPickupObservation(
        state.armPickupObservation,
        targetId,
        liftM,
      );
      return next === state.armPickupObservation
        ? state
        : { armPickupObservation: next };
    }),
  observeArmPickupGrasp: (targetId, assessment) =>
    set((state) => {
      const next = updateArmPickupGraspAssessment(
        state.armPickupObservation,
        targetId,
        assessment,
      );
      return next === state.armPickupObservation
        ? state
        : { armPickupObservation: next };
    }),
  roverInContact: false,
  setRoverInContact: (b) => set({ roverInContact: b }),

  armJoints: null,
  setArmJoints: (j) => set({ armJoints: j }),
  armEpoch: 0,
  bumpArmEpoch: () => set((s) => ({ armEpoch: s.armEpoch + 1 })),
  robotCaptureSignal: 0,
  triggerRobotCapture: () =>
    set((s) => ({ robotCaptureSignal: s.robotCaptureSignal + 1 })),
  armTargetId: null,
  setArmTargetId: (id) => set({ armTargetId: id }),

  // selection
  selectedIds: [],
  setSelectedIds: (ids) => set({ selectedIds: ids }),
  toggleSelectedId: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id],
    })),
  clearSelection: () => set({ selectedIds: [] }),

  // scene
  sceneObjects: [],
  addSceneObject: (kind, label, owner) =>
    set((s) => {
      const obj = defaultObject(kind, s.sceneObjects.length);
      if (label) obj.label = label;
      if (owner) obj.owner = owner;
      return { sceneObjects: [...s.sceneObjects, obj] };
    }),
  addArmPickupTarget: (kind = 'cube', label) => {
    // Place targets on a 12 cm radial ring around the arm base on
    // the floor, so they're inside the Braccio's reachable workspace
    // (the IK clamps to a ~25 cm reach). Targets get their own
    // counter-based angle so successive spawns don't overlap.
    const state = useStore.getState();
    const id = crypto.randomUUID();
    const idx = state.sceneObjects.length;
    // Cube is 3 cm by default — a credible "EI sticker block" the
    // published Braccio demos use. Scale field on SceneObject scales
    // the default 0.6 m cube, so 3 cm = scale 0.05.
    const radius = 0.14;
    const angle = (idx * 0.5 + 0.4) % (Math.PI * 2);
    const obj: SceneObject = {
      id,
      kind,
      label: label ?? 'pickup',
      position: [
        Math.sin(angle) * radius,
        // Half a 3 cm cube above the floor so its bottom rests on
        // y=0 (same convention as the existing detection scene).
        0.015,
        Math.cos(angle) * radius,
      ],
      rotation: [0, Math.random() * Math.PI * 2, 0],
      scale: 0.05,
      color: '#5eead4',
      metalness: 0.2,
      roughness: 0.4,
      // Default to physics ON so the arm can actually knock the
      // target around — the user asked for vision-mode parity.
      physics: true,
      owner: 'arm',
    };
    set((s) => ({ sceneObjects: [...s.sceneObjects, obj] }));
    return id;
  },
  randomizeArmPickupPositions: (rng = Math.random) => {
    // The Braccio's reachable workspace is a half-annulus in front of
    // the base. Sample (radius ∈ [0.11, 0.22], angle ∈ [0, π]) and
    // convert to xz. Angle == 0 puts the target along +z; angle == π
    // puts it along -z. Y stays at half the cube extent so the body
    // rests on the floor with zero penetration. Each arm-owned object
    // gets an independent draw — when the user has several, they
    // spread out instead of stacking.
    //
    // Range derivation:
    //   - R_MIN = 0.11: outside the 0.08 m base plate (plus a small
    //     gap) so the cube doesn't visually sit on / inside the arm
    //     mount when randomized.
    //   - R_MAX = 0.22: just inside the IK reach envelope for a
    //     gripper tip near the floor. The reachable annulus given
    //     shoulder = elbow = 0.125 m and wrist-to-tip = 0.16 m caps
    //     at √(0.25² − 0.074²) ≈ 0.238 m radially when the tip is at
    //     y ≈ 0; 0.22 leaves headroom so IK doesn't run flat against
    //     the workspace boundary.
    const R_MIN = 0.11;
    const R_MAX = 0.22;
    const nextFloorPosition = (): [number, number, number] => {
      const radius = R_MIN + rng() * (R_MAX - R_MIN);
      const angle = rng() * Math.PI;
      return [Math.sin(angle) * radius, 0, Math.cos(angle) * radius];
    };
    set((s) => ({
      sceneObjects: s.sceneObjects.map((o) => {
        if (o.owner !== 'arm') return o;
        const [x, , z] = nextFloorPosition();
        return {
          ...o,
          position: [x, 0.015, z],
        };
      }),
      assets: s.assets.map((a) =>
        a.owner === 'arm'
          ? { ...a, position: nextFloorPosition() }
          : a,
      ),
    }));
  },
  removeSceneObject: (id) =>
    set((s) => ({
      sceneObjects: s.sceneObjects.filter((o) => o.id !== id),
      selectedIds: s.selectedIds.filter((sid) => sid !== id),
    })),
  updateSceneObject: (id, patch) =>
    set((s) => ({
      sceneObjects: s.sceneObjects.map((o) =>
        o.id === id ? { ...o, ...patch } : o,
      ),
    })),
  clearSceneObjects: () => set({ sceneObjects: [], selectedIds: [] }),

  showConveyor: false,
  setShowConveyor: (b) => set({ showConveyor: b }),
  conveyorSpeed: 0.5,
  setConveyorSpeed: (n) => set({ conveyorSpeed: n }),

  envPreset: 'studio',
  setEnvPreset: (p) => set({ envPreset: p }),

  customFloorTexture: null,
  setCustomFloorTexture: (t) => set({ customFloorTexture: t }),
  customWallTexture: null,
  setCustomWallTexture: (t) => set({ customWallTexture: t }),

  assets: [],
  addAsset: (a) => set((s) => ({ assets: [...s.assets, a] })),
  removeAsset: (id) => {
    void deleteAssetBlob(id).catch(() => {});
    set((s) => ({ assets: s.assets.filter((a) => a.id !== id) }));
  },
  updateAsset: (id, patch) =>
    set((s) => ({
      assets: s.assets.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    })),
  clearAssets: () => {
    void clearAssetBlobs().catch(() => {});
    set({ assets: [] });
  },

  pendingAssets: [],
  setPendingAssets: (a) => set({ pendingAssets: a }),

  restoringAssets: { done: 0, total: 0, phase: 'idle' },
  setRestoringAssets: (p) => set({ restoringAssets: p }),

  // capture
  capture: {
    width: 640,
    height: 480,
    camPos: [3.5, 3, 3.5],
    camTarget: [0, 0.5, 0],
    fov: 45,
    randomizeCamera: true,
    randomizeLighting: true,
    randomizeObjects: false,
    batchCount: 10,
    lightIntensity: 1.1,
    envRotation: 0,
    cameraTrajectory: 'random',
    trajectoryRadius: 4,
    trajectoryHeight: 2,
  },
  setCapture: (patch) => set((s) => ({ capture: { ...s.capture, ...patch } })),
  captures: [],
  addCapture: (c) => set((s) => ({ captures: [...s.captures, c] })),
  removeCapture: (id) =>
    set((s) => ({ captures: s.captures.filter((c) => c.id !== id) })),
  clearCaptures: () => set({ captures: [] }),
  captureSignal: 0,
  triggerCapture: () => set((s) => ({ captureSignal: s.captureSignal + 1 })),
  batchSignal: 0,
  triggerBatch: () => set((s) => ({ batchSignal: s.batchSignal + 1 })),

  anomalyLabel: 'normal',
  setAnomalyLabel: (s) => set({ anomalyLabel: s }),

  // IMU noise (MathWorks-style)
  imuNoise: { ...DEFAULT_IMU_NOISE },
  setImuNoise: (patch) =>
    set((s) => ({ imuNoise: { ...s.imuNoise, ...patch } })),

  // Realism post-process. Defaults off so the existing pipeline is
  // bit-for-bit unchanged unless the user opts in.
  realism: { ...DEFAULT_REALISM },
  setRealism: (patch) =>
    set((s) => ({ realism: { ...s.realism, ...patch } })),

  // EI
  ei: {
    apiKey: '',
    hmacKey: '',
    category: 'training',
    label: 'idle',
    device: 'synthetic-hand-3d',
  },
  setEi: (patch) => set((s) => ({ ei: { ...s.ei, ...patch } })),

  status: { kind: 'idle', msg: '' },
  setStatus: (kind, msg) => set({ status: { kind, msg } }),

  cardOpen: {},
  setCardOpen: (key, open) =>
    set((s) => ({ cardOpen: { ...s.cardOpen, [key]: open } })),

  // inference
  eiModel: null,
  eiModelInfo: null,
  eiModelName: null,
  setEiModel: (m, name) =>
    set({
      eiModel: m,
      eiModelInfo: m?.info ?? null,
      eiModelName: m ? name ?? null : null,
      eiResult: null,
    }),
  eiThreshold: 0.5,
  setEiThreshold: (n) => set({ eiThreshold: n }),
  eiLive: false,
  setEiLive: (b) => set({ eiLive: b }),
  eiResult: null,
  setEiResult: (r) => set({ eiResult: r }),
      inferenceSignal: 0,
      triggerInference: () => set((s) => ({ inferenceSignal: s.inferenceSignal + 1 })),
    }),
    {
      name: 'sds-store',
      version: 12,
      storage: createJSONStorage(() => localStorage),
      migrate: (persistedState, version) => {
        if (
          !persistedState ||
          typeof persistedState !== 'object'
        ) {
          return persistedState;
        }
        let state = persistedState as Partial<State>;
        // v3 → v4: reset stale Braccio rest poses to the new default.
        if (version < 4) {
          const robot = state.robot;
          if (
            robot &&
            robot.armHomePose &&
            isPose(robot.armHomePose, OLD_BRACCIO_REST_RAD)
          ) {
            state = {
              ...state,
              robot: {
                ...robot,
                armHomePose: [...BRACCIO_REST_RAD],
              },
            };
          }
        }
        // v4 → v5: backfill the new `armRandomizeTarget` toggle so users
        // whose persisted `robot` was saved before this field existed
        // get a usable default instead of an `undefined` that breaks the
        // toggle UI.
        if (version < 5 && state.robot) {
          state = {
            ...state,
            robot: {
              ...state.robot,
              armRandomizeTarget: state.robot.armRandomizeTarget ?? false,
            },
          };
        }
        // v5 → v6: backfill the object-detection toggles + capture size
        // so the new robot-mode object-detection UI gets sensible
        // defaults instead of `undefined` (which leaves the switch
        // visually neither on nor off).
        if (version < 6 && state.robot) {
          state = {
            ...state,
            robot: {
              ...state.robot,
              objectDetection: state.robot.objectDetection ?? false,
              captureAtRest: state.robot.captureAtRest ?? false,
              objectDetectionWidth: state.robot.objectDetectionWidth ?? 640,
              objectDetectionHeight: state.robot.objectDetectionHeight ?? 480,
            },
          };
        }
        // v6 → v7: backfill the per-iteration image count so the new
        // input has a usable default (1) instead of `undefined`.
        if (version < 7 && state.robot) {
          state = {
            ...state,
            robot: {
              ...state.robot,
              objectDetectionImagesPerIteration:
                state.robot.objectDetectionImagesPerIteration ?? 1,
            },
          };
        }
        // v7 → v8: introduce the realism post-process config. Default
        // is off so an upgraded user sees no change unless they opt in.
        // The intermediate v8 shape had `{ mode, intensity }`; the
        // v9→v10 step below normalizes it to the current per-effect
        // shape, so the cast here is safe.
        if (version < 8) {
          state = {
            ...state,
            realism:
              state.realism ??
              ({ mode: 'off', intensity: 0.5 } as unknown as RealismConfig),
          };
        }
        // v8 → v9: hide the Diffusion radio while server-side img2img
        // is still being figured out. Coerce any persisted 'diffusion'
        // mode to 'random' so the picker doesn't end up with an
        // invisible-selected state (the radio is gone but the
        // intensity slider would still be visible).
        if (version < 9 && state.realism?.mode === 'diffusion') {
          state = {
            ...state,
            realism: { ...state.realism, mode: 'random' },
          };
        }
        // v9 → v10: split the single `realism.intensity` knob into
        // five per-effect knobs (grain / chromatic / vignette / jitter
        // / jpeg). Backfill all five from the old `intensity` so an
        // upgraded user sees roughly the same output until they dial
        // in individual sliders.
        if (version < 10 && state.realism) {
          // The old shape had `intensity: number`; if for some reason
          // that's missing or invalid, fall back to the default 0.5
          // so the per-effect knobs don't end up undefined / NaN.
          const legacy = state.realism as Partial<RealismConfig> & {
            intensity?: number;
          };
          const seed =
            typeof legacy.intensity === 'number' ? legacy.intensity : 0.5;
          state = {
            ...state,
            realism: {
              mode: legacy.mode ?? 'off',
              grain: legacy.grain ?? seed,
              chromatic: legacy.chromatic ?? seed,
              vignette: legacy.vignette ?? seed * 0.6,
              jitter: legacy.jitter ?? seed,
              jpeg: legacy.jpeg ?? seed,
              randomize: false,
            },
          };
        }
        // v10 → v11: introduce the `randomize` toggle. Default off so
        // an upgraded user sees deterministic per-capture output until
        // they opt into per-capture variation.
        if (version < 11 && state.realism) {
          state = {
            ...state,
            realism: {
              ...state.realism,
              randomize: state.realism.randomize ?? false,
            },
          };
        }
        // v11 → v12: backfill the new camera-trajectory fields so the
        // batch UI doesn't read `undefined` for users with persisted
        // capture settings.
        if (version < 12 && state.capture) {
          state = {
            ...state,
            capture: {
              ...state.capture,
              cameraTrajectory:
                state.capture.cameraTrajectory ?? 'random',
              trajectoryRadius: state.capture.trajectoryRadius ?? 4,
              trajectoryHeight: state.capture.trajectoryHeight ?? 2,
            },
          };
        }
        return state;
      },
      // Persist only the bits worth restoring: scene primitives, scene
      // settings, capture config, mode, and asset *metadata* (the live
      // three.js Group + needle handle aren't JSON-friendly, so we map
      // each `ImportedAsset` to its `PersistedAsset` shape and bin them
      // into `pendingAssets` for the rehydrate hook to pick up).
      partialize: (s) => ({
        mode: s.mode,
        objectKind: s.objectKind,
        sceneObjects: s.sceneObjects,
        showConveyor: s.showConveyor,
        conveyorSpeed: s.conveyorSpeed,
        envPreset: s.envPreset,
        customFloorTexture: s.customFloorTexture,
        customWallTexture: s.customWallTexture,
        capture: s.capture,
        anomalyLabel: s.anomalyLabel,
        sampleRateHz: s.sampleRateHz,
        drops: s.drops,
        robot: s.robot,
        imuNoise: s.imuNoise,
        realism: s.realism,
        eiThreshold: s.eiThreshold,
        cardOpen: s.cardOpen,
        pendingAssets: s.assets.map<PersistedAsset>((a) => ({
          id: a.id,
          name: a.name,
          label: a.label,
          position: a.position,
          rotation: a.rotation,
          scale: a.scale,
          physics: a.physics,
          overrideMaterial: a.overrideMaterial,
          overrideColor: a.overrideColor,
          overrideRoughness: a.overrideRoughness,
          overrideMetalness: a.overrideMetalness,
          isAnimated: a.isAnimated,
          animationPlaying: a.animationPlaying,
          bounds: a.bounds,
          owner: a.owner,
        })),
      }),
    },
  ),
);

if (typeof window !== 'undefined') {
  // Dev-only handle for inspecting transient store fields (`lidarSamples`,
  // `roverPose`, …) that aren't persisted to localStorage. Useful in
  // the browser console when debugging robotics-mode samplers; never
  // referenced by app code, so it tree-shakes out of production builds
  // for everything except the assignment itself (a few bytes).
  (window as unknown as { __useStore?: typeof useStore }).__useStore = useStore;
}
