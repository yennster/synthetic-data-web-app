import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Group } from 'three';
import type { NeedleThreeHydraHandle } from '@needle-tools/usd';
import { clearAssetBlobs, deleteAssetBlob } from '../lib/assetStore';
import type { EiModelInfo, EiResult, LoadedEiModel } from '../lib/eiModel';
import { generateObstacles } from '../lib/rover';
import {
  ALL_ARM_TRAJECTORIES as _ALL_ARM_TRAJECTORIES,
  type ArmTrajectory as _ArmTrajectory,
} from '../lib/armTrajectories';
import {
  DEFAULT_IMU_NOISE,
  type ImuNoiseConfig,
} from '../lib/imuNoise';

export type ObjectKind =
  | 'cube'
  | 'sphere'
  | 'phone'
  | 'capsule'
  | 'cylinder'
  | 'cone'
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

/** Procedurally-placed obstacle disc. The renderer picks a visual
 * shape (pillar / crate / cone) deterministically from `id`, so the
 * same disc list reproduces the same scene; the planner / contact
 * detector only ever look at (x, z, r). */
export type RobotObstacle = {
  id: string;
  x: number;
  z: number;
  r: number;
};

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
  physics: boolean;
  overrideMaterial: boolean;
  overrideColor: string;
  overrideRoughness: number;
  overrideMetalness: number;
  isAnimated: boolean;
  animationPlaying: boolean;
};

// A spawned object in the scene, used in detection / anomaly modes.
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
};

