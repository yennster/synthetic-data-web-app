import { create } from 'zustand';

export type ObjectKind = 'cube' | 'sphere' | 'phone' | 'capsule';

export type AccelSample = {
  t: number;
  ax: number;
  ay: number;
  az: number;
};

export type EdgeImpulseConfig = {
  apiKey: string;
  hmacKey: string;
  category: 'training' | 'testing';
  label: string;
  device: string;
};

type State = {
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

  ei: EdgeImpulseConfig;
  setEi: (patch: Partial<EdgeImpulseConfig>) => void;

  status: { kind: 'idle' | 'ok' | 'err' | 'busy'; msg: string };
  setStatus: (kind: State['status']['kind'], msg: string) => void;

  handDetected: boolean;
  setHandDetected: (b: boolean) => void;
  pinchStrength: number;
  setPinchStrength: (n: number) => void;
};

export const useStore = create<State>((set) => ({
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

  handDetected: false,
  setHandDetected: (b) => set({ handDetected: b }),
  pinchStrength: 0,
  setPinchStrength: (n) => set({ pinchStrength: n }),
}));
