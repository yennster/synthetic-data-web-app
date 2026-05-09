import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { computeImuReading } from '../lib/imu';
import {
  applyImuNoise,
  makeImuNoiseState,
  type ImuNoiseState,
} from '../lib/imuNoise';
import { scanLidar } from '../lib/lidar';
import {
  buildEventPath,
  detectContact,
  type ParametricPath,
  type ObstacleDisc,
} from '../lib/rover';
import { useStore } from '../store/useStore';

/**
 * Differential-drive rover rig — chassis + two wheels + caster +
 * forward sensor head. Pose comes from `roverPose`; the
 * `RoverController` writes it each frame while a procedural run is
 * active. When idle, the rover sits at the origin facing +Z so the
 * rig is still readable.
 *
 * Two sensor pipelines run while a recording is active:
 *
 *  - **chassis IMU** (6-channel) — body-local proper acceleration +
 *    angular velocity, derived from pose deltas via `computeImuReading`.
 *    Carries the collision/stuck signature an Edge Impulse classifier
 *    learns from. A contact-aware impulse is added on-impact so the
 *    accelerometer spike matches what a real bumper hit would feel.
 *  - **lidar / ToF ring** (N-channel) — range readings at 16+ angular
 *    bins, raycast against the obstacle group each frame. Useful as
 *    an additional input channel ("did we see the obstacle approaching?")
 *    and visually confirms the rig is sensing.
 */
const CHASSIS = { w: 0.5, h: 0.18, d: 0.7 };
const WHEEL_R = 0.12;
const WHEEL_T = 0.07;
const RIDE_HEIGHT = 0.05;
const HEAD_SIZE = 0.18;

/** Bounding-circle radius used by `detectContact`. Slightly larger than
 * the chassis half-diagonal so the contact event triggers a hair
 * before geometric overlap, matching how a real bumper switch fires. */
const CHASSIS_DISC_R = 0.36;

/** Frequency at which the live lidar visualization re-scans (independent
 * of recording cadence so the fan stays smooth on slower machines). */
const VISUAL_SCAN_HZ = 20;

/** Sampling rate for both lidar and chassis IMU during a recording. EI
 * handles arbitrary rates; 20 Hz × N channels gives plenty of resolution
 * for event detection without flooding the store. */
const RECORD_HZ = 20;

/** World-frame gravity vector. Identical to motion mode so the IMU
 * readout convention is consistent across modes. */
const G_WORLD: [number, number, number] = [0, -9.81, 0];

export function Rover({
  obstaclesRef,
}: {
  obstaclesRef: React.RefObject<THREE.Group>;
}) {
  const pose = useStore((s) => s.roverPose);
  const lidarBins = useStore((s) => s.robot.lidarBins);
  const lidarMaxRange = useStore((s) => s.robot.lidarMaxRange);

  const rigRef = useRef<THREE.Group>(null);

  useFrame(() => {
    const g = rigRef.current;
    if (!g) return;
    if (pose) {
      g.position.set(pose.x, 0, pose.z);
      g.rotation.set(0, pose.heading, 0);
    } else {
      g.position.set(0, 0, 0);
      g.rotation.set(0, 0, 0);
    }
  });

  return (
    <>
      <group ref={rigRef}>
        <RoverBody />
        <LidarFan
          bins={lidarBins}
          maxRange={lidarMaxRange}
          obstaclesRef={obstaclesRef}
          rigRef={rigRef}
        />
      </group>
      <RoverController />
      <RoverImuSampler rigRef={rigRef} />
    </>
  );
}

