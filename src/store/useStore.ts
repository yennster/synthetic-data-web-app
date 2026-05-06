import { create } from 'zustand';
import type { Group } from 'three';

export type ObjectKind = 'cube' | 'sphere' | 'phone' | 'capsule' | 'cylinder' | 'cone' | 'torus';

export type AppMode = 'motion' | 'detection' | 'anomaly';

export type AccelSample = {
  t: number;
  ax: number;
  ay: number;
  az: number;
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
};

export type EdgeImpulseConfig = {
  apiKey: string;
  hmacKey: string;
  category: 'training' | 'testing';
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
};

const defaultObject = (kind: ObjectKind, idx: number): SceneObject => ({
  id: crypto.randomUUID(),
  kind,
  label: kind,
  // Spawn above belt-top + a little headroom so they fall onto whatever
  // surface is under them (belt or ground) without interpenetrating.
  position: [(idx % 5) * 0.9 - 1.8, 1.2, Math.floor(idx / 5) * -0.9],
  rotation: [0, Math.random() * Math.PI * 2, 0],
  scale: 1,
  color: ['#f59e0b', '#38bdf8', '#a78bfa', '#34d399', '#f472b6'][idx % 5],
  metalness: 0.2,
  roughness: 0.5,
});

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
}));
