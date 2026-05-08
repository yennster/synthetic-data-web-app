import { useEffect, useRef, useState } from 'react';
import {
  createHandLandmarker,
  computePinchStrength,
  handSize,
  pinchCentroid,
} from '../lib/handTracking';
import type { HandLandmarker } from '@mediapipe/tasks-vision';
import { useStore } from '../store/useStore';
import { TouchResizeHandle } from './TouchResizeHandle';

const PINCH_ON = 0.65;
const PINCH_OFF = 0.45;

const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export function CameraFeed() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const grabRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  // When the hand briefly disappears, keep the last grab+target alive for a
  // grace period so a tiny tracking dropout doesn't make the held object fall.
  const lastSeenMs = useRef(0);
  const HAND_LOST_GRACE_MS = 350;
  // Smoothed scene-space pinch target. We low-pass MediaPipe's noisy output
  // so the cursor moves steadily instead of jittering, and so brief tracking
  // dropouts don't snap the target to (null) → cube falls.
  const smoothedTarget = useRef<[number, number, number] | null>(null);

  const setHandDetected = useStore((s) => s.setHandDetected);
  const setPinchStrength = useStore((s) => s.setPinchStrength);
  const setGrabbed = useStore((s) => s.setGrabbed);
  const setPinchTarget = useStore((s) => s.setPinchTarget);

  // Mobile front-cameras often ignore the requested 640×480 and deliver
  // a portrait stream (e.g. 480×640). Read the actual frame size after
  // metadata loads and apply that aspect ratio to the container so the
  // video isn't stretched and the hand-tracking canvas (drawn in video
  // pixel coords) stays aligned with what the user sees.
  const [videoAspect, setVideoAspect] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' },
          audio: false,
        });
        if (cancelled || !videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      } catch (e) {
        console.error('Camera error', e);
        useStore
          .getState()
          .setStatus('err', `Camera: ${(e as Error).message}`);
        return;
      }

      try {
        landmarkerRef.current = await createHandLandmarker();
      } catch (e) {
        console.error('HandLandmarker error', e);
        useStore
          .getState()
          .setStatus('err', `Hand model: ${(e as Error).message}`);
        return;
      }

      const tick = () => {
        if (cancelled) return;
        rafRef.current = requestAnimationFrame(tick);
        const video = videoRef.current;
        const canvas = canvasRef.current;
        const lm = landmarkerRef.current;
        if (!video || !canvas || !lm || video.readyState < 2) return;

        const result = lm.detectForVideo(video, performance.now());
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        if (canvas.width !== video.videoWidth) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (result.landmarks.length > 0) {
          const hand = result.landmarks[0];
          const pinch = computePinchStrength(hand);
          const c = pinchCentroid(hand);

          setHandDetected(true);
          setPinchStrength(pinch);
          lastSeenMs.current = performance.now();

          // hysteresis on pinch
          if (!grabRef.current && pinch > PINCH_ON) {
            grabRef.current = true;
            setGrabbed(true);
          } else if (grabRef.current && pinch < PINCH_OFF) {
            grabRef.current = false;
            setGrabbed(false);
          }

          // Mirror x because video is flipped for natural interaction.
          // Scene mapping:
          //   x: ±3 across the webcam frame
          //   y: ground level near c.y=0.85 down to ~3 high near c.y=0.05
          //      so a small downward motion of the hand actually reaches the
          //      cube on the ground (was much harder before with the previous
          //      mapping that maxed out at y=1)
          //   z: derived from hand size (wrist→middle-MCP) — closer hand =
          //      bigger landmark spread, so push the held object toward the
          //      camera. Far more stable than MediaPipe's per-landmark z.
          //      H_NEUTRAL is roughly the wrist-MCP separation observed at a
          //      comfortable arm distance from a laptop webcam; H_RANGE
          //      (~0.04 each direction) covers full reach without saturating.
          const H_NEUTRAL = 0.13;
          const H_RANGE = 0.06;
          const rawX = (1 - c.x - 0.5) * 6;
          const rawY = (0.85 - c.y) * 5;
          const rawZ = Math.max(
            -2.5,
            Math.min(2.5, ((handSize(hand) - H_NEUTRAL) / H_RANGE) * 2.5),
          );

          // Exponential smoothing. Z is now hand-size based (much steadier
          // than MediaPipe's per-landmark z) so it can match X/Y.
          const A_XY = 0.35;
          const A_Z = 0.3;
          const prev = smoothedTarget.current;
          const sx = prev ? prev[0] + (rawX - prev[0]) * A_XY : rawX;
          const sy = prev ? prev[1] + (rawY - prev[1]) * A_XY : rawY;
          const sz = prev ? prev[2] + (rawZ - prev[2]) * A_Z : rawZ;
          smoothedTarget.current = [sx, sy, sz];
          setPinchTarget([sx, sy, sz]);

          // Draw skeleton
          ctx.lineWidth = 2;
          ctx.strokeStyle = pinch > PINCH_ON ? '#5eead4' : '#38bdf8';
          ctx.beginPath();
          for (const [a, b] of HAND_CONNECTIONS) {
            ctx.moveTo(hand[a].x * canvas.width, hand[a].y * canvas.height);
            ctx.lineTo(hand[b].x * canvas.width, hand[b].y * canvas.height);
          }
          ctx.stroke();

          ctx.fillStyle = pinch > PINCH_ON ? '#5eead4' : '#f0f6fc';
          for (const p of hand) {
            ctx.beginPath();
            ctx.arc(p.x * canvas.width, p.y * canvas.height, 3, 0, Math.PI * 2);
            ctx.fill();
          }

          // Pinch indicator at centroid
          ctx.strokeStyle = '#ef4444';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(
            c.x * canvas.width,
            c.y * canvas.height,
            10 + pinch * 14,
            0,
            Math.PI * 2,
          );
          ctx.stroke();
        } else {
          // Hand not detected this frame. If we just lost it (within the
          // grace window), keep the held object frozen at its last target
          // instead of releasing — small dropouts shouldn't drop the cube.
          setHandDetected(false);
          const sinceSeen = performance.now() - lastSeenMs.current;
          if (sinceSeen > HAND_LOST_GRACE_MS) {
            setPinchStrength(0);
            if (grabRef.current) {
              grabRef.current = false;
              setGrabbed(false);
            }
            setPinchTarget(null);
            smoothedTarget.current = null;
          }
          // else: leave isGrabbed and pinchTarget intact; physics body keeps
          // following the last smoothed target.
        }
      };

      rafRef.current = requestAnimationFrame(tick);
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (landmarkerRef.current) {
        landmarkerRef.current.close();
        landmarkerRef.current = null;
      }
      if (stream) {
        for (const t of stream.getTracks()) t.stop();
      }
    };
  }, [setGrabbed, setHandDetected, setPinchStrength, setPinchTarget]);

  return (
    <div
      className="cam-overlay resizable cam-feed"
      style={videoAspect ? { aspectRatio: `${videoAspect}` } : undefined}
    >
      <span className="label">Webcam · hand tracking · drag ↘</span>
      <video
        ref={videoRef}
        muted
        playsInline
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (v.videoWidth > 0 && v.videoHeight > 0) {
            setVideoAspect(v.videoWidth / v.videoHeight);
          }
        }}
      />
      <canvas ref={canvasRef} />
      <TouchResizeHandle />
    </div>
  );
}