function RoverBody() {
  const chassisY = WHEEL_R + RIDE_HEIGHT;
  const inContact = useStore((s) => s.roverInContact);
  return (
    <>
      <mesh position={[0, chassisY, 0]} castShadow>
        <boxGeometry args={[CHASSIS.w, CHASSIS.h, CHASSIS.d]} />
        <meshStandardMaterial
          color={inContact ? '#7a2828' : '#2b3340'}
          roughness={0.6}
          metalness={0.3}
        />
      </mesh>
      <mesh
        position={[0, chassisY + CHASSIS.h / 2 + HEAD_SIZE / 2, 0]}
        castShadow
      >
        <boxGeometry args={[HEAD_SIZE, HEAD_SIZE, HEAD_SIZE]} />
        <meshStandardMaterial color="#0e1115" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh
        position={[0, chassisY + CHASSIS.h / 2 + HEAD_SIZE + 0.005, 0]}
        rotation={[Math.PI / 2, 0, 0]}
      >
        <torusGeometry args={[HEAD_SIZE * 0.45, 0.008, 8, 24]} />
        <meshBasicMaterial color="#5eead4" />
      </mesh>
      {/* Forward POV camera lens — visual marker for the front-facing
          camera mount. The actual camera is positioned via
          `scene.getObjectByName('rover-pov-mount')`. The named group
          below is the camera's parent, oriented to look along +Z
          (the rover's forward heading) once we apply the rover's yaw. */}
      <mesh
        position={[0, chassisY + CHASSIS.h / 2, CHASSIS.d / 2 + 0.02]}
        castShadow
      >
        <coneGeometry args={[0.06, 0.12, 16]} />
        <meshStandardMaterial
          color="#5eead4"
          roughness={0.3}
          metalness={0.1}
          emissive="#0d4d44"
          emissiveIntensity={0.6}
        />
      </mesh>
      <group
        name="rover-pov-mount"
        position={[0, chassisY + CHASSIS.h / 2 + 0.06, CHASSIS.d / 2 + 0.02]}
      />
      {/* Look-at anchor sitting 1 m ahead of the rover at chassis
          height — the POV camera uses `getWorldPosition` on this
          group to point itself the right way. */}
      <group
        name="rover-pov-look"
        position={[0, chassisY + CHASSIS.h / 2, CHASSIS.d / 2 + 1.0]}
      />
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          position={[side * (CHASSIS.w / 2 + WHEEL_T / 2), WHEEL_R, 0]}
          rotation={[0, 0, Math.PI / 2]}
          castShadow
        >
          <cylinderGeometry args={[WHEEL_R, WHEEL_R, WHEEL_T, 24]} />
          <meshStandardMaterial
            color="#1a1d22"
            roughness={0.85}
            metalness={0.1}
          />
        </mesh>
      ))}
      <mesh position={[0, WHEEL_R * 0.6, -CHASSIS.d / 2 + 0.05]} castShadow>
        <sphereGeometry args={[WHEEL_R * 0.6, 16, 12]} />
        <meshStandardMaterial color="#2b3340" roughness={0.7} metalness={0.2} />
      </mesh>
    </>
  );
}

/** Live lidar visualization + range sampler. Bin 0 points along the
 * rover's forward axis; bins sweep CCW. Beams that don't hit anything
 * within `maxRange` clamp to `maxRange` (ToF "no return"). */
