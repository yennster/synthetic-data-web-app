import { useFrame } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { BRACCIO_LINKS, BRACCIO_REST_RAD } from '../lib/braccio';
import {
  buildArmTrajectory,
  type ArmParametricPath,
} from '../lib/armTrajectories';
import { BraccioSim } from '../lib/mujoco/BraccioSim';
import { loadMujocoModule } from '../lib/mujoco/runtime';
import {
  applyImuNoise,
  makeImuNoiseState,
  type ImuNoiseState,
} from '../lib/imuNoise';
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
    </>
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
    const state = useStore.getState();
    const targetId = state.armTargetId;
    let pickup = { x: 0.18, y: 0.06, z: 0.12 };
    let drop = { x: -0.18, y: 0.06, z: 0.12 };
    const target = state.sceneObjects.find(
      (o) => o.id === targetId && o.owner === 'arm',
    );
    if (target) {
      pickup = {
        x: target.position[0],
        y: Math.max(0.04, target.position[1]),
        z: target.position[2],
      };
      drop = {
        x: -target.position[0],
        y: Math.max(0.04, target.position[1]),
        z: target.position[2],
      };
    }
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
  const noiseState = useRef<ImuNoiseState | null>(null);

  useFrame((_, dt) => {
    if (!sim) return;
    recordAccum.current += dt;
    if (recordAccum.current < recordPeriod) return;
    const sampleDt = recordAccum.current;
    recordAccum.current = 0;

    const imu = sim.readImu();

    const noiseCfg = useStore.getState().imuNoise;
    if (!noiseState.current) noiseState.current = makeImuNoiseState(noiseCfg);
    const noisy = applyImuNoise(
      imu.accel,
      imu.gyro,
      noiseState.current,
      noiseCfg,
      sampleDt,
    );

    const { robotRunning, pushRobotImuSample } = useStore.getState();
    if (robotRunning) {
      pushRobotImuSample({
        t: performance.now(),
        ax: noisy.accel[0],
        ay: noisy.accel[1],
        az: noisy.accel[2],
        gx: noisy.gyro[0],
        gy: noisy.gyro[1],
        gz: noisy.gyro[2],
      });
    }
  });

  return null;
}
