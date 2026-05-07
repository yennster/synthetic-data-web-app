import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  ContactShadows,
  Environment,
  Grid,
  OrbitControls,
  SoftShadows,
} from '@react-three/drei';
import {
  Physics,
  RigidBody,
  type RapierRigidBody,
} from '@react-three/rapier';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useStore, type ObjectKind } from '../store/useStore';
import { Conveyor } from './Conveyor';
import { ImportedAssets } from './ImportedAssets';
import { InferenceMarkers3D } from './InferenceMarkers3D';
import { SceneEnvironment } from './SceneEnvironment';
import { SpawnedObjects } from './SpawnedObjects';
import { VirtualCamera } from './VirtualCamera';

const GRAVITY: [number, number, number] = [0, -9.81, 0];
const FOLLOW_LERP = 0.35;

function backgroundForPreset(preset: string): string {
  switch (preset) {
    case 'whitebox':
      return 'linear-gradient(180deg, #f5f5f2 0%, #e8e8e3 100%)';
    case 'outdoor':
      return 'linear-gradient(180deg, #87b9d8 0%, #c4d9e8 100%)';
    case 'warehouse':
      return 'linear-gradient(180deg, #2a2620 0%, #1a1612 100%)';
    case 'studio':
    default:
      return 'linear-gradient(180deg, #0b0d10 0%, #14181d 100%)';
  }
}

/** Solid color used as `scene.background` so it shows up in both the
 * live render AND captured frames. The CSS gradient on the canvas div
 * still drives the visible look in the main view, but for offscreen
 * captures the GL renderer needs an explicit clear color. */
function sceneBackgroundColor(preset: string): string {
  switch (preset) {
    case 'whitebox':
      return '#eeeeea';
    case 'outdoor':
      return '#a3cae1';
    case 'warehouse':
      return '#1f1c18';
    case 'studio':
    default:
      return '#0e1115';
  }
}

// ---------- Motion-mode body ----------
function ManipulatedObject() {
  const bodyRef = useRef<RapierRigidBody>(null);
  const meshRef = useRef<THREE.Mesh>(null);

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

    if (isGrabbed && pinchTarget) {
      if (body.bodyType() !== 2) {
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
      releaseVel.current.set(
        (next.x - prevPos.current.x) / Math.max(dt, 1e-3),
        (next.y - prevPos.current.y) / Math.max(dt, 1e-3),
        (next.z - prevPos.current.z) / Math.max(dt, 1e-3),
      );
      prevPos.current.copy(next);
      wasGrabbed.current = true;
    } else {
      if (wasGrabbed.current) {
        body.setBodyType(0, true);
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

    const period = 1 / sampleRateHz;
    sampleAccumulator.current += dt;
    while (sampleAccumulator.current >= period) {
      sampleAccumulator.current -= period;
      const lv = body.linvel();
      const cur = new THREE.Vector3(lv.x, lv.y, lv.z);
      const aInertial = cur.clone().sub(prevLinvel.current).divideScalar(period);
      const aProper = aInertial.sub(
        new THREE.Vector3(GRAVITY[0], GRAVITY[1], GRAVITY[2]),
      );
      const rot = body.rotation();
      // Inverse body rotation maps world-frame vectors into the body's
      // local frame — used both for the proper-acceleration readout and
      // for the gyroscope (rapier's angvel is reported in world frame).
      const qInv = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w).invert();
      aProper.applyQuaternion(qInv);
      const av = body.angvel();
      const angVelLocal = new THREE.Vector3(av.x, av.y, av.z).applyQuaternion(qInv);
      prevLinvel.current.copy(cur);

      if (isRecording) {
        pushSample({
          t: performance.now(),
          ax: aProper.x,
          ay: aProper.y,
          az: aProper.z,
          gx: angVelLocal.x,
          gy: angVelLocal.y,
          gz: angVelLocal.z,
        });
      }
    }
  });

  // Collider auto-shape is immutable on a RigidBody, so switching kinds
  // (cube ↔ phone ↔ sphere) needs a fresh body to get the right collider.
  // The `key` below remounts on kind change, which also resets the body's
  // pose to the position prop — no separate translation reset needed.
  const collider: 'cuboid' | 'ball' | 'hull' =
    objectKind === 'cube' || objectKind === 'phone'
      ? 'cuboid'
      : objectKind === 'sphere'
        ? 'ball'
        : 'hull';

  return (
    <RigidBody
      key={objectKind}
      ref={bodyRef}
      colliders={collider}
      restitution={0.45}
      friction={0.6}
      position={[0, 2, 0]}
      linearDamping={0.05}
      angularDamping={0.1}
      // Continuous collision detection so a fast release / lost-hand drop
      // doesn't tunnel through the thin ground plane.
      ccd
    >
      <ManipulatedMesh kind={objectKind} meshRef={meshRef} />
    </RigidBody>
  );
}