function LidarFan({
  bins,
  maxRange,
  obstaclesRef,
  rigRef,
}: {
  bins: number;
  maxRange: number;
  obstaclesRef: React.RefObject<THREE.Group>;
  rigRef: React.RefObject<THREE.Group>;
}) {
  const linesRef = useRef<THREE.LineSegments>(null);
  const headY = WHEEL_R + RIDE_HEIGHT + 0.18 + HEAD_SIZE / 2;

  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(bins * 6), 3),
    );
    return g;
  }, [bins]);

  useEffect(() => {
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < bins; i++) {
      const theta = (i / bins) * Math.PI * 2;
      const o = i * 6;
      arr[o] = 0;
      arr[o + 1] = headY;
      arr[o + 2] = 0;
      arr[o + 3] = Math.sin(theta) * maxRange;
      arr[o + 4] = headY;
      arr[o + 5] = Math.cos(theta) * maxRange;
    }
    pos.needsUpdate = true;
  }, [geom, bins, maxRange, headY]);

  const visualAccum = useRef(0);
  const recordAccum = useRef(0);
  const visualPeriod = 1 / VISUAL_SCAN_HZ;
  const recordPeriod = 1 / RECORD_HZ;

  useFrame((_, dt) => {
    visualAccum.current += dt;
    recordAccum.current += dt;
    const wantVisual = visualAccum.current >= visualPeriod;
    const wantRecord = recordAccum.current >= recordPeriod;
    if (!wantVisual && !wantRecord) return;
    if (wantVisual) visualAccum.current = 0;
    if (wantRecord) recordAccum.current = 0;

    const rig = rigRef.current;
    const obstacles = obstaclesRef.current;
    if (!rig || !obstacles) return;

    const worldOrigin = new THREE.Vector3(0, headY, 0);
    rig.localToWorld(worldOrigin);
    const heading = rig.rotation.y;

    const ranges = scanLidar({
      origin: { x: worldOrigin.x, y: worldOrigin.y, z: worldOrigin.z },
      heading,
      bins,
      maxRange,
      target: obstacles,
    });

    if (wantVisual && linesRef.current) {
      const pos = geom.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let i = 0; i < bins; i++) {
        const theta = (i / bins) * Math.PI * 2;
        const o = i * 6;
        arr[o] = 0;
        arr[o + 1] = headY;
        arr[o + 2] = 0;
        arr[o + 3] = Math.sin(theta) * ranges[i];
        arr[o + 4] = headY;
        arr[o + 5] = Math.cos(theta) * ranges[i];
      }
      pos.needsUpdate = true;
    }

    if (wantRecord) {
      const { robotRunning, pushLidarSample } = useStore.getState();
      if (robotRunning) {
        pushLidarSample({ t: performance.now(), ranges });
      }
    }
  });

  return (
    <lineSegments ref={linesRef} geometry={geom}>
      <lineBasicMaterial
        color="#5eead4"
        transparent
        opacity={0.45}
        depthWrite={false}
      />
    </lineSegments>
  );
}

/**
 * Drive `roverPose` along a parametric path each frame. Listens for
 * `roverEpoch` bumps from the procedural runner; on each bump (while
 * the run flag is active) we build a fresh path for the currently-
 * selected event class against the live obstacle field, and start
 * driving from `t = 0`. `t` advances at constant rate so each window
 * covers exactly one full traversal regardless of path arc length.
 */
function RoverController() {
  const epoch = useStore((s) => s.roverEpoch);
  const event = useStore((s) => s.robot.roverEvent);
  const durationMs = useStore((s) => s.robot.durationMs);
  const robotRunning = useStore((s) => s.robotRunning);
  const setRoverPose = useStore((s) => s.setRoverPose);

  const pathRef = useRef<ParametricPath | null>(null);
  const startMs = useRef(0);

  useEffect(() => {
    if (!robotRunning) {
      pathRef.current = null;
      return;
    }
    // Snapshot the obstacle field at start-of-iteration so the path
    // generator and contact detector see a stable layout, even if the
    // user drags an obstacle mid-run. Each scene object is
    // approximated as a bounding circle r ≈ scale·0.32, matching the
    // largest primitive radius the spawner ships.
    const state = useStore.getState();
    const obstacles: ObstacleDisc[] = state.sceneObjects
      .filter((o) => o.owner === 'rover')
      .map((o) => ({
        x: o.position[0],
        z: o.position[2],
        r: Math.max(0.05, o.scale * 0.32),
      }));
    pathRef.current = buildEventPath(event, obstacles, Math.random);
    startMs.current = performance.now();
    setRoverPose(pathRef.current.sample(0));
  }, [epoch, event, robotRunning, setRoverPose]);

  useFrame(() => {
    const path = pathRef.current;
    if (!path || !robotRunning) return;
    const elapsed = performance.now() - startMs.current;
    const t = Math.max(0, Math.min(1, elapsed / Math.max(1, durationMs)));
    setRoverPose(path.sample(t));
  });

  return null;
}

