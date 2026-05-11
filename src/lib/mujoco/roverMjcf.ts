/**
 * MJCF generator for the differential-drive rover used in robotics
 * mode. The chassis is a single rigid body confined to the ground
 * plane by three joints — two slides for (x, z) translation and one
 * hinge for yaw — driven by position actuators. Trajectories push
 * targets into those actuators; MuJoCo integrates mass + damping so
 * the IMU reads physical motion instead of pose-deltas of a
 * teleported chassis.
 *
 * Obstacles are now part of the MJCF too: each rover-owned scene
 * object becomes a static body at its world position, with collision
 * geometry sized to match the visual mesh. The integrator handles
 * chassis-obstacle contacts directly — the IMU spike on impact is
 * whatever the contact solver produces, no hand-tuned impulses. Since
 * the obstacle set can change between iterations (user adds/removes,
 * or "Reset scene" regenerates), the MJCF is rebuilt on demand and
 * `RoverSim.rebuildWithObstacles` swaps it in.
 *
 * The lidar fan still raycasts against the three.js obstacle group —
 * that's cheap and avoids needing to plumb MuJoCo's rangefinder
 * sensors through (which would be N sites in the MJCF, set up per
 * `lidarBins`).
 *
 * Y-up world to match three.js and the arm MJCF.
 */

import { ROVER_DIMS } from './roverDims';

const D = ROVER_DIMS;
const CHASSIS_Y = D.wheelR + D.rideHeight;

// Generous slide ranges — the rover roams a few meters in either
// direction in the procedural paths. The hinge can spin freely;
// `limited="false"` keeps MuJoCo from wrapping at ±π.
const SLIDE_RANGE: readonly [number, number] = [-10, 10];

/** Static obstacle as a vertical cylinder (matches the visual scene
 * objects, which are box-shaped but contact against the chassis like a
 * column). `r` is the bounding circle radius from the scene-object
 * scale × 0.32 — same scaling the previous disc-circle math used, so
 * the new MuJoCo contacts trigger at the same distances. */
export type RoverObstacle = {
  /** Stable id used to name the MJCF body (alphanumeric only). */
  id: string;
  x: number;
  z: number;
  r: number;
  /** Visual height — informational only. Cylinders extend from the
   * floor to `2 * height` (height is the half-extent expected by
   * MuJoCo's cylinder geom). */
  height: number;
};

/** Sanitize a scene-object id into something MJCF-safe. Body names
 * must be valid identifiers (no dashes), so UUIDs get stripped to
 * their hex digits. */
function safeName(id: string): string {
  return 'obs_' + id.replace(/[^a-zA-Z0-9]/g, '');
}

export function roverMjcf(obstacles: ReadonlyArray<RoverObstacle> = []): string {
  const obstacleBodies = obstacles
    .map((o) => {
      const h = Math.max(0.02, o.height);
      return `    <body name="${safeName(o.id)}" pos="${o.x.toFixed(4)} ${h.toFixed(4)} ${o.z.toFixed(4)}">
      <geom type="cylinder" size="${o.r.toFixed(4)} ${h.toFixed(4)}"
            quat="0.7071 0.7071 0 0"
            rgba="0.48 0.16 0.16 1" friction="0.8 0.05 0.005"/>
    </body>`;
    })
    .join('\n');

  return `
<mujoco model="rover">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.005" gravity="0 -9.81 0" integrator="implicitfast"/>

  <default>
    <joint armature="0.05" damping="5"/>
    <position kp="200" kv="30" forcerange="-200 200"/>
  </default>

  <worldbody>
    <geom name="floor" type="plane" size="20 20 0.1" pos="0 0 0" zaxis="0 1 0"
          rgba="0.10 0.11 0.13 1" friction="0.8 0.05 0.005"/>

    <body name="chassis" pos="0 ${CHASSIS_Y.toFixed(4)} 0">
      <!-- 2D planar locomotion: x slide, z slide, y-axis yaw hinge.
           Order matches the controller's [x, z, heading] target vector. -->
      <joint name="j_x"   type="slide" axis="1 0 0" range="${SLIDE_RANGE[0]} ${SLIDE_RANGE[1]}" limited="false"/>
      <joint name="j_z"   type="slide" axis="0 0 1" range="${SLIDE_RANGE[0]} ${SLIDE_RANGE[1]}" limited="false"/>
      <joint name="j_yaw" type="hinge" axis="0 1 0" limited="false"/>

      <geom name="g_chassis" type="box"
            size="${(D.chassis.w / 2).toFixed(4)} ${(D.chassis.h / 2).toFixed(4)} ${(D.chassis.d / 2).toFixed(4)}"
            mass="2.5" rgba="0.17 0.20 0.25 1" friction="0.8 0.05 0.005"/>

      <site name="imu" pos="0 0 0" size="0.01"/>
    </body>

${obstacleBodies}
  </worldbody>

  <actuator>
    <position name="a_x"   joint="j_x"   ctrlrange="${SLIDE_RANGE[0]} ${SLIDE_RANGE[1]}"/>
    <position name="a_z"   joint="j_z"   ctrlrange="${SLIDE_RANGE[0]} ${SLIDE_RANGE[1]}"/>
    <position name="a_yaw" joint="j_yaw" ctrlrange="-31.4 31.4" kp="80" kv="10"/>
  </actuator>

  <sensor>
    <accelerometer name="imu_accel" site="imu"/>
    <gyro          name="imu_gyro"  site="imu"/>
    <framequat     name="imu_quat"  objtype="site" objname="imu"/>
    <framepos      name="imu_pos"   objtype="site" objname="imu"/>
  </sensor>
</mujoco>
`.trim();
}

/** Legacy export — the obstacle-less version, kept for any caller that
 * still wants the baseline model. The runtime always uses
 * `roverMjcf(obstacles)` now. */
export const ROVER_MJCF = roverMjcf();

export const ROVER_ACTUATOR_NAMES = ['a_x', 'a_z', 'a_yaw'] as const;
export const ROVER_JOINT_NAMES = ['j_x', 'j_z', 'j_yaw'] as const;
export const ROVER_IMU_SENSOR_NAMES = {
  accel: 'imu_accel',
  gyro: 'imu_gyro',
  quat: 'imu_quat',
  pos: 'imu_pos',
} as const;
export const ROVER_CHASSIS_BODY = 'chassis';
