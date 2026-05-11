/**
 * Hand-authored MJCF for the differential-drive rover used in robotics
 * mode. The chassis is a single rigid body confined to the ground plane
 * by three joints — two slides for (x, z) translation and one hinge for
 * yaw — driven by position actuators. Trajectories push targets into
 * those actuators; MuJoCo integrates mass + damping so the IMU reads
 * physical motion instead of pose-deltas of a teleported chassis.
 *
 * Why planar joints instead of a `free` joint:
 *   - The procedural trajectory engine generates a 2D path (x, z, heading)
 *     and the visual rig has always sat at y = 0. A free joint would
 *     let the chassis tip / fall, which isn't what we want for a
 *     synthetic-data generator with scripted motion.
 *   - Three actuators with `position`-style PD control are enough; we
 *     don't need wheel hinges or motor models to get a plausible IMU.
 *
 * Y-up world to match three.js and the arm MJCF.
 *
 * Sensors at the chassis IMU site (placed at the geometric center of
 * the box, so the gyro reads body-frame angular velocity around the
 * yaw axis cleanly):
 *
 *   imu_accel   body-frame linear acceleration (gravity-included)
 *   imu_gyro    body-frame angular velocity
 *   imu_quat    world-frame orientation
 *   imu_pos     world-frame position
 *
 * The lidar fan stays in three.js (raycasting against the obstacle
 * group) — pulling obstacles into MJCF would mean recompiling the
 * model on every drag, which isn't worth the complexity here.
 */

import { ROVER_DIMS } from './roverDims';

const D = ROVER_DIMS;
const CHASSIS_Y = D.wheelR + D.rideHeight;

// Generous slide ranges — the rover roams a few meters in either
// direction in the procedural paths. The hinge can spin freely;
// `limited="false"` keeps MuJoCo from wrapping at ±π.
const SLIDE_RANGE: readonly [number, number] = [-10, 10];

export const ROVER_MJCF = `
<mujoco model="rover">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.005" gravity="0 -9.81 0" integrator="implicitfast"/>

  <default>
    <joint armature="0.05" damping="5"/>
    <position kp="200" kv="30" forcerange="-200 200"/>
  </default>

  <worldbody>
    <body name="chassis" pos="0 ${CHASSIS_Y.toFixed(4)} 0">
      <!-- 2D planar locomotion: x slide, z slide, y-axis yaw hinge.
           Order matches the controller's [x, z, heading] target vector. -->
      <joint name="j_x"   type="slide" axis="1 0 0" range="${SLIDE_RANGE[0]} ${SLIDE_RANGE[1]}" limited="false"/>
      <joint name="j_z"   type="slide" axis="0 0 1" range="${SLIDE_RANGE[0]} ${SLIDE_RANGE[1]}" limited="false"/>
      <joint name="j_yaw" type="hinge" axis="0 1 0" limited="false"/>

      <geom name="g_chassis" type="box"
            size="${(D.chassis.w / 2).toFixed(4)} ${(D.chassis.h / 2).toFixed(4)} ${(D.chassis.d / 2).toFixed(4)}"
            mass="2.5" rgba="0.17 0.20 0.25 1"/>

      <site name="imu" pos="0 0 0" size="0.01"/>
    </body>
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

export const ROVER_ACTUATOR_NAMES = ['a_x', 'a_z', 'a_yaw'] as const;
export const ROVER_JOINT_NAMES = ['j_x', 'j_z', 'j_yaw'] as const;
export const ROVER_IMU_SENSOR_NAMES = {
  accel: 'imu_accel',
  gyro: 'imu_gyro',
  quat: 'imu_quat',
  pos: 'imu_pos',
} as const;
export const ROVER_CHASSIS_BODY = 'chassis';
