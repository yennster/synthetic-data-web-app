import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { scanLidar } from '../lib/lidar';
import {
  buildEventPath,
  type ParametricPath,
  type ObstacleDisc,
} from '../lib/rover';
import { RoverSim } from '../lib/mujoco/RoverSim';
import { ROVER_DIMS } from '../lib/mujoco/roverDims';
import { sampleImu, type NoiseStateRef } from '../lib/mujoco/imuSensor';
import type { RoverObstacle } from '../lib/mujoco/roverMjcf';
import { loadMujocoModule } from '../lib/mujoco/runtime';
import { getImportedAssetScaledSize } from '../lib/importedAssetBounds';
import { useStore, type ImportedAsset } from '../store/useStore';

/**
 * Physics-backed differential-drive rover. MuJoCo owns the chassis
 * dynamics: a planar-jointed body driven by position actuators where
 * the trajectory's (x, z, heading) keyframes are the targets. The
 * visual rig sits at whatever pose MuJoCo's integrator settles on,
 * mass and damping mean the rover doesn't snap to its target — it
 * accelerates, overshoots a little, and decays into place. The IMU
 * sees that motion directly through MuJoCo's accelerometer and gyro
 * sensors at the chassis site.
 *
 * Contact handling: we still detect overlap with scene obstacles using
 * the same 2D disc-circle math (cheap and obstacle-edits don't force
 * a sim recompile), but instead of hand-tuning an accelerometer spike
 * we apply a real impulse to the chassis through `qfrc_applied`. The
 * resulting accelerometer response — magnitude, decay envelope,
 * post-impact oscillation — is whatever the integrator produces under
 * the chassis's mass and joint damping. No more synthetic spikes.
 *
 * Lidar stays on three.js raycasts against the obstacle group — pulling
 * obstacles into MJCF would mean recompiling on every drag.
 */

const CHASSIS = ROVER_DIMS.chassis;
const WHEEL_R = ROVER_DIMS.wheelR;
const WHEEL_T = ROVER_DIMS.wheelT;
const RIDE_HEIGHT = ROVER_DIMS.rideHeight;
const HEAD_SIZE = ROVER_DIMS.headSize;
const VISUAL_SCAN_HZ = 20;
const RECORD_HZ = 20;

/** Map a rover-owned scene object to a `RoverObstacle` for the MJCF.
 * Position + bounding radius use the same conventions the lidar /
 * trajectory code uses (scale × 0.32). Height is fixed at a small
 * column so cylinders barely poke above the chassis — they're meant
 * to be hit, not climbed. */
function sceneObjectsToObstacles(
  objects: ReadonlyArray<{
    id: string;
    owner?: string;
    position: [number, number, number];
    scale: number;
  }>,
): RoverObstacle[] {
  return objects
    .filter((o) => o.owner === 'rover')
    .map((o) => ({
      id: o.id,
      x: o.position[0],
      z: o.position[2],
      r: Math.max(0.05, o.scale * 0.32),
      height: 0.2,
    }));
}

function importedAssetsToObstacles(
  assets: ReadonlyArray<ImportedAsset>,
): RoverObstacle[] {
  return assets
    .filter((a) => a.owner === 'rover')
    .map((a) => {
      const [w, h, d] = getImportedAssetScaledSize(a);
      return {
        id: a.id,
        x: a.position[0],
        z: a.position[2],
        r: Math.max(0.05, Math.hypot(w, d) / 2),
        height: Math.max(0.02, h / 2),
      };
    });
}

function useRoverSim(): RoverSim | null {
  const [sim, setSim] = useState<RoverSim | null>(null);
  useEffect(() => {
    let cancelled = false;
    let local: RoverSim | null = null;
    loadMujocoModule().then((mujoco) => {
      if (cancelled) return;
      local = new RoverSim(mujoco);
      local.snapToPose({ x: 0, z: 0, heading: 0 });
      setSim(local);
    });
    return () => {
      cancelled = true;
      local?.dispose();
    };
  }, []);
  return sim;
}

