import {
  HandLandmarker,
  FilesetResolver,
  type HandLandmarkerResult,
} from '@mediapipe/tasks-vision';

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

// Pinch strength based on thumb-tip (4) vs index-tip (8) distance,
// normalized by hand size (wrist 0 to middle MCP 9).
export function computePinchStrength(
  lm: HandLandmarkerResult['landmarks'][number],
): number {
  const t = lm[4];
  const i = lm[8];
  const w = lm[0];
  const mcp = lm[9];
  const dist = Math.hypot(t.x - i.x, t.y - i.y, (t.z ?? 0) - (i.z ?? 0));
  const handSize =
    Math.hypot(w.x - mcp.x, w.y - mcp.y, (w.z ?? 0) - (mcp.z ?? 0)) || 0.1;
  const ratio = dist / handSize; // ~1.0 = open, ~0.2 = pinched
  // Map: ratio 0.15 -> 1.0 (closed), 0.6 -> 0.0 (open)
  const v = 1 - (ratio - 0.15) / 0.45;
  return Math.max(0, Math.min(1, v));
}

export function pinchCentroid(
  lm: HandLandmarkerResult['landmarks'][number],
): { x: number; y: number; z: number } {
  const t = lm[4];
  const i = lm[8];
  return {
    x: (t.x + i.x) / 2,
    y: (t.y + i.y) / 2,
    z: ((t.z ?? 0) + (i.z ?? 0)) / 2,
  };
}
