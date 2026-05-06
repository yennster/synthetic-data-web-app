import { useEffect, useRef } from 'react';
import {
  createHandLandmarker,
  computePinchStrength,
  pinchCentroid,
} from '../lib/handTracking';
import type { HandLandmarker } from '@mediapipe/tasks-vision';
import { useStore } from '../store/useStore';

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

  const setHandDetected = useStore((s) => s.setHandDetected);
  const setPinchStrength = useStore((s) => s.setPinchStrength);
  const setGrabbed = useStore((s) => s.setGrabbed);
  const setPinchTarget = useStore((s) => s.setPinchTarget);

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

          // hysteresis on pinch
          if (!grabRef.current && pinch > PINCH_ON) {
            grabRef.current = true;
            setGrabbed(true);
          } else if (grabRef.current && pinch < PINCH_OFF) {
            grabRef.current = false;
            setGrabbed(false);
          }

          // Mirror x because video is flipped for natural interaction.
          // Map normalized image coords to scene coords.
          // Scene x: -3..3, y: -1.5..3.5, z: depth ~ -0.5..1.5
          const sx = (1 - c.x - 0.5) * 6; // mirrored
          const sy = (0.5 - c.y) * 5 + 1; // higher = up
          const sz = -c.z * 8; // mediapipe z (smaller = closer)
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
          setHandDetected(false);
          setPinchStrength(0);
          if (grabRef.current) {
            grabRef.current = false;
            setGrabbed(false);
          }
          setPinchTarget(null);
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
    <div className="cam-overlay">
      <span className="label">Webcam · hand tracking</span>
      <video ref={videoRef} muted playsInline />
      <canvas ref={canvasRef} />
    </div>
  );
}
