import { useFrame } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { BRACCIO_LINKS, BRACCIO_REST_RAD } from '../lib/braccio';
import {
  buildArmTrajectory,
  type ArmParametricPath,
} from '../lib/armTrajectories';
import { BraccioSim } from '../lib/mujoco/BraccioSim';
import { sampleImu, type NoiseStateRef } from '../lib/mujoco/imuSensor';
import { loadMujocoModule } from '../lib/mujoco/runtime';
import { useStore } from '../store/useStore';

/**
 * Physics-backed Braccio rig, powered by MuJoCo (WebAssembly).
 *
 * Trajectories no longer drive the visible mesh directly — they push
 * joint-space *targets* into MuJoCo's position actuators. MuJoCo
 * integrates the chain under real gravity + joint inertia and the
 * resulting `qpos` is what the three.js groups read each frame. The
 * IMU sampler reads MuJoCo's built-in accelerometer + gyroscope at the
 * end-effector site, so the recorded signal contains real dynamics
 * (gravity loading, motor lag, contact response) instead of a finite-
 * difference of a kinematic chain.
 *
 * Component layout (unchanged from the kinematic version so the rest of
 * the app — POV-camera anchors, RobotPanel, capture pipeline — keeps
 * working):
 *
 *  - **BraccioArm**     mounts the visual rig + the sim
 *  - **ArmController**  advances the trajectory each frame and writes
 *                       targets into the sim
 *  - **ArmImuSampler**  reads MuJoCo's sensors at `RECORD_HZ`
 */

const RECORD_HZ = 20;

/** Async hook that resolves to a `BraccioSim` instance, returning null
 * until the WASM module loads. The sim is disposed on unmount so
 * navigating away from robotics mode frees the WASM-side heap. */
function useBraccioSim(): BraccioSim | null {
  const [sim, setSim] = useState<BraccioSim | null>(null);

  useEffect(() => {
    let cancelled = false;
    let local: BraccioSim | null = null;
    loadMujocoModule().then((mujoco) => {
      if (cancelled) return;
      local = new BraccioSim(mujoco);
      // Seed the integrator at the user's configured home pose so the
      // first frame doesn't snap from all-zeros to a flexed pose under
      // PD control — that produced a velocity spike in the first IMU
      // sample of every recording.
      local.snapToPose(useStore.getState().robot.armHomePose);
      setSim(local);
    });
    return () => {
      cancelled = true;
      // The Promise may resolve after unmount; `local` is captured here
      // and disposed inline. The `setSim` cancellation guard above
      // keeps us from rendering a stale instance.
      local?.dispose();
    };
  }, []);

  return sim;
}

/** Re-snap the sim's pose whenever the user adjusts the home sliders
 * AND no trajectory is running. While a trajectory is active we let
 * MuJoCo integrate freely; outside that, the home pose is the rest
 * position and the integrator should sit there with zero velocity. */
function useHomePoseSync(sim: BraccioSim | null) {
  const homePose = useStore((s) => s.robot.armHomePose);
  const robotRunning = useStore((s) => s.robotRunning);
  useEffect(() => {
    if (!sim || robotRunning) return;
    sim.snapToPose(homePose);
  }, [sim, homePose, robotRunning]);
}