export type BoundingBox = {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
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
    /** When true, "Randomize obstacles" reruns the procedural placer
     * before each recording iteration so the obstacle field varies
     * across the batch. When false, the field is fixed (good for
     * reproducible debugging). */
    randomizeObstaclesEachRun: boolean;
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
    /** Vertical offset applied to the arm's root group, in meters.
     * The Braccio is rendered as a chain whose bottom is the
     * mounting plate; with `armMountHeight = 0` the plate sits on
     * the floor and joint poses can dip below y=0 (intersecting the
     * grid). A non-zero value lifts the arm onto a virtual table —
     * 0.4 m is a typical lab-bench height. The pickup-target spawner
     * uses the same offset so targets land on the same surface. */
    armMountHeight: number;
  };
  setRobot: (patch: Partial<State['robot']>) => void;
  /** True while a procedural robot run is active. */
  robotRunning: boolean;
  setRobotRunning: (b: boolean) => void;
  robotCancelRequested: boolean;
  setRobotCancelRequested: (b: boolean) => void;
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

  /** Live obstacle field for robotics mode. The disc descriptors here
   * drive both the visual rendering (in `RobotObstacles`) and the
   * lidar / planner / contact detector. Stored as ordinary state so
   * the user can drag obstacles around and so "Randomize obstacles"
   * just rewrites the array. */
  robotObstacles: RobotObstacle[];
  setRobotObstacles: (o: RobotObstacle[]) => void;
  updateRobotObstacle: (id: string, patch: Partial<RobotObstacle>) => void;
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

  /** ID of the scene object the arm is currently targeting for
   * pick-and-place. Null when no target is selected. The arm picks
   * one randomly per iteration when `pick_place` is the trajectory
   * class. */
  armTargetId: string | null;
  setArmTargetId: (id: string | null) => void;

  // ---------- Scene (detection/anomaly) ----------
  sceneObjects: SceneObject[];
  addSceneObject: (kind: ObjectKind, label?: string) => void;
  /** Like `addSceneObject` but tuned for the Braccio arm — small
   * (~3 cm cube), placed on the table at a random arm-reachable
   * radius. Avoids the human-scale defaults in `defaultObject`,
   * which puts a 60 cm cube floating 1.2 m off the floor and reads
   * absurd next to a 30 cm arm. Returns the new object's id so the
   * caller can target it for pick-and-place. */
  addArmPickupTarget: (kind?: ObjectKind, label?: string) => string;
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

  // ---------- Edge Impulse ----------
  ei: EdgeImpulseConfig;
  setEi: (patch: Partial<EdgeImpulseConfig>) => void;

  status: { kind: 'idle' | 'ok' | 'err' | 'busy'; msg: string };
  setStatus: (kind: State['status']['kind'], msg: string) => void;

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
    randomizeObstaclesEachRun: false,
    uploadModality: 'fused',
    rosExport: false,
    armMountHeight: 0.4,
  },
  setRobot: (patch) => set((s) => ({ robot: { ...s.robot, ...patch } })),
  robotRunning: false,
  setRobotRunning: (b) => set({ robotRunning: b }),
  robotCancelRequested: false,
  setRobotCancelRequested: (b) => set({ robotCancelRequested: b }),
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

  robotObstacles: generateObstacles(7, 4.0, 0.6).map((o, i) => ({
    id: `obs-${i}`,
    ...o,
  })),
  setRobotObstacles: (o) => set({ robotObstacles: o }),
  updateRobotObstacle: (id, patch) =>
    set((s) => ({
      robotObstacles: s.robotObstacles.map((o) =>
        o.id === id ? { ...o, ...patch } : o,
      ),
    })),
  resetRobotScene: () => {
    const fresh = generateObstacles(7, 4.0, 0.6).map((o, i) => ({
      id: `obs-${Date.now()}-${i}`,
      ...o,
    }));
    set({
      robotObstacles: fresh,
      roverPose: null,
      lidarSamples: [],
      robotImuSamples: [],
      armJoints: null,
      armTargetId: null,
      roverInContact: false,
      robotCancelRequested: false,
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
  roverInContact: false,
  setRoverInContact: (b) => set({ roverInContact: b }),

  armJoints: null,
  setArmJoints: (j) => set({ armJoints: j }),
  armEpoch: 0,
  bumpArmEpoch: () => set((s) => ({ armEpoch: s.armEpoch + 1 })),
  armTargetId: null,
  setArmTargetId: (id) => set({ armTargetId: id }),

  // scene
  sceneObjects: [],
  addSceneObject: (kind, label) =>
    set((s) => {
      const obj = defaultObject(kind, s.sceneObjects.length);
      if (label) obj.label = label;
      return { sceneObjects: [...s.sceneObjects, obj] };
    }),
  addArmPickupTarget: (kind = 'cube', label) => {
    // Place targets on a 12 cm radial ring around the arm base, on
    // whatever virtual table the arm is mounted on, so they're inside
    // the Braccio's reachable workspace (the IK clamps to a ~25 cm
    // reach). Targets get their own counter-based angle so successive
    // spawns don't overlap.
    const state = useStore.getState();
    const id = crypto.randomUUID();
    const idx = state.sceneObjects.length;
    const mountY = state.robot.armMountHeight;
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
        // Place the cube so its bottom rests on the table top
        // (mount height + plate thickness ≈ mountY + 0.015) — half
        // a 3 cm cube above that puts its center at mountY + 0.03.
        mountY + 0.03,
        Math.cos(angle) * radius,
      ],
      rotation: [0, Math.random() * Math.PI * 2, 0],
      scale: 0.05,
      color: '#5eead4',
      metalness: 0.2,
      roughness: 0.4,
      // Default to physics ON so the arm can actually knock the
      // target around — the user asked for vision-mode parity, and
      // the static-only behavior was an arm-specific limitation.
      physics: true,
    };
    set((s) => ({ sceneObjects: [...s.sceneObjects, obj] }));
    return id;
  },
  removeSceneObject: (id) =>
    set((s) => ({ sceneObjects: s.sceneObjects.filter((o) => o.id !== id) })),
  updateSceneObject: (id, patch) =>
    set((s) => ({
      sceneObjects: s.sceneObjects.map((o) =>
        o.id === id ? { ...o, ...patch } : o,
      ),
    })),
  clearSceneObjects: () => set({ sceneObjects: [] }),

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
      version: 2,
      storage: createJSONStorage(() => localStorage),
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
        robotObstacles: s.robotObstacles,
        imuNoise: s.imuNoise,
        eiThreshold: s.eiThreshold,
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
