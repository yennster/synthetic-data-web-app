import { create } from 'zustand';
import type { Group } from 'three';
import type { USDZInstance } from 'three-usdz-loader/lib/USDZInstance';
import type { EiModelInfo, EiResult, LoadedEiModel } from '../lib/eiModel';

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

export type AppMode = 'motion' | 'detection' | 'anomaly';

/** Procedural motion generator class. Each kind is recorded as its own
 * label so EI receives correctly-classed training data. */
export type MotionKind = 'drop' | 'throw' | 'push' | 'shake';

export const ALL_MOTION_KINDS: MotionKind[] = [
  'drop',
  'throw',
  'push',
  'shake',
];

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
  /** Live USD instance — held so we can call `update(seconds)` per frame to
   * play baked time-sample animation (Apple's animated AR Quick Look
   * samples, etc.). Null for assets imported before this field existed. */
  instance?: USDZInstance | null;
  /** Set at import time when the underlying stage has authored time samples
   * (endTimeCode > startTimeCode). Drives the play/pause UI. */
  isAnimated: boolean;
  /** When true and `isAnimated`, the renderer advances animation each frame.
   * Toggled from the asset's play/pause control in the panel. */
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

  // ---------- Scene (detection/anomaly) ----------
  sceneObjects: SceneObject[];
  addSceneObject: (kind: ObjectKind, label?: string) => void;
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

  // Imported USDZ assets
  assets: ImportedAsset[];
  addAsset: (a: ImportedAsset) => void;
  removeAsset: (id: string) => void;
  updateAsset: (id: string, patch: Partial<ImportedAsset>) => void;
  clearAssets: () => void;

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

  // FS Access directory handle (Chromium only)
  saveDirHandle: any | null;
  setSaveDirHandle: (h: any | null) => void;

  // anomaly batch label
  anomalyLabel: string;
  setAnomalyLabel: (s: string) => void;

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
    // surface is under them (belt or ground) without interpenetrating.
    position: [(idx % 5) * 0.9 - 1.8, 1.2, Math.floor(idx / 5) * -0.9],
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

export const useStore = create<State>((set) => ({
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

  // scene
  sceneObjects: [],
  addSceneObject: (kind, label) =>
    set((s) => {
      const obj = defaultObject(kind, s.sceneObjects.length);
      if (label) obj.label = label;
      return { sceneObjects: [...s.sceneObjects, obj] };
    }),
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

  assets: [],
  addAsset: (a) => set((s) => ({ assets: [...s.assets, a] })),
  removeAsset: (id) =>
    set((s) => ({ assets: s.assets.filter((a) => a.id !== id) })),
  updateAsset: (id, patch) =>
    set((s) => ({
      assets: s.assets.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    })),
  clearAssets: () => set({ assets: [] }),

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

  saveDirHandle: null,
  setSaveDirHandle: (h) => set({ saveDirHandle: h }),

  anomalyLabel: 'normal',
  setAnomalyLabel: (s) => set({ anomalyLabel: s }),

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
}));