export function BraccioArm() {
  const sim = useBraccioSim();
  useHomePoseSync(sim);

  // Visual-rig refs. The geometry tree mirrors the MJCF body hierarchy
  // 1:1 — every joint here corresponds to a hinge or slide joint in
  // the MJCF, and the per-frame loop below copies the simulated joint
  // positions onto these groups.
  const baseRef = useRef<THREE.Group>(null);
  const shoulderRef = useRef<THREE.Group>(null);
  const elbowRef = useRef<THREE.Group>(null);
  const wristPitchRef = useRef<THREE.Group>(null);
  const wristRollRef = useRef<THREE.Group>(null);
  const endEffectorRef = useRef<THREE.Group>(null);
  const gripperRef = useRef<{
    left: THREE.Mesh | null;
    right: THREE.Mesh | null;
  }>({ left: null, right: null });

  useFrame((_, dt) => {
    if (!sim) {
      // While the WASM module is still loading, render the rig at the
      // configured home pose so the user sees an arm instead of a
      // collapsed chain.
      const j = useStore.getState().armJoints ?? useStore.getState().robot.armHomePose;
      applyJointsToRig(j);
      return;
    }

    sim.step(dt);
    const j = sim.readJointPositions();
    // Mirror the simulated pose into the store so other listeners
    // (HUD, trajectory debug, capture pipeline) keep seeing a single
    // source of truth for the current arm pose.
    useStore.getState().setArmJoints(j);
    applyJointsToRig(j);
  });

  function applyJointsToRig(j: [number, number, number, number, number, number]) {
    if (baseRef.current) baseRef.current.rotation.y = j[0];
    if (shoulderRef.current) shoulderRef.current.rotation.x = j[1];
    if (elbowRef.current) elbowRef.current.rotation.x = j[2];
    if (wristPitchRef.current) wristPitchRef.current.rotation.x = j[3];
    if (wristRollRef.current) wristRollRef.current.rotation.y = j[4];
    const aperture = j[5];
    const half = (BRACCIO_LINKS.gripperWidth / 2) * aperture;
    if (gripperRef.current.left) gripperRef.current.left.position.x = -half;
    if (gripperRef.current.right) gripperRef.current.right.position.x = half;
  }

  const L = BRACCIO_LINKS;

  return (
    <>
      {/* Arm mounts on the floor; the user controls reach via the
          home-pose sliders rather than a height offset. Floor
          intersection is avoided by picking joint angles the user
          actually wants — the published Braccio rest pose works
          for most configurations. */}
      <group position={[0, 0, 0]}>
        <mesh position={[0, L.plateThickness / 2, 0]} receiveShadow>
          <cylinderGeometry
            args={[L.plateRadius, L.plateRadius, L.plateThickness, 32]}
          />
          <meshStandardMaterial
            color="#1a1d22"
            roughness={0.8}
            metalness={0.2}
          />
        </mesh>

        <group position={[0, L.plateThickness, 0]} ref={baseRef}>
          <mesh position={[0, L.base / 2, 0]} castShadow>
            <cylinderGeometry args={[0.045, 0.045, L.base, 24]} />
            <meshStandardMaterial
              color="#3b4451"
              roughness={0.5}
              metalness={0.4}
            />
          </mesh>

          {/* Camera-mount anchor #1: base. Sits on top of the base
               column with the look anchor centered up the arm. */}
          <group name="arm-pov-base" position={[0, L.base + 0.02, 0]}>
            <group name="arm-pov-base-look" position={[0, 0.4, 0]} />
          </group>

          <group position={[0, L.base, 0]} ref={shoulderRef}>
            {/* Camera-mount anchor #2: shoulder. Eye on the shoulder
                 joint pointing up the upper-arm link. */}
            <group name="arm-pov-shoulder" position={[0.04, 0.04, 0.04]}>
              <group
                name="arm-pov-shoulder-look"
                position={[0, L.shoulder, 0]}
              />
            </group>

            <mesh position={[0, L.shoulder / 2, 0]} castShadow>
              <boxGeometry args={[0.06, L.shoulder, 0.06]} />
              <meshStandardMaterial
                color="#5eead4"
                roughness={0.35}
                metalness={0.2}
              />
            </mesh>

            <group position={[0, L.shoulder, 0]} ref={elbowRef}>
              {/* Camera-mount anchor #3: elbow. Eye on the elbow
                   joint looking down the forearm toward the wrist. */}
              <group name="arm-pov-elbow" position={[0.03, 0.03, 0.03]}>
                <group
                  name="arm-pov-elbow-look"
                  position={[0, L.elbow, 0]}
                />
              </group>

              <mesh position={[0, L.elbow / 2, 0]} castShadow>
                <boxGeometry args={[0.05, L.elbow, 0.05]} />
                <meshStandardMaterial
                  color="#5eead4"
                  roughness={0.35}
                  metalness={0.2}
                />
              </mesh>

              <group position={[0, L.elbow, 0]} ref={wristPitchRef}>
                <mesh position={[0, L.wristPitch / 2, 0]} castShadow>
                  <boxGeometry args={[0.04, L.wristPitch, 0.04]} />
                  <meshStandardMaterial
                    color="#3b4451"
                    roughness={0.5}
                    metalness={0.3}
                  />
                </mesh>

                <group position={[0, L.wristPitch, 0]} ref={wristRollRef}>
                  <mesh position={[0, L.wristRoll / 2, 0]} castShadow>
                    <cylinderGeometry args={[0.025, 0.025, L.wristRoll, 16]} />
                    <meshStandardMaterial
                      color="#3b4451"
                      roughness={0.5}
                      metalness={0.4}
                    />
                  </mesh>

                  {/* End-effector group — anchor for the IMU sampler
                       AND the per-mount POV camera anchors. The POV
                       camera reads `arm-pov-${mount}` each frame
                       (where mount ∈ {base, shoulder, elbow, wrist,
                       gripper}), so the user can pick any of those
                       five mount points from the panel. */}
                  <group
                    position={[0, L.wristRoll, 0]}
                    ref={endEffectorRef}
                  >
                    {/* Camera-mount anchor #4: wrist. */}
                    <group name="arm-pov-wrist" position={[0, 0, 0]}>
                      <group
                        name="arm-pov-wrist-look"
                        position={[0, L.fingerLength + 0.04, 0]}
                      />
                    </group>
                    <mesh position={[0, 0.01, 0]} castShadow>
                      <boxGeometry args={[L.gripperWidth + 0.04, 0.02, 0.04]} />
                      <meshStandardMaterial
                        color="#1a1d22"
                        roughness={0.6}
                        metalness={0.3}
                      />
                    </mesh>
                    <mesh
                      ref={(m) => {
                        gripperRef.current.left = m;
                      }}
                      position={[
                        -L.gripperWidth / 2,
                        L.fingerLength / 2 + 0.02,
                        0,
                      ]}
                      castShadow
                    >
                      <boxGeometry args={[0.018, L.fingerLength, 0.025]} />
                      <meshStandardMaterial
                        color="#3b4451"
                        roughness={0.45}
                        metalness={0.4}
                      />
                    </mesh>
                    <mesh
                      ref={(m) => {
                        gripperRef.current.right = m;
                      }}
                      position={[
                        L.gripperWidth / 2,
                        L.fingerLength / 2 + 0.02,
                        0,
                      ]}
                      castShadow
                    >
                      <boxGeometry args={[0.018, L.fingerLength, 0.025]} />
                      <meshStandardMaterial
                        color="#3b4451"
                        roughness={0.45}
                        metalness={0.4}
                      />
                    </mesh>
                    {/* Visual marker for the wrist-mounted POV camera —
                         a small teal eye on the gripper carrier. */}
                    <mesh
                      position={[0, 0.04, 0.025]}
                      rotation={[Math.PI / 2, 0, 0]}
                      castShadow
                    >
                      <cylinderGeometry args={[0.008, 0.008, 0.012, 12]} />
                      <meshStandardMaterial
                        color="#5eead4"
                        emissive="#0d4d44"
                        emissiveIntensity={0.7}
                        roughness={0.3}
                        metalness={0.2}
                      />
                    </mesh>
                    {/* Camera-mount anchor #5: gripper — between
                         the two fingers, looking at the actual grasp
                         point. This is the natural "eye-in-hand"
                         pose for pick-and-place. */}
                    <group
                      name="arm-pov-gripper"
                      position={[0, L.fingerLength + 0.01, 0]}
                    >
                      <group
                        name="arm-pov-gripper-look"
                        position={[0, 0.1, 0]}
                      />
                    </group>
                  </group>
                </group>
              </group>
            </group>
          </group>
        </group>
      </group>
      <ArmController sim={sim} />
      <ArmImuSampler sim={sim} />
      <ArmTargetMesh sim={sim} />
    </>
  );
}

