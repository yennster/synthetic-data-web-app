import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows } from '@react-three/drei/core/ContactShadows.js';
import { Grid } from '@react-three/drei/core/Grid.js';
import { OrbitControls } from '@react-three/drei/core/OrbitControls.js';
import { SoftShadows } from '@react-three/drei/core/softShadows.js';
import { Physics } from '@react-three/rapier';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { sampleCameraTrajectory } from '../lib/cameraTrajectory';
import { useDragMove } from '../lib/dragMove';
import { cameraRelativeToWorld } from '../lib/handMath';
import { clamp, degToRad } from '../lib/math';
import { URL_FLAGS } from '../lib/urlParams';
import { MotionSim } from '../lib/mujoco/MotionSim';
import { loadMujocoModule } from '../lib/mujoco/runtime';
import { sampleImu, type NoiseStateRef } from '../lib/mujoco/imuSensor';
import { useStore, type ObjectKind } from '../store/useStore';
import { Conveyor } from './Conveyor';
import { DebugOverlay } from './DebugOverlay';
import { SceneEnvironment } from './SceneEnvironment';
import { SpawnedObjects } from './SpawnedObjects';

const BraccioArm = lazy(() =>
  import('./BraccioArm').then((mod) => ({ default: mod.BraccioArm })),
);
const ImportedAssets = lazy(() =>
  import('./ImportedAssets').then((mod) => ({
    default: mod.ImportedAssets,
  })),
);
const RobotPovCamera = lazy(() =>
  import('./RobotPovCamera').then((mod) => ({
    default: mod.RobotPovCamera,
  })),
);
const Rover = lazy(() =>
  import('./Rover').then((mod) => ({ default: mod.Rover })),
);
const VirtualCamera = lazy(() =>
  import('./VirtualCamera').then((mod) => ({
    default: mod.VirtualCamera,
  })),
);

