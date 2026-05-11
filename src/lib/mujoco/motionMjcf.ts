/**
 * MJCF template for motion mode. One free-joint body for the
 * manipulated object (the cube/sphere/phone/etc. the user throws
 * around), plus a hidden mocap "hand" body whose pose is written each
 * frame while a pinch is active. A weld equality constraint between
 * the two pulls the object to the hand when enabled; disabling it
 * lets the object free-fall under gravity. That's the entire
 * grabbed/released mechanic — no Rapier body-type switching.
 *
 * The geom on the manipulated body switches with `ObjectKind` so the
 * captured IMU traces have the right inertia tensor for the shape.
 * Mass values are tuned so the readings sit in the same ballpark as
 * the previous Rapier setup — captures from before the migration
 * should still classify against a model trained on this data.
 *
 * Floor + walls are baked into the MJCF so the body bounces off the
 * ground naturally. Motion mode doesn't render a conveyor (that lives
 * in vision modes), so we don't need that geometry here.
 */

import type { ObjectKind } from '../../store/useStore';

/** Per-shape geom + inertial description. Returns the inner block of
 * the manipulated body — geom XML and optional inertial XML. */
function shapeGeom(kind: ObjectKind): { geom: string; mass: number } {
  // Mass values target ~120 g for a typical "small object" payload,
  // tuned per-shape so the rotational inertia about the IMU site is
  // in the range a hand-held object would have. The accelerometer
  // doesn't directly read mass; the gyro readings do, via angular
  // momentum.
  switch (kind) {
    case 'sphere':
      return {
        geom: `<geom name="g_body" type="sphere" size="0.5" mass="0.12" rgba="0.96 0.62 0.04 1" friction="0.6 0.05 0.005"/>`,
        mass: 0.12,
      };
    case 'phone':
      return {
        geom: `<geom name="g_body" type="box" size="0.35 0.7 0.05" mass="0.15" rgba="0.96 0.62 0.04 1" friction="0.6 0.05 0.005"/>`,
        mass: 0.15,
      };
    case 'capsule':
      // MuJoCo capsule defaults to a local-Z long axis; three.js
      // CapsuleGeometry lives along local-Y. Rotate the geom 90° about
      // X so physics and visual agree — otherwise the mesh sits at a
      // 90° offset from the collision shape and dips through the floor.
      return {
        geom: `<geom name="g_body" type="capsule" size="0.35 0.4" quat="0.7071 0.7071 0 0" mass="0.12" rgba="0.96 0.62 0.04 1" friction="0.6 0.05 0.005"/>`,
        mass: 0.12,
      };
    case 'cylinder':
      return {
        geom: `<geom name="g_body" type="cylinder" size="0.4 0.45" quat="0.7071 0.7071 0 0" mass="0.12" rgba="0.96 0.62 0.04 1" friction="0.6 0.05 0.005"/>`,
        mass: 0.12,
      };
    case 'cone':
      // MuJoCo has no built-in cone geom; approximate as a cylinder
      // sized to the cone's bounding cylinder so when the body tips
      // onto its side the cone visual doesn't dip past the collider
      // and clip through the floor. A capsule with the same radius
      // would have hemispherical caps that read as "bouncy" against
      // a flat plane, so cylinder is the better collision proxy.
      // Three.js coneGeometry(0.5, 1.0) lives on local-Y, which means
      // the cylinder needs a 90° X-rotation quat to align.
      return {
        geom: `<geom name="g_body" type="cylinder" size="0.5 0.5" quat="0.7071 0.7071 0 0" mass="0.12" rgba="0.96 0.62 0.04 1" friction="0.6 0.05 0.005"/>`,
        mass: 0.12,
      };
    case 'torus':
      // No torus primitive either; approximate with a flat cylinder
      // sized to the torus's outer envelope. Radius 0.55 = major 0.4
      // + tube 0.15 so when the torus tips onto its side the visual
      // edge still rests on the collider, not through the floor.
      // three.js TorusGeometry lives in the XY plane (axis along
      // local-Z), which matches MuJoCo's default cylinder
      // orientation — so no quat is needed here.
      return {
        geom: `<geom name="g_body" type="cylinder" size="0.55 0.15" mass="0.12" rgba="0.96 0.62 0.04 1" friction="0.6 0.05 0.005"/>`,
        mass: 0.12,
      };
    case 'soda_can':
      return {
        geom: `<geom name="g_body" type="cylinder" size="0.27 0.4" quat="0.7071 0.7071 0 0" mass="0.15" rgba="0.96 0.62 0.04 1" friction="0.6 0.05 0.005"/>`,
        mass: 0.15,
      };
    case 'cube':
    default:
      return {
        geom: `<geom name="g_body" type="box" size="0.4 0.4 0.4" mass="0.12" rgba="0.96 0.62 0.04 1" friction="0.6 0.05 0.005"/>`,
        mass: 0.12,
      };
  }
}