/**
 * Renders the MuJoCo-owned pickup target as a small cube. The mesh's
 * pose is driven by `sim.readTargetPose()` each frame, so it tracks
 * the integrator — including the lift + drop arcs that come from
 * the gripper closing on it. The visual block size (3 cm) matches
 * the half-extents of the MJCF `g_target` geom.
 *
 * This replaces what `SpawnedObjects` would render for the active arm
 * target; `ArmScene` in `Scene.tsx` filters that ID out so we don't
 * draw two cubes on top of each other.
 */
function ArmTargetMesh({ sim }: { sim: BraccioSim | null }) {
  const armTargetId = useStore((s) => s.armTargetId);
  const targetPosition = useStore((s) => {
    const obj = s.sceneObjects.find(
      (o) => o.id === armTargetId && o.owner === 'arm',
    );
    return obj?.position ?? null;
  });
  const robotRunning = useStore((s) => s.robotRunning);
  const meshRef = useRef<THREE.Mesh>(null);

  // Keep MuJoCo's target body in sync with the user's selected pickup
  // outside of a run. The ArmController is the source of truth during
  // a run (it places the target at iteration start and lets physics
  // take over); when the run flag is off, this effect mirrors whatever
  // position the user has dragged the cube to in the store. Without
  // this, the cube only snapped into place on the first run iteration
  // and otherwise floated at the MJCF's default spawn position.
  useEffect(() => {
    if (!sim || robotRunning || !targetPosition) return;
    sim.placeTarget([targetPosition[0], targetPosition[1], targetPosition[2]]);
  }, [sim, robotRunning, targetPosition]);

  useFrame(() => {
    if (!sim) return;
    const pose = sim.readTargetPose();
    const m = meshRef.current;
    if (!m) return;
    m.position.set(pose.pos[0], pose.pos[1], pose.pos[2]);
    // MuJoCo quat is (w, x, y, z); three.js is (x, y, z, w).
    m.quaternion.set(pose.quat[1], pose.quat[2], pose.quat[3], pose.quat[0]);
  });

  // No active pickup → don't draw the MuJoCo target body. Without this
  // gate the cube sat at the MJCF's hardcoded spawn (0.18, 0.015, 0.12)
  // even when the user hadn't picked a target, looking like a phantom
  // unmovable object next to the real ones rendered by SpawnedObjects.
  if (!armTargetId || !targetPosition) return null;

  return (
    <mesh ref={meshRef} castShadow>
      <boxGeometry args={[0.03, 0.03, 0.03]} />
      <meshStandardMaterial
        color="#5eead4"
        emissive="#0d4d44"
        emissiveIntensity={0.3}
        roughness={0.4}
        metalness={0.2}
      />
    </mesh>
  );
}

