import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  ContactShadows,
  Environment,
  Grid,
  OrbitControls,
  SoftShadows,
} from '@react-three/drei';
import { Physics } from '@react-three/rapier';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { cameraRelativeToWorld } from '../lib/handMath';
import { MotionSim } from '../lib/mujoco/MotionSim';
import { loadMujocoModule } from '../lib/mujoco/runtime';
import { sampleImu, type NoiseStateRef } from '../lib/mujoco/imuSensor';
import { useStore, type ObjectKind } from '../store/useStore';
import { BraccioArm } from './BraccioArm';
import { Conveyor } from './Conveyor';
import { ImportedAssets } from './ImportedAssets';
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

// ---------- Motion-mode body ----------
//
// Physics-backed manipulated body, powered by MuJoCo via `MotionSim`.
// The three.js mesh below is a pure render target — every frame we
// read the sim's pose and copy it onto the mesh. Grab/release is a
// weld equality constraint between a mocap "hand" body and the
// free-joint manipulated body inside MuJoCo; the runtime toggles
// `eq_active[grab]` when the pinch state changes. Throw / push /
// shake velocities written by the procedural-motion runner reach the
// integrator through `sim.release({ linvel, angvel })`.

const PINCH_LERP = 0.35;

function ManipulatedObject() {
  const objectKind = useStore((s) => s.objectKind);
  const meshRef = useRef<THREE.Mesh>(null);

  // Async sim load. The same WASM is shared with the arm + rover, so
  // entering motion mode after robotics mode is instant.
  const [sim, setSim] = useState<MotionSim | null>(null);
  useEffect(() => {
    let cancelled = false;
    let local: MotionSim | null = null;
    loadMujocoModule().then((mujoco) => {
      if (cancelled) return;
      local = new MotionSim(mujoco, objectKind);
      setSim(local);
    });
    return () => {
      cancelled = true;
      local?.dispose();
    };
    // Empty deps — the sim is created once, and `loadShape` handles
    // kind changes below without rebuilding the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hot-swap the shape when the user toggles object kind. `loadShape`
  // recompiles the model (~ms for these small MJCFs) and resets state.
  useEffect(() => {
    if (!sim) return;
    sim.loadShape(objectKind);
    sim.resetToSpawn();
    // Reset noise state on remount so a fresh shape gets its own
    // bias-drift trajectory (matches the pre-MuJoCo behavior).
    noiseStateRef.current.current = null;
  }, [sim, objectKind]);

  // IMU noise + sample-rate gating. `sampleAccumulator` tracks elapsed
  // time since the last emitted sample so we emit at most one per
  // frame regardless of `sampleRateHz` — same anti-aliasing rule as
  // the old Rapier path.
  const sampleAccumulator = useRef(0);
  const noiseStateRef = useRef<NoiseStateRef>({ current: null });

  // Per-frame scratch for the camera-yaw composition of pinchRotation
  // and the pinch-target world-space mapping.
  const camBackH = useRef(new THREE.Vector3());
  const camRightH = useRef(new THREE.Vector3());
  const worldVec = useRef(new THREE.Vector3());
  const yawAxis = useRef(new THREE.Vector3(0, 1, 0));
  const yawQuat = useRef(new THREE.Quaternion());
  const handQuat = useRef(new THREE.Quaternion());
  // Cached hand pose so we can compute a release velocity from the
  // last few frames of pinch motion.
  const prevHandPos = useRef(new THREE.Vector3(0, 2, 0));
  const releaseLinvel = useRef<[number, number, number]>([0, 0, 0]);
  const wasGrabbed = useRef(false);

  useFrame((state, dt) => {
    if (!sim) return;
    const {
      isGrabbed,
      pinchTarget,
      pinchRotation,
      sampleRateHz,
      isRecording,
      pushSample,
      imuNoise,
    } = useStore.getState();

    if (isGrabbed && pinchTarget) {
      // Map the pinch target through the camera-yaw basis (same
      // transform we use for the marker mesh below).
      pinchTargetToWorld(
        pinchTarget,
        state.camera,
        camBackH.current,
        camRightH.current,
        worldVec.current,
      );
      // Lerp from the current hand pose for visual smoothing — the
      // raw hand-tracking signal is jittery, and unfiltered jitter
      // produces a noisy IMU trace. The lerp factor matches the
      // pre-migration FOLLOW_LERP so the recorded shake signature is
      // unchanged.
      const next = new THREE.Vector3(
        prevHandPos.current.x,
        prevHandPos.current.y,
        prevHandPos.current.z,
      ).lerp(worldVec.current, PINCH_LERP);

      // Composed orientation: camera yaw × hand rotation. Skips the
      // composition (identity quat) when the hand-tracker hasn't
      // produced a rotation yet — typical at the very start of a grab.
      let qw = 1,
        qx = 0,
        qy = 0,
        qz = 0;
      if (pinchRotation) {
        const yaw = cameraYawAngle(state.camera);
        yawQuat.current.setFromAxisAngle(yawAxis.current, yaw);
        handQuat.current.set(
          pinchRotation[0],
          pinchRotation[1],
          pinchRotation[2],
          pinchRotation[3],
        );
        const composed = yawQuat.current.multiply(handQuat.current);
        qx = composed.x;
        qy = composed.y;
        qz = composed.z;
        qw = composed.w;
      }
      // MuJoCo mocap_quat is (w, x, y, z); three.js is (x, y, z, w).
      // Repack at the boundary.
      if (!wasGrabbed.current) {
        // First frame of a fresh grab. Seed `prevHandPos` at the
        // target so the velocity sampled this frame is zero — without
        // this, a grab right after a release would inherit the post-
        // release world position and produce a spurious linvel of
        // metres/second on the very first sample.
        prevHandPos.current.copy(worldVec.current);
        sim.grab(
          [worldVec.current.x, worldVec.current.y, worldVec.current.z],
          [qw, qx, qy, qz],
        );
      } else {
        sim.setHandPose([next.x, next.y, next.z], [qw, qx, qy, qz]);
      }

      // Cache the per-frame velocity so a release picks up the throw
      // direction without an explicit sample. dt floor avoids div-by-
      // zero on the first frame.
      const ddt = Math.max(dt, 1e-3);
      releaseLinvel.current = [
        (next.x - prevHandPos.current.x) / ddt,
        (next.y - prevHandPos.current.y) / ddt,
        (next.z - prevHandPos.current.z) / ddt,
      ];
      prevHandPos.current.copy(next);
      wasGrabbed.current = true;
    } else if (wasGrabbed.current) {
      // Pinch just released. Hand off the linvel we tracked while
      // grabbed and consume any one-shot angvel the procedural runner
      // staged for throws (see store comment for the rationale).
      const { nextReleaseAngVel, setNextReleaseAngVel } = useStore.getState();
      sim.release({
        linvel: releaseLinvel.current,
        angvel: nextReleaseAngVel ?? undefined,
      });
      if (nextReleaseAngVel) setNextReleaseAngVel(null);
      wasGrabbed.current = false;
    }

    sim.step(dt);

    // Mirror MuJoCo's pose onto the visual mesh. xquat is (w, x, y, z),
    // three.js Quaternion is (x, y, z, w) — repack.
    const pose = sim.readPose();
    if (meshRef.current) {
      meshRef.current.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
      meshRef.current.quaternion.set(
        pose.quat[1],
        pose.quat[2],
        pose.quat[3],
        pose.quat[0],
      );
    }

    // IMU sampling at the configured rate, gated on the accumulator
    // so a 60 fps render with a 100 Hz request emits ≤ 1 sample/frame.
    const period = 1 / sampleRateHz;
    sampleAccumulator.current += dt;
    if (sampleAccumulator.current >= period && isRecording) {
      const sampleDt = sampleAccumulator.current;
      sampleAccumulator.current = 0;
      const sample = sampleImu(sim, noiseStateRef.current, imuNoise, sampleDt);
      pushSample(sample);
    } else if (sampleAccumulator.current >= period) {
      // Not recording — drain the accumulator anyway so the next
      // recording's first sample starts at the right phase, not at
      // whatever fractional time happens to have accumulated.
      sampleAccumulator.current = 0;
    }
  });

  return <ManipulatedMesh kind={objectKind} meshRef={meshRef} />;
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
  // Ref-tracked group holding rover-owned obstacles: manual objects
  // added through the "Scene obstacles" card. The rover's lidar ring
  // raycasts against this group.
  const obstaclesRef = useRef<THREE.Group>(null);
  return (
    <>
      <group ref={obstaclesRef}>
        <SpawnedObjects ownerFilter="rover" />
        <ImportedAssets ownerFilter="rover" physicsMode="visual" />
      </group>
      <Rover obstaclesRef={obstaclesRef} />
    </>
  );
}

/** Arm scene: the Braccio rig + the user's arm-owned pickup objects.
 * The active pickup target (matching `armTargetId`) is omitted from
 * the SpawnedObjects render — `BraccioArm`'s `ArmTargetMesh` draws it
 * at MuJoCo's settled pose so the fingers can physically grasp it.
 * Other arm-owned objects stay as kinematic scenery. */
function ArmScene() {
  const armTargetId = useStore((s) => s.armTargetId);
  const excludeIds = useMemo(
    () => (armTargetId ? [armTargetId] : undefined),
    [armTargetId],
  );
  return (
    <>
      <BraccioArm />
      <SpawnedObjects ownerFilter="arm" excludeIds={excludeIds} />
      <ImportedAssets
        ownerFilter="arm"
        excludeIds={excludeIds}
        physicsMode="visual"
      />
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

  // Hand-mapping scale: stretch the hand-tracker's per-frame target
  // coords by how far the user has zoomed out. The default camera sits
  // ~7.8 m from HAND_ANCHOR; doubling that distance roughly doubles the
  // reachable drop height, capped to a 3× ceiling so a fully-zoomed-out
  // wrist flick doesn't fling the cube to the horizon.
  const setHandMappingScale = useStore((s) => s.setHandMappingScale);
  const REF_DISTANCE = Math.hypot(4, 3, 6); // default camera position
  const lastScale = useRef(1);
  useFrame(() => {
    if (mode !== 'motion') return;
    const dx = camera.position.x - HAND_ANCHOR[0];
    const dy = camera.position.y - HAND_ANCHOR[1];
    const dz = camera.position.z - HAND_ANCHOR[2];
    const distance = Math.hypot(dx, dy, dz);
    const raw = Math.max(1, Math.min(3, distance / REF_DISTANCE));
    // Only push to the store when it changes meaningfully — saves a
    // zustand notification per frame in the steady state.
    if (Math.abs(raw - lastScale.current) > 0.01) {
      lastScale.current = raw;
      setHandMappingScale(raw);
    }
  });

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
            {/* Detection / anomaly modes render only the legacy
                "vision" pool (objects without an explicit owner).
                Keeps robotics-tagged objects from leaking into the
                vision capture frames. */}
            <SpawnedObjects ownerFilter="vision" />
            <ImportedAssets ownerFilter="vision" />
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
