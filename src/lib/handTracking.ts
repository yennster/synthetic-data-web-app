import {
  HandLandmarker,
  FilesetResolver,
  type HandLandmarkerResult,
} from '@mediapipe/tasks-vision';

// Re-export the pure helpers from handMath so existing call sites
// (CameraFeed.tsx, tests) keep working through this module.
export { computePinchStrength, pinchCentroid } from './handMath';

export type HandFrame = {
  detected: boolean;
  pinch: number; // 0..1, 1 = fully closed
  // Normalized pinch centroid in [0,1] image coords (mirrored x = 1 - raw)
  px: number;
  py: number;
  pz: number; // mediapipe relative depth (~ -0.2 .. 0.2 typical)
  landmarks?: HandLandmarkerResult['landmarks'][number];
};

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const WASM_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';

export async function createHandLandmarker(): Promise<HandLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  return HandLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}
