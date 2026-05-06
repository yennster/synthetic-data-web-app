import { Canvas, useFrame } from '@react-three/fiber';
import { Environment, Grid, OrbitControls } from '@react-three/drei';
import {
  Physics,
  RigidBody,
  CuboidCollider,
  type RapierRigidBody,
} from '@react-three/rapier';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useStore, type ObjectKind } from '../store/useStore';

const GRAVITY: [number, number, number] = [0, -9.81, 0];
const FOLLOW_LERP = 0.35; // 0..1 smoothing for kinematic follow

function ManipulatedObject() {
  const bodyRef = useRef<RapierRigidBody>(null);
  const meshRef = useRef<THREE.Mesh>(null);

  // Rolling state for physics + sampling
  const prevLinvel = useRef(new THREE.Vector3());
  const prevPos = useRef(new THREE.Vector3(0, 2, 0));
  const sampleAccumulator = useRef(0);
  const wasGrabbed = useRef(false);
  const releaseVel = useRef(new THREE.Vector3());

  const objectKind = useStore((s) => s.objectKind);

  useFrame((_, dt) => {
    const body = bodyRef.current;
    if (!body) return;

    const { isGrabbed, pinchTarget, sampleRateHz, isRecording, pushSample } =
      useStore.getState();

    // ---- Manipulation: follow pinch when grabbed ----
    if (isGrabbed && pinchTarget) {
      // Make sure we're kinematic while grabbed
      if (body.bodyType() !== 2 /* KinematicPositionBased */) {
        body.setBodyType(2, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }

      const cur = body.translation();
      const target = new THREE.Vector3(...pinchTarget);
      const next = new THREE.Vector3(cur.x, cur.y, cur.z).lerp(
        target,
        FOLLOW_LERP,
      );
      body.setNextKinematicTranslation({ x: next.x, y: next.y, z: next.z });

      // Track velocity so we can impart it on release
      releaseVel.current.set(
        (next.x - prevPos.current.x) / Math.max(dt, 1e-3),
        (next.y - prevPos.current.y) / Math.max(dt, 1e-3),
        (next.z - prevPos.current.z) / Math.max(dt, 1e-3),
      );
      prevPos.current.copy(next);
      wasGrabbed.current = true;
    } else {
      // Just released? swap to dynamic + impart velocity
      if (wasGrabbed.current) {
        body.setBodyType(0 /* Dynamic */, true);
        body.setLinvel(
          {
            x: releaseVel.current.x,
            y: releaseVel.current.y,
            z: releaseVel.current.z,
          },
          true,
        );
        wasGrabbed.current = false;
      }
      const cur = body.translation();
      prevPos.current.set(cur.x, cur.y, cur.z);
    }

    // ---- Accelerometer sampling at fixed rate ----
    const period = 1 / sampleRateHz;
    sampleAccumulator.current += dt;
    while (sampleAccumulator.current >= period) {
      sampleAccumulator.current -= period;
      const lv = body.linvel();
      const cur = new THREE.Vector3(lv.x, lv.y, lv.z);
      // Inertial acceleration (world frame)
      const aInertial = cur
        .clone()
        .sub(prevLinvel.current)
        .divideScalar(period);
      // Proper acceleration (what an accelerometer reads)
      // a_proper = a_inertial - g_world
      const aProper = aInertial.sub(
        new THREE.Vector3(GRAVITY[0], GRAVITY[1], GRAVITY[2]),
      );
      // Transform to body-local frame
      const rot = body.rotation();
      const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w).invert();
      aProper.applyQuaternion(q);

      prevLinvel.current.copy(cur);

      if (isRecording) {
        pushSample({
          t: performance.now(),
          ax: aProper.x,
          ay: aProper.y,
          az: aProper.z,
        });
      }
    }
  });

  // Reset on object kind change
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.setTranslation({ x: 0, y: 2, z: 0 }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  }, [objectKind]);

  return (
    <RigidBody
      ref={bodyRef}
      colliders="hull"
      restitution={0.45}
      friction={0.6}
      position={[0, 2, 0]}
      linearDamping={0.05}
      angularDamping={0.1}
    >
      <ObjectMesh kind={objectKind} meshRef={meshRef} />
    </RigidBody>
  );
}

function ObjectMesh({
  kind,
  meshRef,
}: {
  kind: ObjectKind;
  meshRef: React.RefObject<THREE.Mesh>;
}) {
  const isGrabbed = useStore((s) => s.isGrabbed);
  const color = isGrabbed ? '#5eead4' : '#f59e0b';
  const emissive = isGrabbed ? '#0d4d44' : '#3d2706';

  const material = useMemo(
    () => (
      <meshStandardMaterial
        color={color}
        emissive={emissive}
        roughness={0.4}
        metalness={0.2}
      />
    ),
    [color, emissive],
  );

  switch (kind) {
    case 'sphere':
      return (
        <mesh ref={meshRef} castShadow>
          <sphereGeometry args={[0.5, 32, 32]} />
          {material}
        </mesh>
      );
    case 'phone':
      return (
        <mesh ref={meshRef} castShadow>
          <boxGeometry args={[0.7, 1.4, 0.1]} />
          {material}
        </mesh>
      );
    case 'capsule':
      return (
        <mesh ref={meshRef} castShadow>
          <capsuleGeometry args={[0.35, 0.8, 8, 16]} />
          {material}
        </mesh>
      );
    case 'cube':
    default:
      return (
        <mesh ref={meshRef} castShadow>
          <boxGeometry args={[0.8, 0.8, 0.8]} />
          {material}
        </mesh>
      );
  }
}

function Ground() {
  return (
    <RigidBody type="fixed" colliders={false} friction={0.8} restitution={0.3}>
      <CuboidCollider args={[20, 0.1, 20]} position={[0, -0.1, 0]} />
      <mesh position={[0, -0.1, 0]} receiveShadow>
        <boxGeometry args={[40, 0.2, 40]} />
        <meshStandardMaterial color="#1c2128" roughness={0.9} />
      </mesh>
    </RigidBody>
  );
}

function PinchMarker() {
  const target = useStore((s) => s.pinchTarget);
  const grabbed = useStore((s) => s.isGrabbed);
  if (!target) return null;
  return (
    <mesh position={target}>
      <sphereGeometry args={[0.06, 16, 16]} />
      <meshBasicMaterial
        color={grabbed ? '#5eead4' : '#38bdf8'}
        transparent
        opacity={0.7}
      />
    </mesh>
  );
}

export function Scene() {
  return (
    <Canvas
      shadows
      camera={{ position: [0, 2.5, 6], fov: 50 }}
      style={{ background: 'linear-gradient(180deg, #0b0d10 0%, #14181d 100%)' }}
    >
      <ambientLight intensity={0.4} />
      <directionalLight
        position={[5, 8, 4]}
        intensity={1.1}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
      />
      <Environment preset="city" />
      <Grid
        position={[0, 0.001, 0]}
        args={[20, 20]}
        cellSize={0.5}
        cellThickness={0.5}
        cellColor="#2a313a"
        sectionSize={2}
        sectionThickness={1}
        sectionColor="#3d4651"
        fadeDistance={20}
        fadeStrength={1}
        infiniteGrid
      />
      <Physics gravity={GRAVITY}>
        <Ground />
        <ManipulatedObject />
      </Physics>
      <PinchMarker />
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.1}
        minDistance={3}
        maxDistance={15}
        target={[0, 1, 0]}
      />
    </Canvas>
  );
}