/**
 * Drives MuJoCo's position-actuator targets along a parametric
 * trajectory each frame. Same trajectory engine and same epoch-bump
 * trigger as the kinematic version; the only difference is that we
 * write into `sim.setJointTargets(...)` instead of `setArmJoints(...)`.
 * The store's `armJoints` is updated by the rig in `useFrame` from the
 * simulated `qpos`, so listeners still see the live arm pose.
 */
function ArmController({ sim }: { sim: BraccioSim | null }) {
  const epoch = useStore((s) => s.armEpoch);
  const trajectory = useStore((s) => s.robot.armTrajectory);
  const durationMs = useStore((s) => s.robot.durationMs);
  const robotRunning = useStore((s) => s.robotRunning);

  const pathRef = useRef<ArmParametricPath | null>(null);
  const startMs = useRef(0);

  useEffect(() => {
    if (!sim || !robotRunning) {
      pathRef.current = null;
      return;
    }
    let state = useStore.getState();
    // If the user toggled "randomize pickup positions" on, re-sample
    // every arm-owned object's xz before we read the active target.
    // Only does anything for pick_place — the other trajectory classes
    // don't reference scene objects, so shuffling them mid-run would
    // just churn the scene for no signal benefit.
    if (
      state.robot.armRandomizeTarget &&
      state.robot.armTrajectory === 'pick_place'
    ) {
      state.randomizeArmPickupPositions();
      state = useStore.getState();
    }
    const targetId = state.armTargetId;
    // World position of the cube body. The IK targets are derived from
    // this — see comment block below for the bottom-of-cube reasoning.
    let cubePos: [number, number, number] = [0.18, 0.015, 0.12];
    const target = state.sceneObjects.find(
      (o) => o.id === targetId && o.owner === 'arm',
    );
    if (target) {
      cubePos = [
        target.position[0],
        target.position[1],
        target.position[2],
      ];
    }
    // Place MuJoCo's pickup target at the user's selected position. The
    // sim's target body is a 3 cm cube (half-extent 0.015) with a free
    // joint, so writing the user's stored center position puts the
    // cube's bottom on the floor (matching what the user sees rendered).
    sim.placeTarget(cubePos);

    // IK aims at the gripper *tip* (bottom of the fingers). For the
    // parallel-jaw gripper to actually wrap the cube, the tip needs
    // to sit at the cube's bottom face so the fingers extend up the
    // cube's full height before closing laterally. Subtract the cube
    // half-extent (0.015) from the center y, clamped to a small
    // positive margin so the IK doesn't degenerate when the cube
    // sits exactly on the floor.
    //
    // Symmetry: the drop target uses (-x, +z) for a mirrored
    // place-down arc.
    const CUBE_HALF = 0.015;
    const tipY = Math.max(0.002, cubePos[1] - CUBE_HALF);
    const pickup = { x: cubePos[0], y: tipY, z: cubePos[2] };
    const drop = { x: -cubePos[0], y: tipY, z: cubePos[2] };
    pathRef.current = buildArmTrajectory(trajectory, {
      pickup,
      drop,
      rng: Math.random,
      home: state.robot.armHomePose,
    });
    startMs.current = performance.now();
    // Seed the sim's targets at t=0 so the first physics step doesn't
    // chase a stale target left over from the previous trajectory.
    sim.setJointTargets(pathRef.current.sample(0));
  }, [epoch, trajectory, robotRunning, sim]);

  useFrame(() => {
    const path = pathRef.current;
    if (!path || !robotRunning || !sim) return;
    const elapsed = performance.now() - startMs.current;
    const t = Math.max(0, Math.min(1, elapsed / Math.max(1, durationMs)));
    sim.setJointTargets(path.sample(t));
  });

  return null;
}