const GRAVITY: [number, number, number] = [0, -9.81, 0];

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
  // entering motion mode after robotics mode is instant. Failures
  // (CSP block, OOM on iOS Safari, Emscripten init quirks, …) used to
  // be swallowed — the cube would just sit at the mesh default and
  // hand tracking would appear to "work" without driving anything.
  // Surface those to the user via the sidebar status so a regression
  // doesn't hide silently.
  const [sim, setSim] = useState<MotionSim | null>(null);
  useEffect(() => {
    let cancelled = false;
    let local: MotionSim | null = null;
    loadMujocoModule()
      .then((mujoco) => {
        if (cancelled) return;
        try {
          local = new MotionSim(mujoco, objectKind);
          setSim(local);
        } catch (err) {
          console.error('[motion] MotionSim init failed', err);
          useStore
            .getState()
            .setStatus(
              'err',
              `Physics init failed: ${(err as Error)?.message ?? err}`,
            );
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[motion] MuJoCo module load failed', err);
        useStore
          .getState()
          .setStatus(
            'err',
            `Physics load failed: ${(err as Error)?.message ?? err}`,
          );
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
//
// Note: drei's `<Environment preset="…">` was removed here because it
// fetches the HDR from `raw.githack.com`, which the production CSP
// (`connect-src 'self' …edgeimpulse… …huggingface… …vercel…`) blocks.
// On a fresh client the fetch errors, drei's loader throws inside
// Suspense, and without a tree-level error boundary React unmounts —
// the "UI flashes then black screen" regression. Ambient + directional
// + the procedural skybox installed by SceneEnvironment already light
// the scene; we lose a touch of IBL polish on shiny materials in
// exchange for working offline / under strict CSP.
function SceneLighting() {
  const intensity = useStore((s) => s.capture.lightIntensity);
  const envRot = useStore((s) => s.capture.envRotation);
  return (
    <>
      <ambientLight intensity={0.55} />
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
        <Suspense fallback={null}>
          <ImportedAssets ownerFilter="rover" physicsMode="visual" />
        </Suspense>
      </group>
      <Suspense fallback={null}>
        <Rover obstaclesRef={obstaclesRef} />
      </Suspense>
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
      <Suspense fallback={null}>
        <BraccioArm />
      </Suspense>
      <SpawnedObjects ownerFilter="arm" excludeIds={excludeIds} />
      <Suspense fallback={null}>
        <ImportedAssets
          ownerFilter="arm"
          excludeIds={excludeIds}
          physicsMode="visual"
        />
      </Suspense>
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
  const raycaster = useThree((s) => s.raycaster);
  const controls = useThree(
    (s) => s.controls as unknown as {
      target: THREE.Vector3;
      update: () => void;
    } | null,
  );
  const mode = useStore((s) => s.mode);
  const robotKind = useStore((s) => s.robot.kind);

  // Enable the gizmo layer on the orbit camera so the trajectory
  // gizmo (and any future editor-only helpers) shows up in the live
  // view. Capture cameras don't enable this layer, so PNG captures
  // stay clean.
  //
  // We also enable the gizmo layer on r3f's pointer-event raycaster,
  // otherwise the virtual-camera handle's hit-target mesh (which lives
  // on layer 1) can be seen but never picked — pointer events
  // silently fall through to OrbitControls, and the user can't drag
  // the camera handle no matter how hard they try.
  useEffect(() => {
    camera.layers.enable(GIZMO_LAYER);
    raycaster.layers.enable(GIZMO_LAYER);
  }, [camera, raycaster]);

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
    const raw = clamp(distance / REF_DISTANCE, 1, 3);
    // Only push to the store when it changes meaningfully — saves a
    // zustand notification per frame in the steady state.
    if (Math.abs(raw - lastScale.current) > 0.01) {
      lastScale.current = raw;
      setHandMappingScale(raw);
    }
  });

  return null;
}

/**
 * Visualizes the configured batch-capture camera trajectory as a line
 * loop with sample-point markers, sitting in the live scene. Only
 * renders in detection / anomaly modes and only when the user has
 * selected a non-random trajectory — otherwise it stays out of frame so
 * captures themselves aren't polluted.
 *
 * Both the line and the markers carry `depthTest: false` + a high
 * `renderOrder` so the gizmo is visible even when it passes behind the
 * floor or imported geometry.
 */
/** Layer used by editor gizmos that should be visible in the main
 * orbit view but never end up in captured frames. The capture cameras
 * (VirtualCamera, RobotPovCamera) stay on the default layer 0 so they
 * skip these objects without any explicit hide/show toggling. */
const GIZMO_LAYER = 1;

/** Recursively set every object in a tree to render *only* on the
 * gizmo layer. Three.js' `Object3D.layers.set` replaces the mask, so
 * the object stops rendering on layer 0 too — exactly what we want
 * for the capture camera to skip it. */
function setLayerRecursive(root: THREE.Object3D, layer: number): void {
  root.traverse((o) => o.layers.set(layer));
}

function TrajectoryGizmo() {
  const mode = useStore((s) => s.mode);
  const trajectory = useStore((s) => s.capture.cameraTrajectory);
  const radius = useStore((s) => s.capture.trajectoryRadius);
  const height = useStore((s) => s.capture.trajectoryHeight);
  const target = useStore((s) => s.capture.camTarget);
  const batchCount = useStore((s) => s.capture.batchCount);
  const setCapture = useStore((s) => s.setCapture);

  const targetDragHandlers = useDragMove({
    getPosition: () => useStore.getState().capture.camTarget,
    setPosition: (p) => {
      const cs = useStore.getState().capture;
      const patch: Partial<typeof cs> = { camTarget: p };
      if (cs.cameraTrajectory !== 'random') {
        patch.camPos = sampleCameraTrajectory({
          trajectory: cs.cameraTrajectory,
          index: 0,
          total: Math.max(1, cs.batchCount),
          target: p,
          radius: cs.trajectoryRadius,
          height: cs.trajectoryHeight,
        });
      }
      setCapture(patch);
    },
  });

  // Sample the path at a moderate fixed density (independent of
  // batchCount) so the curve stays smooth even on a tiny batch. The
  // sample markers themselves use batchCount so the user can see the
  // discrete capture poses they'll actually visit.
  //
  // We render the curve as a TubeGeometry rather than a Line: WebGL
  // line widths are clamped to 1 px on most drivers, which makes a
  // flat line invisible against the skybox at meter scales.
  const { tubeObject, markerPositions } = useMemo(() => {
    const LINE_SAMPLES = 256;
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < LINE_SAMPLES; i++) {
      const p = sampleCameraTrajectory({
        trajectory,
        index: i,
        total: LINE_SAMPLES,
        target: [target[0], target[1], target[2]],
        radius,
        height,
      });
      points.push(new THREE.Vector3(p[0], p[1], p[2]));
    }
    // Closed loop for cyclical paths (circle / figure8 / orbit_dome),
    // open for `arc` and `spiral`.
    const isClosed = trajectory === 'circle' || trajectory === 'figure8';
    const curve = new THREE.CatmullRomCurve3(points, isClosed);
    const tubeGeom = new THREE.TubeGeometry(
      curve,
      LINE_SAMPLES,
      0.03,
      6,
      isClosed,
    );
    const mat = new THREE.MeshBasicMaterial({
      color: '#5eead4',
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
    });
    const obj = new THREE.Mesh(tubeGeom, mat);
    obj.renderOrder = 998;
    const markers: [number, number, number][] = [];
    const n = clamp(batchCount, 1, 64);
    for (let i = 0; i < n; i++) {
      markers.push(
        sampleCameraTrajectory({
          trajectory,
          index: i,
          total: n,
          target: [target[0], target[1], target[2]],
          radius,
          height,
        }),
      );
    }
    return { tubeObject: obj, markerPositions: markers };
  }, [trajectory, radius, height, target, batchCount]);

  useEffect(() => {
    return () => {
      tubeObject.geometry.dispose();
      (tubeObject.material as THREE.Material).dispose();
    };
  }, [tubeObject]);

  const visible =
    URL_FLAGS.gizmos &&
    (mode === 'detection' || mode === 'anomaly') &&
    trajectory !== 'random';

  // Pin the entire subtree to the gizmo layer once it's mounted so the
  // capture cameras (which stay on layer 0) ignore it. Re-runs whenever
  // the tube object changes — that's also when fresh marker meshes are
  // re-created.
  const groupRef = useRef<THREE.Group>(null);
  useEffect(() => {
    if (groupRef.current) setLayerRecursive(groupRef.current, GIZMO_LAYER);
  }, [tubeObject, markerPositions, visible]);

  if (!visible) return null;

  return (
    <group ref={groupRef} renderOrder={998}>
      <primitive object={tubeObject} />
      {markerPositions.map((p, i) => (
        <mesh key={i} position={p} renderOrder={999}>
          <sphereGeometry args={[0.06, 12, 12]} />
          <meshBasicMaterial
            color={i === 0 ? '#fbbf24' : '#38bdf8'}
            transparent
            opacity={0.95}
            depthTest={false}
          />
        </mesh>
      ))}
      {/* Invisible, generous hit area around the orbit center. Shift-drag
          moves `camTarget`, which re-centers the path and the live camera. */}
      <mesh
        position={target as [number, number, number]}
        visible={false}
        {...targetDragHandlers}
      >
        <sphereGeometry args={[0.35, 12, 12]} />
        <meshBasicMaterial />
      </mesh>
      {/* Marker on the target itself so the user can see and move the
          point every non-random trajectory orbits around. */}
      <mesh position={target as [number, number, number]} renderOrder={999}>
        <sphereGeometry args={[0.04, 10, 10]} />
        <meshBasicMaterial
          color="#f472b6"
          transparent
          opacity={0.9}
          depthTest={false}
        />
      </mesh>
    </group>
  );
}

/**
 * Keyboard input handler for camera rotation, panning, and Shift-pan
 * toggle.
 *
 * Keys (when the canvas / window has focus, and the user isn't typing
 * into a sidebar input):
 *   - Q / E       : rotate camera azimuth (yaw) left / right around target
 *   - [ / ]       : rotate the current selection (or all objects when
 *                   nothing is selected) around Y
 *   - Esc         : clear the current scene-object selection
 *   - Arrow keys  : pan the framed view
 *
 * Use right-mouse-drag (or two-finger touch) to pan, which is
 * OrbitControls' default — left-drag remains rotate so the standard
 * 3D-viewer feel is preserved.
 *
 * Polar-tilt keys (formerly R/F) were dropped — `R` was being eaten by
 * the browser-refresh shortcut on macOS (Cmd+R) and the bare `R` was
 * surprising users by appearing to no-op.
 */
function CameraKeyboardInput() {
  const camera = useThree((s) => s.camera);
  const controls = useThree(
    (s) =>
      s.controls as unknown as {
        target: THREE.Vector3;
        update: () => void;
        mouseButtons: { LEFT: unknown; MIDDLE: unknown; RIGHT: unknown };
      } | null,
  );

  useEffect(() => {
    if (!controls) return;
    const isEditableTarget = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        el.isContentEditable
      );
    };

    const rotateAroundTarget = (deltaAz: number, deltaPolar: number) => {
      const offset = new THREE.Vector3().subVectors(
        camera.position,
        controls.target,
      );
      const sph = new THREE.Spherical().setFromVector3(offset);
      sph.theta -= deltaAz;
      sph.phi -= deltaPolar;
      sph.phi = clamp(sph.phi, 0.05, Math.PI - 0.05);
      offset.setFromSpherical(sph);
      camera.position.copy(controls.target).add(offset);
      camera.lookAt(controls.target);
      controls.update();
    };

    const panInScreenSpace = (dx: number, dy: number) => {
      // Pan both the camera and the orbit target in the camera's local
      // X / Y axes so the framed point translates rather than rotating.
      const xAxis = new THREE.Vector3();
      const yAxis = new THREE.Vector3();
      camera.matrix.extractBasis(xAxis, yAxis, new THREE.Vector3());
      const move = new THREE.Vector3()
        .addScaledVector(xAxis, dx)
        .addScaledVector(yAxis, dy);
      camera.position.add(move);
      controls.target.add(move);
      controls.update();
    };

    const rotateObjectsY = (delta: number) => {
      const {
        sceneObjects,
        updateSceneObject,
        assets,
        updateAsset,
        selectedIds,
      } = useStore.getState();
      const hasSelection = selectedIds.length > 0;
      const objectMatches = (id: string) =>
        !hasSelection || selectedIds.includes(id);
      for (const o of sceneObjects) {
        if (!objectMatches(o.id)) continue;
        const r: [number, number, number] = [
          o.rotation[0],
          (o.rotation[1] ?? 0) + delta,
          o.rotation[2],
        ];
        updateSceneObject(o.id, { rotation: r });
      }
      for (const a of assets) {
        if (!objectMatches(a.id)) continue;
        const r: [number, number, number] = [
          a.rotation[0],
          (a.rotation[1] ?? 0) + delta,
          a.rotation[2],
        ];
        updateAsset(a.id, { rotation: r });
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.key === 'Escape') {
        const { selectedIds, clearSelection } = useStore.getState();
        if (selectedIds.length > 0) {
          clearSelection();
          e.preventDefault();
        }
        return;
      }
      // Step sizes: 5° for camera rotation, 10° for object rotation.
      // Holding Shift doubles the step for fast adjustments.
      const stepCam = degToRad(e.shiftKey ? 10 : 5);
      const stepObj = degToRad(e.shiftKey ? 20 : 10);
      const panStep = e.shiftKey ? 0.5 : 0.2;
      switch (e.key.toLowerCase()) {
        case 'q':
          rotateAroundTarget(stepCam, 0);
          e.preventDefault();
          break;
        case 'e':
          rotateAroundTarget(-stepCam, 0);
          e.preventDefault();
          break;
        case '[':
          rotateObjectsY(-stepObj);
          e.preventDefault();
          break;
        case ']':
          rotateObjectsY(stepObj);
          e.preventDefault();
          break;
        case 'arrowleft':
          panInScreenSpace(-panStep, 0);
          e.preventDefault();
          break;
        case 'arrowright':
          panInScreenSpace(panStep, 0);
          e.preventDefault();
          break;
        case 'arrowup':
          panInScreenSpace(0, panStep);
          e.preventDefault();
          break;
        case 'arrowdown':
          panInScreenSpace(0, -panStep);
          e.preventDefault();
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [camera, controls]);

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
      {/* `scene.background` is installed by SceneEnvironment as an
          equirectangular skybox texture so the same backdrop shows up
          on the live canvas and in capture-renderer output. */}
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
            <Suspense fallback={null}>
              <ImportedAssets ownerFilter="vision" />
            </Suspense>
          </>
        )}
      </Physics>

      {(mode === 'detection' || mode === 'anomaly') && (
        <Suspense fallback={null}>
          <VirtualCamera previewCanvas={previewCanvas} />
        </Suspense>
      )}
      <TrajectoryGizmo />
      {mode === 'robot' && (
        <Suspense fallback={null}>
          <RobotPovCamera previewCanvas={previewCanvas} />
        </Suspense>
      )}

      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.1}
        minDistance={0.3}
        maxDistance={20}
        enablePan
        screenSpacePanning
        target={[0, 0.7, 0]}
      />
      <CameraRig />
      <CameraKeyboardInput />
      <DebugOverlay />
      <PreviewCanvasMount setCanvas={() => {}} />
    </Canvas>
  );
}