export function motionMjcf(kind: ObjectKind): string {
  const { geom } = shapeGeom(kind);
  return `
<mujoco model="motion-${kind}">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.005" gravity="0 -9.81 0" integrator="implicitfast"/>

  <default>
    <geom solref="0.005 1" solimp="0.95 0.99 0.001"/>
  </default>

  <worldbody>
    <!-- Ground plane. The body bounces off this; tuned so the post-
         impact accelerometer trace shows a credible decay, not a
         dead-flat slap. -->
    <geom name="floor" type="plane" size="20 20 0.1" pos="0 0 0" zaxis="0 1 0"
          rgba="0.10 0.11 0.13 1" friction="0.6 0.05 0.005"/>

    <!-- Mocap "hand" body. Pose is written each frame via
         data.mocap_pos / data.mocap_quat while a pinch is active.
         Invisible (rgba alpha = 0) — visualization is handled by the
         three.js PinchMarker. -->
    <body name="hand" pos="0 1 0" mocap="true">
      <geom name="g_hand" type="sphere" size="0.001" rgba="0 0 0 0" contype="0" conaffinity="0"/>
    </body>

    <!-- Manipulated object. Free joint gives it full 6-DOF motion.
         The IMU site sits at the body center so accel/gyro readings
         are reported about the object's local frame. -->
    <body name="object" pos="0 2 0">
      <freejoint name="j_obj"/>
      ${geom}
      <site name="imu" pos="0 0 0" size="0.005"/>
    </body>
  </worldbody>

  <equality>
    <!-- Weld constraint between hand and object. While disabled
         (active="false"), the object is fully free. The runtime
         toggles eq_active[0] = 1 on grab and 0 on release.
         solref controls compliance: a moderately soft weld (15 ms
         time-constant) so the IMU reads a credible acceleration
         while the hand drags the body, instead of a teleport.

         relpose is critical: MuJoCo's default ("0 0 0 0 0 0 0") tells
         the weld to enforce the body's relative pose at qpos0 — i.e.
         the hand/object spawn offset baked into the MJCF — which
         would leave the cube floating one meter above the hand
         forever. The explicit identity ("0 0 0 1 0 0 0") pins the
         object exactly to the hand's pose whenever the weld is
         active. -->
    <weld name="grab" body1="hand" body2="object" active="false"
          solref="0.015 1" relpose="0 0 0 1 0 0 0"/>
  </equality>

  <sensor>
    <accelerometer name="imu_accel" site="imu"/>
    <gyro          name="imu_gyro"  site="imu"/>
    <framequat     name="imu_quat"  objtype="site" objname="imu"/>
    <framepos      name="imu_pos"   objtype="site" objname="imu"/>
  </sensor>
</mujoco>
`.trim();
}

export const MOTION_BODY_NAMES = {
  hand: 'hand',
  object: 'object',
} as const;

export const MOTION_FREE_JOINT_NAME = 'j_obj';
export const MOTION_WELD_EQUALITY_NAME = 'grab';

export const MOTION_IMU_SENSOR_NAMES = {
  accel: 'imu_accel',
  gyro: 'imu_gyro',
  quat: 'imu_quat',
  pos: 'imu_pos',
} as const;