export function Rover({
  obstaclesRef,
}: {
  obstaclesRef: React.RefObject<THREE.Group>;
}) {
  const sim = useRoverSim();
  const lidarBins = useStore((s) => s.robot.lidarBins);
  const lidarMaxRange = useStore((s) => s.robot.lidarMaxRange);

  const rigRef = useRef<THREE.Group>(null);

  // Pull the rig's transform from MuJoCo each frame. The store's
  // `roverPose` is also updated so panels / overlays that read it
  // (HUD, trajectory debug, capture pipeline) see the simulated pose,
  // not the trajectory target.
  useFrame(() => {
    const g = rigRef.current;
    if (!g) return;
    if (sim) {
      const pose = sim.readPose();
      g.position.set(pose.x, 0, pose.z);
      g.rotation.set(0, pose.heading, 0);
      useStore.getState().setRoverPose(pose);
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
      <RoverController sim={sim} />
      <RoverImuSampler sim={sim} rigRef={rigRef} />
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

/** Live lidar visualization + range sampler. Unchanged from the
 * kinematic version — beams are raycast against the three.js obstacle
 * group each frame using the rig's current world transform (which now
 * reflects MuJoCo's integrated pose). */
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
    // The named handle lets the POV-camera bridge find this mesh and
    // hide it just before an object-detection capture so the beam
    // overlay doesn't get burned into the training image. Live preview
    // keeps showing the beams (they only flip invisible for the one
    // synchronous render call inside `captureFrame`).
    <lineSegments
      ref={linesRef}
      geometry={geom}
      name="rover-lidar-fan"
      userData={{ hideForCapture: true }}
    >
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
 * Drive MuJoCo's planar position actuators along the parametric path.
 * Mirrors the arm controller: epoch-bump rebuilds the path, then each
 * frame writes the next (x, z, heading) target into `sim.setTargets`.
 * MuJoCo's PD controllers + chassis mass do the rest.
 */
function RoverController({ sim }: { sim: RoverSim | null }) {
  const epoch = useStore((s) => s.roverEpoch);
  const event = useStore((s) => s.robot.roverEvent);
  const durationMs = useStore((s) => s.robot.durationMs);
  const robotRunning = useStore((s) => s.robotRunning);

  const pathRef = useRef<ParametricPath | null>(null);
  const startMs = useRef(0);

  useEffect(() => {
    if (!sim || !robotRunning) {
      pathRef.current = null;
      return;
    }
    const state = useStore.getState();
    const mjcfObstacles = [
      ...sceneObjectsToObstacles(state.sceneObjects),
      ...importedAssetsToObstacles(state.assets),
    ];
    // Rebuild the model with the current obstacle set so MuJoCo's
    // collision system has bodies to hit. This is a no-op if the
    // obstacle list hasn't changed since the last iteration.
    sim.rebuildWithObstacles(mjcfObstacles);
    // The trajectory engine still uses the disc-radius obstacle
    // representation to plan paths that aim at / around them. The
    // shape is purely for trajectory generation; collisions during the
    // run come from MuJoCo's body contacts.
    const trajectoryObstacles: ObstacleDisc[] = mjcfObstacles.map((o) => ({
      x: o.x,
      z: o.z,
      r: o.r,
    }));
    pathRef.current = buildEventPath(event, trajectoryObstacles, Math.random);
    startMs.current = performance.now();
    // Snap the chassis to the path's start pose so the first physics
    // step isn't a PD chase from wherever the previous iteration left
    // off. The IMU sampler skips its first reading post-snap to avoid
    // a velocity-spike artifact.
    sim.snapToPose(pathRef.current.sample(0));
  }, [epoch, event, robotRunning, sim]);

  useFrame(() => {
    const path = pathRef.current;
    if (!path || !robotRunning || !sim) return;
    const elapsed = performance.now() - startMs.current;
    const t = Math.max(0, Math.min(1, elapsed / Math.max(1, durationMs)));
    sim.setTargets(path.sample(t));
  });

  return null;
}

/**
 * IMU sampler + contact handler. The accel/gyro readings come straight
 * from MuJoCo's sensors at the chassis site, so the dynamics of the
 * planar controllers + body mass produce the trace shape — there's no
 * pose-delta math left in the data path.
 *
 * Contact: we keep the disc-circle overlap check (it's cheap and the
 * obstacle set can change between iterations without forcing a sim
 * recompile), but the bumper-hit accelerometer signature now comes
 * from a real impulse applied through `qfrc_applied`. The integrator
 * decides the spike envelope.
 *
 * The sim also steps from inside this component each frame — there's
 * only one MuJoCo instance per rover, so co-locating step + sample
 * keeps the order of operations obvious (apply force → step → read).
 */
function RoverImuSampler({
  sim,
  rigRef,
}: {
  sim: RoverSim | null;
  rigRef: React.RefObject<THREE.Group>;
}) {
  const recordAccum = useRef(0);
  const recordPeriod = 1 / RECORD_HZ;
  const noiseStateRef = useRef<NoiseStateRef>({ current: null });

  useFrame((_, dt) => {
    if (!sim) return;

    sim.step(dt);
    const pose = sim.readPose();
    // Push the contact flag to the store so the rig material can show
    // the bumper state. MuJoCo's collision detector runs inside
    // `mj_step` above, so this is just a query against the latest
    // contact list — no overlap math here.
    useStore.getState().setRoverInContact(sim.chassisInContact());
    // Force the rig's transform now so the lidar (which reads
    // `rigRef.current.localToWorld`) sees this frame's pose, not the
    // previous one.
    const g = rigRef.current;
    if (g) {
      g.position.set(pose.x, 0, pose.z);
      g.rotation.set(0, pose.heading, 0);
    }

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
