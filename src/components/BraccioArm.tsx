import { useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { BRACCIO_LINKS, BRACCIO_REST_RAD } from '../lib/braccio';
import {
  buildArmTrajectory,
  type ArmParametricPath,
} from '../lib/armTrajectories';
import { computeImuReading } from '../lib/imu';
import {
  applyImuNoise,
  makeImuNoiseState,
  type ImuNoiseState,
} from '../lib/imuNoise';
import { useStore } from '../store/useStore';

/**
 * Visual rig + controller + IMU sampler for the Arduino TinkerKit
 * Braccio. The kinematic chain is built as nested groups so each
 * joint's rotation composes onto its parent. Joint angles come from
 * `armJoints` in the store (or the spec rest pose when nothing's
 * driving the arm).
 *
 * Three pieces run together:
 *
 *  - **rig**            renders the chain + animates the gripper
 *  - **controller**     advances `armJoints` along the active
 *                       trajectory each frame
 *  - **IMU sampler**    samples the end-effector's body-frame IMU at
 *                       `RECORD_HZ` — same convention as motion mode,
 *                       feeding `pushRobotImuSample` so the runner can
 *                       upload a 6-channel time-series to EI
 *
 * Joint order (matches the published Braccio servo numbering):
 *   M1 base yaw          rotation about +Y
 *   M2 shoulder pitch    rotation about +X
 *   M3 elbow pitch       rotation about +X
 *   M4 wrist pitch       rotation about +X
 *   M5 wrist roll        rotation about +Y (along the forearm)
 *   M6 gripper aperture  symmetric finger spread (0=closed, 1=open)
 */

const RECORD_HZ = 20;
const G_WORLD: [number, number, number] = [0, -9.81, 0];

export function BraccioArm() {
  const joints = useStore((s) => s.armJoints);
  const mountHeight = useStore((s) => s.robot.armMountHeight);

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

  useFrame(() => {
    const j = joints ?? BRACCIO_REST_RAD;
    if (baseRef.current) baseRef.current.rotation.y = j[0];
    if (shoulderRef.current) shoulderRef.current.rotation.x = j[1];
    if (elbowRef.current) elbowRef.current.rotation.x = j[2];
    if (wristPitchRef.current) wristPitchRef.current.rotation.x = j[3];
    if (wristRollRef.current) wristRollRef.current.rotation.y = j[4];
    const aperture = j[5];
    const half = (BRACCIO_LINKS.gripperWidth / 2) * aperture;
    if (gripperRef.current.left) gripperRef.current.left.position.x = -half;
    if (gripperRef.current.right) gripperRef.current.right.position.x = half;
  });

  const L = BRACCIO_LINKS;

  return (
    <>
      {/* Lift the entire rig by `armMountHeight` so the chain doesn't
          intersect the floor when joints bend below horizontal. The
          shared `arm-pov-mount` / `arm-pov-look` named groups inside
          inherit this offset automatically, so the wrist-mounted POV
          camera stays correctly attached. */}
      <group position={[0, mountHeight, 0]}>
        {/* Cosmetic table — a thin disc rendered just below the arm
            mount so the rig looks like it's sitting on something
            rather than floating. Thin enough not to occlude objects
            placed on top of it. */}
        {mountHeight > 0.001 && (
          <mesh
            position={[0, -L.plateThickness / 2 - 0.001, 0]}
            receiveShadow
          >
            <cylinderGeometry
              args={[L.plateRadius * 4, L.plateRadius * 4, 0.01, 48]}
            />
            <meshStandardMaterial
              color="#15171a"
              roughness={0.85}
              metalness={0.05}
            />
          </mesh>
        )}
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

          <group position={[0, L.base, 0]} ref={shoulderRef}>
            <mesh position={[0, L.shoulder / 2, 0]} castShadow>
              <boxGeometry args={[0.06, L.shoulder, 0.06]} />
              <meshStandardMaterial
                color="#5eead4"
                roughness={0.35}
                metalness={0.2}
              />
            </mesh>

            <group position={[0, L.shoulder, 0]} ref={elbowRef}>
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
                       AND the wrist-mounted POV camera. The POV
                       camera reads this group's world matrix each
                       frame via `scene.getObjectByName('arm-pov-mount')`,
                       so it stays correctly attached regardless of
                       how the joint vector changes — much more robust
                       than recomputing forward kinematics in the POV
                       component (which suffered from sign errors that
                       put the camera inside the base column). */}
                  <group
                    position={[0, L.wristRoll, 0]}
                    ref={endEffectorRef}
                    name="arm-pov-mount"
                  >
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
                    {/* Look-at anchor 8 cm "below" the gripper in
                         the carrier's local frame (which is along the
                         +Y axis the fingers extend on). The POV
                         camera reads this group's world position so
                         its lookAt always tracks where the gripper
                         is pointing, regardless of joint pose. */}
                    <group
                      name="arm-pov-look"
                      position={[0, L.fingerLength + 0.04, 0]}
                    />
                  </group>
                </group>
              </group>
            </group>
          </group>
        </group>
      </group>
      <ArmController />
      <ArmImuSampler endEffectorRef={endEffectorRef} />
    </>
  );
}

/**
 * Drives `armJoints` along a parametric trajectory each frame. Listens
 * for `armEpoch` bumps from the runner; on each bump (while the run
 * flag is active) we build a fresh trajectory for the currently-
 * selected class. For `pick_place`, the runner picks a scene object
 * and a destination point and writes them into the store before
 * bumping; the controller pulls those out and threads them into the
 * trajectory builder.
 */