/**
 * Per-frame chassis IMU sampler. Reads the rover's world-space pose
 * from `rigRef`, derives linvel from pose deltas (the rover is
 * kinematic so Rapier's `linvel()` reports zero), and feeds
 * `computeImuReading` with the same convention as motion mode.
 *
 * On contact, we add a brief world-frame impulse to the linvel
 * difference: this synthesizes the accel spike a real bumper-equipped
 * rover would feel, scaled to the penetration depth so harder
 * collisions read as bigger spikes. The store flag `roverInContact`
 * is also flipped here so the rig material can show the contact
 * state and the runner can tag the recording.
 */
function RoverImuSampler({
  rigRef,
}: {
  rigRef: React.RefObject<THREE.Group>;
}) {
  const recordAccum = useRef(0);
  const recordPeriod = 1 / RECORD_HZ;
  const sampleInit = useRef(false);
  const prevPos = useRef(new THREE.Vector3());
  const prevQuat = useRef(new THREE.Quaternion());
  const prevLinvel = useRef(new THREE.Vector3());
  // Per-rover IMU noise state — bias drift accumulators + per-axis
  // scale-factor errors. Initialized once; the bias random walk
  // mutates in place each tick (see `applyImuNoise`).
  const noiseState = useRef<ImuNoiseState | null>(null);

  useFrame((_, dt) => {
    recordAccum.current += dt;
    if (recordAccum.current < recordPeriod) return;
    const sampleDt = recordAccum.current;
    recordAccum.current = 0;

    const rig = rigRef.current;
    if (!rig) return;

    // World pose. Rover lives at y = 0 so the height term is constant.
    const curPos = new THREE.Vector3();
    rig.getWorldPosition(curPos);
    const curQuat = new THREE.Quaternion();
    rig.getWorldQuaternion(curQuat);

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

    // Contact-aware accel spike: when the chassis disc overlaps a
    // scene object, decelerate the apparent linvel sharply along the
    // contact normal (penetration-depth-scaled). This produces the
    // accelerometer signature a real bumper switch would induce.
    const liveState = useStore.getState();
    const obstacles: ObstacleDisc[] = liveState.sceneObjects
      .filter((o) => o.owner === 'rover')
      .map((o) => ({
        x: o.position[0],
        z: o.position[2],
        r: Math.max(0.05, o.scale * 0.32),
      }));
    const contact = detectContact(
      { x: curPos.x, z: curPos.z },
      CHASSIS_DISC_R,
      obstacles,
    );
    const setRoverInContact = useStore.getState().setRoverInContact;
    setRoverInContact(!!contact);
    if (contact) {
      const dx = curPos.x - contact.obstacle.x;
      const dz = curPos.z - contact.obstacle.z;
      const dlen = Math.max(1e-3, Math.sqrt(dx * dx + dz * dz));
      const nx = dx / dlen;
      const nz = dz / dlen;
      // Spike magnitude grows with penetration depth, capped to keep
      // the IMU range plausible for an Arduino-class accelerometer.
      const spike = Math.min(8, contact.penetration * 60);
      linvel.x += nx * spike * sampleDt;
      linvel.z += nz * spike * sampleDt;
    }

    // Angular velocity from quat deltas (world frame).
    const dq = curQuat.clone().multiply(prevQuat.current.clone().invert());
    // Convert quaternion delta to world-frame angular velocity vector.
    const angle = 2 * Math.atan2(
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

    // Apply MathWorks-style sensor noise to the clean reading. The
    // bias drift accumulators inside `noiseState` advance in place
    // so the recorded trace exhibits realistic Allan-variance bias
    // wandering across the window, not just per-sample white noise.
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
