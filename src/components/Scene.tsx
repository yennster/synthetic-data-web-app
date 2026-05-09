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
import {
  angularVelocityFromQuats as angVelFromQuats,
  cameraRelativeToWorld,
} from '../lib/handMath';
import { computeImuReading } from '../lib/imu';
import {
  applyImuNoise,
  makeImuNoiseState,
  type ImuNoiseState,
} from '../lib/imuNoise';
import { useStore, type ObjectKind } from '../store/useStore';
import { BraccioArm } from './BraccioArm';
import { Conveyor } from './Conveyor';
import { ImportedAssets } from './ImportedAssets';
import { RobotObstacles } from './RobotObstacles';
import { RobotPovCamera } from './RobotPovCamera';
import { Rover } from './Rover';
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

// Anchor at the world origin so the legacy hand-Y → world-Y mapping
// (hand low in frame ⇒ cube at ground) still holds.
const HAND_ANCHOR: [number, number, number] = [0, 0, 0];
const WORLD_UP: [number, number, number] = [0, 1, 0];

/**
 * Compute the world-space position for a hand-tracking pinchTarget by
 * applying a yaw-only camera basis around HAND_ANCHOR. Mutates and
 * returns `out` so callers can pre-allocate. The temporary `back` /
 * `right` vectors are also caller-owned to keep this allocation-free
 * inside useFrame loops.
 */
function pinchTargetToWorld(
  target: readonly [number, number, number],
  camera: THREE.Camera,
  back: THREE.Vector3,
  right: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  back
    .set(camera.position.x, 0, camera.position.z)
    .sub(new THREE.Vector3(HAND_ANCHOR[0], 0, HAND_ANCHOR[2]));
  if (back.lengthSq() < 1e-6) back.set(0, 0, 1);
  back.normalize();
  right.set(0, 1, 0).cross(back);
  const world = cameraRelativeToWorld(
    target,
    HAND_ANCHOR,
    right.toArray() as [number, number, number],
    WORLD_UP,
    back.toArray() as [number, number, number],
  );
  return out.set(world[0], world[1], world[2]);
}

/**
 * Camera-yaw angle around +Y, as the angle of the camera's projected
 * "back" vector (camera position → hand anchor, on the ground plane)
 * from world +Z. We compose this with the hand-derived `pinchRotation`
 * so orbiting the camera doesn't desync the held body's rotation from
 * the user's hand pose.
 */
function cameraYawAngle(camera: THREE.Camera): number {
  const dx = camera.position.x - HAND_ANCHOR[0];
  const dz = camera.position.z - HAND_ANCHOR[2];
  if (dx === 0 && dz === 0) return 0;
  return Math.atan2(dx, dz);
}

/**
 * Three.js wrapper around the pure `angVelFromQuats` helper — keeps the
 * unit tests in `handMath.test.ts` decoupled from three.js while letting
 * the per-frame loop reuse a single pre-allocated `Vector3` for the
 * world-frame angular velocity it returns.
 */
function angularVelocityFromQuats(
  qPrev: THREE.Quaternion,
  qCur: THREE.Quaternion,
  dt: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const w = angVelFromQuats(
    [qPrev.x, qPrev.y, qPrev.z, qPrev.w],
    [qCur.x, qCur.y, qCur.z, qCur.w],
    dt,
  );
  return out.set(w[0], w[1], w[2]);
}