function ManipulatedMesh({
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
    case 'cylinder':
      return (
        <mesh ref={meshRef} castShadow>
          <cylinderGeometry args={[0.4, 0.4, 0.9, 24]} />
          {material}
        </mesh>
      );
    case 'cone':
      return (
        <mesh ref={meshRef} castShadow>
          <coneGeometry args={[0.5, 1.0, 24]} />
          {material}
        </mesh>
      );
    case 'torus':
      return (
        <mesh ref={meshRef} castShadow>
          <torusGeometry args={[0.4, 0.15, 16, 32]} />
          {material}
        </mesh>
      );
    case 'soda_can':
      return (
        <mesh ref={meshRef} castShadow>
          <cylinderGeometry args={[0.27, 0.27, 0.8, 32]} />
          {material}
        </mesh>
      );
    default:
      return (
        <mesh ref={meshRef} castShadow>
          <boxGeometry args={[0.8, 0.8, 0.8]} />
          {material}
        </mesh>
      );
  }
}

function SceneBackground({ color }: { color: string }) {
  const { scene } = useThree();
  useEffect(() => {
    scene.background = new THREE.Color(color);
  }, [scene, color]);
  return null;
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

// Env + key light driven by store so batch capture can randomize them.
function SceneLighting() {
  const intensity = useStore((s) => s.capture.lightIntensity);
  const envRot = useStore((s) => s.capture.envRotation);
  return (
    <>
      <ambientLight intensity={0.35} />
      <directionalLight
        position={[
          5 * Math.cos(envRot),
          8,
          5 * Math.sin(envRot),
        ]}
        intensity={intensity}
        castShadow
        shadow-mapSize-width={1536}
        shadow-mapSize-height={1536}
        shadow-camera-near={0.5}
        shadow-camera-far={30}
        shadow-camera-left={-10}
        shadow-camera-right={10}
        shadow-camera-top={10}
        shadow-camera-bottom={-10}
      />
      <Environment preset="warehouse" environmentIntensity={0.7} />
    </>
  );
}

function PreviewCanvasMount({
  setCanvas,
}: {
  setCanvas: (c: HTMLCanvasElement | null) => void;
}) {
  // hidden — actual canvas mounting happens in App via ref
  useEffect(() => () => setCanvas(null), [setCanvas]);
  return null;
}

export function Scene({
  previewCanvas,
}: {
  previewCanvas: HTMLCanvasElement | null;
}) {
  const mode = useStore((s) => s.mode);
  const showConveyor = useStore((s) => s.showConveyor);
  const envPreset = useStore((s) => s.envPreset);

  return (
    <Canvas
      shadows
      camera={{ position: [4, 3, 6], fov: 50 }}
      gl={{
        antialias: true,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.0,
      }}
      style={{ background: backgroundForPreset(envPreset) }}
    >
      <SoftShadows size={20} samples={12} />
      {/* Solid scene background so the off-screen capture renderer sees the
          same backdrop as the on-canvas preview (CSS body backgrounds don't
          carry into a fresh WebGLRenderer). Outdoor gets a sky-blue, the
          rest match their gradient's middle tone. Set imperatively via
          useThree because the `<color attach="background">` JSX form
          doesn't reconcile reliably across preset changes. */}
      <SceneBackground color={sceneBackgroundColor(envPreset)} />
      <SceneLighting />

      <Grid
        position={[0, 0.001, 0]}
        args={[30, 30]}
        cellSize={0.5}
        cellThickness={0.5}
        cellColor="#2a313a"
        sectionSize={2}
        sectionThickness={1}
        sectionColor="#3d4651"
        fadeDistance={30}
        fadeStrength={1}
        infiniteGrid
      />

      <ContactShadows
        position={[0, 0.005, 0]}
        opacity={0.5}
        scale={20}
        blur={2.5}
        far={10}
      />

      <Physics gravity={GRAVITY}>
        {/* Floor (and optional walls) — controlled by the env preset. The
            conveyor and any spawned objects sit on top of this. */}
        <SceneEnvironment preset={envPreset} />
        {mode === 'motion' ? (
          <>
            <ManipulatedObject />
            <PinchMarker />
          </>
        ) : (
          <>
            {showConveyor && <Conveyor />}
            <SpawnedObjects />
            <ImportedAssets />
          </>
        )}
      </Physics>

      {mode !== 'motion' && <VirtualCamera previewCanvas={previewCanvas} />}
      {mode !== 'motion' && <InferenceMarkers3D />}

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.1}
        minDistance={2}
        maxDistance={20}
        target={[0, 0.7, 0]}
      />
      <PreviewCanvasMount setCanvas={() => {}} />
    </Canvas>
  );
}