/**
 * IMU sampler reading MuJoCo's built-in sensors at `RECORD_HZ`. The
 * accelerometer at the end-effector site reports body-frame acceler-
 * ation including gravity; the gyro reports body-frame angular vel-
 * ocity. We feed those through `applyImuNoise` (same noise model used
 * in motion mode) so the recorded trace has realistic bias drift and
 * per-axis scale-factor errors.
 *
 * No more pose-delta finite differences — gravity, joint compliance,
 * and contact response come straight from the integrator and end up
 * in the IMU sample as physical quantities.
 */
function ArmImuSampler({ sim }: { sim: BraccioSim | null }) {
  const recordAccum = useRef(0);
  const recordPeriod = 1 / RECORD_HZ;
  const noiseStateRef = useRef<NoiseStateRef>({ current: null });

  useFrame((_, dt) => {
    if (!sim) return;
    recordAccum.current += dt;
    if (recordAccum.current < recordPeriod) return;
    const sampleDt = recordAccum.current;
    recordAccum.current = 0;

    const { robotRunning, pushRobotImuSample, imuNoise } = useStore.getState();
    if (!robotRunning) return;
    const sample = sampleImu(sim, noiseStateRef.current, imuNoise, sampleDt);
    pushRobotImuSample(sample);
  });

  return null;
}
