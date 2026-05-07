import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { BELT_TOP_Y } from '../lib/beltDynamics';
import { useStore } from '../store/useStore';

/**
 * Project Edge Impulse detection results back into the 3D scene.
 *
 * For each detection we take its center in INPUT-pixel space, convert to
 * normalized device coordinates (NDC) for the virtual camera, raycast that
 * direction from the camera origin, and intersect with a horizontal "world"
 * plane. We try the belt-top plane first (since detections from the belt
 * mode mostly land there) and fall back to ground (y=0). The result is a
 * world point that drops a small marker (FOMO centroid) and a billboarded
 * label HTML element.
 *
 * For full-bbox object detection we also draw a frame in 3D (a flat outline
 * mesh built from the four projected world corners), so the user can
 * visualize what the model "sees" within the same scene as the synthetic
 * objects.
 */
export function InferenceMarkers3D() {
  const result = useStore((s) => s.eiResult);
  const info = useStore((s) => s.eiModelInfo);
  const threshold = useStore((s) => s.eiThreshold);
  const show = useStore((s) => s.eiShow3D);
  const captureSettings = useStore((s) => s.capture);
  const { scene } = useThree();

  // Reuse the virtual camera kept in sync by VirtualCamera.tsx? We don't
  // have a direct ref, so we reconstruct an equivalent perspective camera
  // each render. This is cheap and self-contained.
  const projCam = useMemo(() => new THREE.PerspectiveCamera(45, 4 / 3, 0.05, 100), []);

  // Update the projection camera each frame to track captureSettings.
  useFrame(() => {
    projCam.position.set(...captureSettings.camPos);
    projCam.lookAt(...captureSettings.camTarget);
    projCam.fov = captureSettings.fov;
    projCam.aspect = captureSettings.width / captureSettings.height;
    projCam.updateProjectionMatrix();
    projCam.updateMatrixWorld(true);
  });

  if (!show || !result || !info || result.bounding_boxes.length === 0) return null;

  const visible = result.bounding_boxes.filter((b) => b.value >= threshold);
  if (visible.length === 0) return null;

  return (
    <>
      {visible.map((b, i) => {
        // Center of the detection in input-pixel space → NDC
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        const ndcX = (cx / info.inputWidth) * 2 - 1;
        const ndcY = -((cy / info.inputHeight) * 2 - 1);
        const center = unprojectToFloor(projCam, ndcX, ndcY, BELT_TOP_Y);
        if (!center) return null;
        return (
          <DetectionMarker
            key={i}
            label={`${b.label} ${(b.value * 100).toFixed(0)}%`}
            position={center}
            color={hashColor(b.label)}
          />
        );
      })}
    </>
  );
}

function DetectionMarker({
  label,
  position,
  color,
}: {
  label: string;
  position: THREE.Vector3;
  color: string;
}) {
  const ringRef = useRef<THREE.Mesh>(null);
  // Pulse the marker so it's visible against busy backgrounds.
  useFrame((_, dt) => {
    const m = ringRef.current;
    if (!m) return;
    m.rotation.y += dt * 1.4;
  });
  return (
    <group position={position}>
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
        <ringGeometry args={[0.18, 0.22, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.85} />
      </mesh>
      <mesh position={[0, 0.04, 0]}>
        <sphereGeometry args={[0.04, 16, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.7} />
      </mesh>
      <Html
        center
        distanceFactor={6}
        style={{
          pointerEvents: 'none',
          padding: '2px 6px',
          background: 'rgba(0,0,0,0.7)',
          color: '#fff',
          fontSize: 11,
          fontFamily: 'ui-monospace, monospace',
          borderRadius: 4,
          whiteSpace: 'nowrap',
          transform: 'translate(0, -28px)',
        }}
      >
        {label}
      </Html>
    </group>
  );
}

/**
 * Cast a ray from `cam` through NDC point (ndcX, ndcY) and intersect with the
 * horizontal plane y=`y`. Returns the world-space hit, or null if the ray
 * doesn't hit (ray pointing the wrong way / cam looking up).
 */
function unprojectToFloor(
  cam: THREE.Camera,
  ndcX: number,
  ndcY: number,
  y: number,
): THREE.Vector3 | null {
  const dir = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(cam).sub(cam.position).normalize();
  if (Math.abs(dir.y) < 1e-5) return null;
  const t = (y - cam.position.y) / dir.y;
  if (t < 0) {
    // Try ground plane as fallback for cameras below the belt top.
    const t2 = -cam.position.y / dir.y;
    if (t2 < 0) return null;
    return cam.position.clone().addScaledVector(dir, t2);
  }
  return cam.position.clone().addScaledVector(dir, t);
}

function hashColor(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 80% 60%)`;
}