function ArmController() {
  const epoch = useStore((s) => s.armEpoch);
  const trajectory = useStore((s) => s.robot.armTrajectory);
  const durationMs = useStore((s) => s.robot.durationMs);
  const robotRunning = useStore((s) => s.robotRunning);
  const setArmJoints = useStore((s) => s.setArmJoints);

  const pathRef = useRef<ArmParametricPath | null>(null);
  const startMs = useRef(0);

  useEffect(() => {
    if (!robotRunning) {
      pathRef.current = null;
      return;
    }
    // Pull the chosen scene object as the pickup target. Drop point is
    // a small lateral offset from the pickup so the place arc clears
    // the source. Falls back to a stock pickup/drop pair when no scene
    // objects exist.
    //
    // The arm's IK is solved in the rig-local frame (origin at the
    // mounting plate). Scene objects live in world coordinates, so we
    // subtract the mount height before passing the target into the
    // IK builder — otherwise the solver thinks the cube is way above
    // the arm and the wrist droops.
    const state = useStore.getState();
    const mountY = state.robot.armMountHeight;
    const targetId = state.armTargetId;
    let pickup = { x: 0.18, y: 0.06, z: 0.12 };
    let drop = { x: -0.18, y: 0.06, z: 0.12 };
    const target = state.sceneObjects.find((o) => o.id === targetId);
    if (target) {
      pickup = {
        x: target.position[0],
        y: Math.max(0.04, target.position[1] - mountY),
        z: target.position[2],
      };
      drop = {
        x: -target.position[0],
        y: Math.max(0.04, target.position[1] - mountY),
        z: target.position[2],
      };
    }
    pathRef.current = buildArmTrajectory(trajectory, {
      pickup,
      drop,
      rng: Math.random,
    });
    startMs.current = performance.now();
    setArmJoints(pathRef.current.sample(0));
  }, [epoch, trajectory, robotRunning, setArmJoints]);

  useFrame(() => {
    const path = pathRef.current;
    if (!path || !robotRunning) return;
    const elapsed = performance.now() - startMs.current;
    const t = Math.max(0, Math.min(1, elapsed / Math.max(1, durationMs)));
    setArmJoints(path.sample(t));
  });

  return null;
}

/**
 * End-effector IMU sampler. Reads the gripper-carrier group's world
 * pose, derives linvel from pose deltas (the chain is kinematic), and
 * feeds `computeImuReading`. Pushes one sample per `RECORD_HZ` tick
 * into `robotImuSamples` while a recording is active.
 */
function ArmImuSampler({
  endEffectorRef,
}: {
  endEffectorRef: React.RefObject<THREE.Group>;
}) {
  const recordAccum = useRef(0);
  const recordPeriod = 1 / RECORD_HZ;
  const sampleInit = useRef(false);
  const prevPos = useRef(new THREE.Vector3());
  const prevQuat = useRef(new THREE.Quaternion());
  const prevLinvel = useRef(new THREE.Vector3());
  const noiseState = useRef<ImuNoiseState | null>(null);

  useFrame((_, dt) => {
    recordAccum.current += dt;
    if (recordAccum.current < recordPeriod) return;
    const sampleDt = recordAccum.current;
    recordAccum.current = 0;

    const ee = endEffectorRef.current;
    if (!ee) return;

    const curPos = new THREE.Vector3();
    ee.getWorldPosition(curPos);
    const curQuat = new THREE.Quaternion();
    ee.getWorldQuaternion(curQuat);

    if (!sampleInit.current) {
      prevPos.current.copy(curPos);
      prevQuat.current.copy(curQuat);
      prevLinvel.current.set(0, 0, 0);
      sampleInit.current = true;
      return;
    }

    const linvel = new THREE.Vector3()
      .copy(curPos)
      .sub(prevPos.current)
      .divideScalar(sampleDt);
    const dq = curQuat.clone().multiply(prevQuat.current.clone().invert());
    const angle =
      2 *
      Math.atan2(
        Math.sqrt(dq.x * dq.x + dq.y * dq.y + dq.z * dq.z),
        dq.w,
      );
    const sinHalf = Math.sqrt(1 - Math.min(1, dq.w * dq.w));
    const angVelWorld: [number, number, number] =
      sinHalf > 1e-6
        ? [
            (dq.x / sinHalf) * (angle / sampleDt),
            (dq.y / sinHalf) * (angle / sampleDt),
            (dq.z / sinHalf) * (angle / sampleDt),
          ]
        : [0, 0, 0];

    const reading = computeImuReading({
      linvel: [linvel.x, linvel.y, linvel.z],
      prevLinvel: [
        prevLinvel.current.x,
        prevLinvel.current.y,
        prevLinvel.current.z,
      ],
      angVelWorld,
      qCur: [curQuat.x, curQuat.y, curQuat.z, curQuat.w],
      dt: sampleDt,
      gWorld: G_WORLD,
    });

    prevPos.current.copy(curPos);
    prevQuat.current.copy(curQuat);
    prevLinvel.current.copy(linvel);

    const noiseCfg = useStore.getState().imuNoise;
    if (!noiseState.current) noiseState.current = makeImuNoiseState(noiseCfg);
    const noisy = applyImuNoise(
      [reading.ax, reading.ay, reading.az],
      [reading.gx, reading.gy, reading.gz],
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