// ---------- Motion-mode body ----------
function ManipulatedObject() {
  const bodyRef = useRef<RapierRigidBody>(null);
  const meshRef = useRef<THREE.Mesh>(null);

  const prevPos = useRef(new THREE.Vector3(0, 2, 0));
  const sampleAccumulator = useRef(0);
  const wasGrabbed = useRef(false);
  const releaseVel = useRef(new THREE.Vector3());

  // IMU sampling state — explicit pose history per sample period. We derive
  // linvel/angvel from these deltas instead of reading body.linvel/angvel,
  // because Rapier reports both as zero while the body is kinematic (held
  // by a pinch). With pose deltas the IMU stays correct in both kinematic
  // and dynamic phases — including a hand-driven rotation while pinched
  // and the entire procedural-shake recording window.
  const sampleInit = useRef(false);
  const prevSamplePos = useRef(new THREE.Vector3());
  const prevSampleQuat = useRef(new THREE.Quaternion());
  const prevSampleLinvel = useRef(new THREE.Vector3());
  // Per-IMU noise state (Allan-variance bias drift + per-axis scale
  // factor). Reset alongside `sampleInit` when the body is remounted
  // for a different shape so the bias doesn't carry between objects.
  const noiseState = useRef<ImuNoiseState | null>(null);

  const objectKind = useStore((s) => s.objectKind);

  // Reused per-frame to map hand-tracking input through pinchTargetToWorld
  // — see helper above for the math.
  const camBackH = useRef(new THREE.Vector3());
  const camRightH = useRef(new THREE.Vector3());
  const worldVec = useRef(new THREE.Vector3());
  // Reused per-sample scratch for IMU pose-delta math.
  const angVelWorld = useRef(new THREE.Vector3());
  // Reused per-frame scratch for camera-yaw composition of pinchRotation.
  const yawAxis = useRef(new THREE.Vector3(0, 1, 0));
  const yawQuat = useRef(new THREE.Quaternion());
  const handQuatScratch = useRef(new THREE.Quaternion());

  // Body remount (objectKind change) gives us a fresh body at a different
  // pose — drop the IMU history so we don't emit a one-sample velocity
  // spike from the pre-remount position. Also reset the synthetic
  // noise state so a fresh object gets its own bias-drift trajectory
  // and per-axis scale-factor errors.
  useEffect(() => {
    sampleInit.current = false;
    noiseState.current = null;
  }, [objectKind]);

  useFrame((state, dt) => {
    const body = bodyRef.current;
    if (!body) return;

    const {
      isGrabbed,
      pinchTarget,
      pinchRotation,
      sampleRateHz,
      isRecording,
      pushSample,
    } = useStore.getState();

    if (isGrabbed && pinchTarget) {
      if (body.bodyType() !== 2) {
        body.setBodyType(2, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
      const cur = body.translation();
      pinchTargetToWorld(
        pinchTarget,
        state.camera,
        camBackH.current,
        camRightH.current,
        worldVec.current,
      );
      const next = new THREE.Vector3(cur.x, cur.y, cur.z).lerp(
        worldVec.current,
        FOLLOW_LERP,
      );
      body.setNextKinematicTranslation({ x: next.x, y: next.y, z: next.z });
      if (pinchRotation) {
        // Compose with camera yaw so the held body's rotation tracks the
        // hand even after the user orbits the scene — same yaw basis as
        // the position mapping above.
        const yaw = cameraYawAngle(state.camera);
        yawQuat.current.setFromAxisAngle(yawAxis.current, yaw);
        handQuatScratch.current.set(
          pinchRotation[0],
          pinchRotation[1],
          pinchRotation[2],
          pinchRotation[3],
        );
        const composed = yawQuat.current.multiply(handQuatScratch.current);
        body.setNextKinematicRotation({
          x: composed.x,
          y: composed.y,
          z: composed.z,
          w: composed.w,
        });
      }
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
        // One-shot angular-velocity hint from the procedural-motion
        // runner. Without it, Rapier zeroes the kinematic body's angvel
        // on type-switch and a flat cube can land without any post-impact
        // torque — the gyroscope channel ends up flat at zero. Consume
        // and clear so a subsequent user-driven release isn't affected.
        const { nextReleaseAngVel, setNextReleaseAngVel } = useStore.getState();
        if (nextReleaseAngVel) {
          body.setAngvel(
            {
              x: nextReleaseAngVel[0],
              y: nextReleaseAngVel[1],
              z: nextReleaseAngVel[2],
            },
            true,
          );
          setNextReleaseAngVel(null);
        }
        wasGrabbed.current = false;
      }
      const cur = body.translation();
      prevPos.current.set(cur.x, cur.y, cur.z);
    }

    // IMU sampling.
    //
    // The previous version computed acceleration by *double* finite-
    // differencing the body's position (pos→linvel→accel, each over one
    // `period`) and ran a `while (accum >= period)` loop, so a 60 fps
    // render with a 100 Hz request would emit two samples per frame
    // sharing the same `body.translation()`. That collapsed every other
    // sample's linvel to zero and the second derivative spiked to
    // ±|V|/period — ~500 m/s² of pure aliasing on top of the real signal.
    //
    // Now: we read Rapier's integrator state (`body.linvel()`) when the
    // body is dynamic — that's smooth, drift-free, and only needs *one*
    // numerical differentiation to get acceleration. During kinematic
    // phases (held by a pinch, or driven by the procedural-motions
    // controller) Rapier reports linvel = 0, so we fall back to a single
    // position delta — same accuracy as before but only one division.
    //
    // We also emit at most one sample per frame and divide by the actual
    // elapsed time since the last sample, not the nominal period — that
    // removes the same-frame duplicate-emit aliasing entirely.
    const period = 1 / sampleRateHz;
    sampleAccumulator.current += dt;
    if (sampleAccumulator.current >= period) {
      const sampleDt = sampleAccumulator.current;
      sampleAccumulator.current = 0;

      const t = body.translation();
      const r = body.rotation();
      const curPos = new THREE.Vector3(t.x, t.y, t.z);
      const curQuat = new THREE.Quaternion(r.x, r.y, r.z, r.w);

      // First sample after init (or remount) seeds the history with no
      // emission — otherwise the apparent acceleration would jump from a
      // zero baseline.
      if (!sampleInit.current) {
        prevSamplePos.current.copy(curPos);
        prevSampleQuat.current.copy(curQuat);
        prevSampleLinvel.current.set(0, 0, 0);
        sampleInit.current = true;
        return;
      }

      const isDynamic = body.bodyType() === 0;
      const linvel = new THREE.Vector3();
      if (isDynamic) {
        const lv = body.linvel();
        linvel.set(lv.x, lv.y, lv.z);
      } else {
        linvel
          .copy(curPos)
          .sub(prevSamplePos.current)
          .divideScalar(sampleDt);
      }
      angularVelocityFromQuats(
        prevSampleQuat.current,
        curQuat,
        sampleDt,
        angVelWorld.current,
      );
      const reading = computeImuReading({
        linvel: [linvel.x, linvel.y, linvel.z],
        prevLinvel: [
          prevSampleLinvel.current.x,
          prevSampleLinvel.current.y,
          prevSampleLinvel.current.z,
        ],
        angVelWorld: [
          angVelWorld.current.x,
          angVelWorld.current.y,
          angVelWorld.current.z,
        ],
        qCur: [curQuat.x, curQuat.y, curQuat.z, curQuat.w],
        dt: sampleDt,
        gWorld: [GRAVITY[0], GRAVITY[1], GRAVITY[2]],
      });

      prevSamplePos.current.copy(curPos);
      prevSampleQuat.current.copy(curQuat);
      prevSampleLinvel.current.copy(linvel);

      // Apply MathWorks-style sensor noise to the clean reading. The
      // noise state's bias accumulators advance in place each tick so
      // the recorded trace contains realistic Allan-variance bias
      // wandering, not just per-sample white noise.
      const noiseCfg = useStore.getState().imuNoise;
      if (!noiseState.current) noiseState.current = makeImuNoiseState(noiseCfg);
      const noisy = applyImuNoise(
        [reading.ax, reading.ay, reading.az],
        [reading.gx, reading.gy, reading.gz],
        noiseState.current,
        noiseCfg,
        sampleDt,
      );

      if (isRecording) {
        pushSample({
          t: performance.now(),
          ax: noisy.accel[0],
          ay: noisy.accel[1],
          az: noisy.accel[2],
          gx: noisy.gyro[0],
          gy: noisy.gyro[1],
          gz: noisy.gyro[2],
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
  const meshRef = useRef<THREE.Mesh>(null);
  const camBackH = useRef(new THREE.Vector3());
  const camRightH = useRef(new THREE.Vector3());
  const worldVec = useRef(new THREE.Vector3());

  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh || !target) return;
    pinchTargetToWorld(
      target,
      state.camera,
      camBackH.current,
      camRightH.current,
      worldVec.current,
    );
    mesh.position.copy(worldVec.current);
  });

  if (!target) return null;
  return (
    <mesh ref={meshRef}>
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

/**
 * Wraps the rover rig and the static obstacle field together so they
 * share a single `obstaclesRef`. The Rover's lidar component raycasts
 * against this ref each frame; keeping it inside one component avoids
 * prop-drilling the ref through Scene and lets us swap rovers / scenes
 * later without re-threading.
 */
function RoverScene() {
  const obstaclesRef = useRef<THREE.Group>(null);
  return (
    <>
      <RobotObstacles ref={obstaclesRef} />
      <Rover obstaclesRef={obstaclesRef} />
    </>
  );
}

/** Arm scene: the Braccio rig + the user's spawned scene objects so
 * the arm has things to pick up. SpawnedObjects already renders each
 * `sceneObject` as a draggable mesh with optional physics, so we just
 * mount it alongside the arm. */
function ArmScene() {
  return (
    <>
      <BraccioArm />
      <SpawnedObjects />
    </>
  );
}

/**
 * Snap the camera + orbit target to a sensible default whenever the
 * scene's "subject" changes — currently that means switching the robot
 * kind, since the Braccio arm is ~30 cm tall and disappears against
 * the meter-scale framing used for the manipulated cube and the rover.
 *
 * Reads `controls` via `useThree` so we get whatever OrbitControls
 * registered as the default. The user can still freely orbit after we
 * snap; we only re-snap when the dependency tuple changes.
 */
function CameraRig() {
  const camera = useThree((s) => s.camera);
  const controls = useThree(
    (s) => s.controls as unknown as {
      target: THREE.Vector3;
      update: () => void;
    } | null,
  );
  const mode = useStore((s) => s.mode);
  const robotKind = useStore((s) => s.robot.kind);

  useEffect(() => {
    if (!controls) return;
    if (mode === 'robot' && robotKind === 'arm') {
      // Tight framing for the Braccio (≈30 cm tall) — eye-level on the
      // shoulder joint with the gripper roughly centered.
      camera.position.set(0.55, 0.45, 0.65);
      controls.target.set(0, 0.25, 0);
    } else {
      // Default meter-scale framing used by every other mode.
      camera.position.set(4, 3, 6);
      controls.target.set(0, 0.7, 0);
    }
    controls.update();
  }, [mode, robotKind, camera, controls]);

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
  const robotKind = useStore((s) => s.robot.kind);

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
        ) : mode === 'robot' ? (
          robotKind === 'rover' ? (
            <RoverScene />
          ) : (
            <ArmScene />
          )
        ) : (
          <>
            {showConveyor && <Conveyor />}
            <SpawnedObjects />
            <ImportedAssets />
          </>
        )}
      </Physics>

      {(mode === 'detection' || mode === 'anomaly') && (
        <VirtualCamera previewCanvas={previewCanvas} />
      )}
      {mode === 'robot' && (
        <RobotPovCamera previewCanvas={previewCanvas} />
      )}

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.1}
        minDistance={0.3}
        maxDistance={20}
        target={[0, 0.7, 0]}
      />
      <CameraRig />
      <PreviewCanvasMount setCanvas={() => {}} />
    </Canvas>
  );
}
