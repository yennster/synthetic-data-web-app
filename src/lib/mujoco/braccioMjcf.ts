/**
 * Hand-authored MJCF (MuJoCo XML) model for the Arduino TinkerKit
 * Braccio. The chain mirrors the visual rig in `BraccioArm.tsx` joint-
 * for-joint, with the same link lengths from `BRACCIO_LINKS` and the
 * same servo angle ranges from `BRACCIO_LIMITS_RAD`. Visual geoms are
 * primitives (cylinders + boxes) — the three.js rig is the source of
 * truth for rendering; MuJoCo's geoms exist only so contacts work and
 * inertias have something to derive from.
 *
 * World convention: Y-up to match three.js. MuJoCo doesn't enforce an
 * up axis — gravity is just a vector — so the only adjustment is the
 * `<option gravity="0 -9.81 0"/>` line plus joint axes laid out in the
 * same XYZ basis as the three.js groups.
 *
 * Joint mapping (preserved from the original kinematic rig):
 *   j_base         hinge about +Y   (M1 base yaw)
 *   j_shoulder     hinge about +X   (M2 shoulder pitch)
 *   j_elbow        hinge about +X   (M3 elbow pitch)
 *   j_wrist_pitch  hinge about +X   (M4 wrist pitch)
 *   j_wrist_roll   hinge about +Y   (M5 wrist roll)
 *   j_grip_l/r     slide along ±X   (M6 parallel-jaw fingers, mirrored)
 *
 * Sensors at the end-effector `imu` site:
 *   imu_accel  body-frame linear acceleration (includes gravity)
 *   imu_gyro   body-frame angular velocity
 *   imu_quat   world-frame orientation of the site
 *
 * Actuators are position-controlled: each `data.ctrl[i]` is a *target*
 * joint angle and MuJoCo's PD law drives the joint there with realistic
 * inertia + gravity dynamics. That's what the IMU reads — not a
 * pre-computed kinematic chain like before.
 */

import { BRACCIO_LIMITS_RAD, BRACCIO_LINKS } from '../braccio';
import { clamp, clamp01 } from '../math';

const L = BRACCIO_LINKS;

// MJCF uses degrees by default for joint ranges; switch the model to
// radians so we can paste in `BRACCIO_LIMITS_RAD` values directly.
function rng([lo, hi]: readonly [number, number]): string {
  return `${lo.toFixed(4)} ${hi.toFixed(4)}`;
}

// Slide-joint range for one finger: half the published gripper width
// (the two fingers spread symmetrically from center). 0 = closed,
// gripperWidth/2 = fully open. Aperture in [0, 1] maps linearly to this.
const HALF_GRIP = L.gripperWidth / 2;

export type BraccioTargetBox = {
  halfExtents: readonly [number, number, number];
};

export const DEFAULT_BRACCIO_TARGET_BOX: BraccioTargetBox = {
  halfExtents: [0.015, 0.015, 0.015],
};

function targetHalfExtents(box: BraccioTargetBox): [number, number, number] {
  const [x, y, z] = box.halfExtents;
  return [
    Math.max(0.003, x),
    Math.max(0.003, y),
    Math.max(0.003, z),
  ];
}

function targetMass([x, y, z]: readonly [number, number, number]): number {
  const defaultVolume = 0.03 ** 3;
  const volume = (x * 2) * (y * 2) * (z * 2);
  const mass = 0.015 * (volume / defaultVolume);
  return clamp(mass, 0.005, 0.12);
}

export function braccioMjcf(
  targetBox: BraccioTargetBox = DEFAULT_BRACCIO_TARGET_BOX,
): string {
  const [targetX, targetY, targetZ] = targetHalfExtents(targetBox);
  const mass = targetMass([targetX, targetY, targetZ]);
  return `
<mujoco model="braccio">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.002" gravity="0 -9.81 0" integrator="implicitfast"/>

  <default>
    <joint armature="0.01" damping="0.5"/>
    <position kp="50" kv="2" forcerange="-5 5"/>
    <geom rgba="0.36 0.41 0.49 1" friction="0.8 0.05 0.005"/>
  </default>

  <asset>
    <texture name="grid" type="2d" builtin="checker" rgb1="0.1 0.1 0.12" rgb2="0.15 0.16 0.2" width="300" height="300"/>
    <material name="grid" texture="grid" texrepeat="8 8" reflectance="0.1"/>
  </asset>

  <worldbody>
    <light name="top" pos="0 2 0" dir="0 -1 0" diffuse="1 1 1"/>
    <geom name="floor" type="plane" size="2 2 0.1" material="grid" pos="0 0 0" zaxis="0 1 0"
          friction="0.8 0.05 0.005"/>

    <!-- Pickup target. A free-joint box placed by the arm controller at
         run start to match the user's selected scene object. The default
         is a 3 cm Braccio demo cube; imported USDZ pickups rebuild the
         model with half-extents approximating the imported asset's scaled
         bounds so the gripper collides with the visible volume. Friction
         is tuned so the gripper fingers can hold it under load without
         slipping. -->
    <body name="target" pos="0.18 ${targetY.toFixed(4)} 0.12">
      <freejoint name="j_target"/>
      <geom name="g_target" type="box"
            size="${targetX.toFixed(4)} ${targetY.toFixed(4)} ${targetZ.toFixed(4)}"
            mass="${mass.toFixed(4)}"
            rgba="0.37 0.92 0.83 1" friction="2.0 0.1 0.01"/>
    </body>

    <!-- Mounting plate (matches the cosmetic disc in the three.js rig). -->
    <geom name="plate" type="cylinder" pos="0 ${(L.plateThickness / 2).toFixed(4)} 0"
          size="${L.plateRadius.toFixed(4)} ${(L.plateThickness / 2).toFixed(4)}"
          quat="0.7071 0.7071 0 0" rgba="0.1 0.11 0.13 1"/>

    <!-- M1: base yaw -->
    <body name="base" pos="0 ${L.plateThickness.toFixed(4)} 0">
      <joint name="j_base" type="hinge" axis="0 1 0" range="${rng(BRACCIO_LIMITS_RAD[0])}"/>
      <geom name="g_base" type="cylinder" pos="0 ${(L.base / 2).toFixed(4)} 0"
            size="0.045 ${(L.base / 2).toFixed(4)}" quat="0.7071 0.7071 0 0"
            rgba="0.23 0.27 0.32 1" mass="0.15"/>

      <!-- M2: shoulder pitch -->
      <body name="shoulder" pos="0 ${L.base.toFixed(4)} 0">
        <joint name="j_shoulder" type="hinge" axis="1 0 0" range="${rng(BRACCIO_LIMITS_RAD[1])}"/>
        <geom name="g_upper" type="box" pos="0 ${(L.shoulder / 2).toFixed(4)} 0"
              size="0.03 ${(L.shoulder / 2).toFixed(4)} 0.03"
              rgba="0.37 0.92 0.83 1" mass="0.12"/>

        <!-- M3: elbow pitch -->
        <body name="elbow" pos="0 ${L.shoulder.toFixed(4)} 0">
          <joint name="j_elbow" type="hinge" axis="1 0 0" range="${rng(BRACCIO_LIMITS_RAD[2])}"/>
          <geom name="g_fore" type="box" pos="0 ${(L.elbow / 2).toFixed(4)} 0"
                size="0.025 ${(L.elbow / 2).toFixed(4)} 0.025"
                rgba="0.37 0.92 0.83 1" mass="0.1"/>

          <!-- M4: wrist pitch -->
          <body name="wrist_pitch" pos="0 ${L.elbow.toFixed(4)} 0">
            <joint name="j_wrist_pitch" type="hinge" axis="1 0 0" range="${rng(BRACCIO_LIMITS_RAD[3])}"/>
            <geom name="g_wrist_pitch" type="box" pos="0 ${(L.wristPitch / 2).toFixed(4)} 0"
                  size="0.02 ${(L.wristPitch / 2).toFixed(4)} 0.02"
                  rgba="0.23 0.27 0.32 1" mass="0.05"/>

            <!-- M5: wrist roll -->
            <body name="wrist_roll" pos="0 ${L.wristPitch.toFixed(4)} 0">
              <joint name="j_wrist_roll" type="hinge" axis="0 1 0" range="${rng(BRACCIO_LIMITS_RAD[4])}"/>
              <geom name="g_wrist_roll" type="cylinder" pos="0 ${(L.wristRoll / 2).toFixed(4)} 0"
                    size="0.025 ${(L.wristRoll / 2).toFixed(4)}" quat="0.7071 0.7071 0 0"
                    rgba="0.23 0.27 0.32 1" mass="0.05"/>

              <!-- End-effector body. The IMU site lives here; trajectories
                   aim the trajectory's IK at this point. Gripper carrier
                   is a thin box; fingers are slide-joint children. -->
              <body name="end_effector" pos="0 ${L.wristRoll.toFixed(4)} 0">
                <geom name="g_carrier" type="box" pos="0 0.01 0"
                      size="${((L.gripperWidth + 0.04) / 2).toFixed(4)} 0.01 0.02"
                      rgba="0.1 0.11 0.13 1" mass="0.02"/>
                <site name="imu" pos="0 0 0" size="0.005"/>

                <!-- M6: parallel-jaw fingers. Mirrored slide joints driven
                     by the same actuator target so they spread symmetric-
                     ally. Aperture in store-space [0, 1] is scaled to the
                     finger's slide range [0, HALF_GRIP]. -->
                <body name="finger_l" pos="0 ${(L.fingerLength / 2 + 0.02).toFixed(4)} 0">
                  <joint name="j_grip_l" type="slide" axis="-1 0 0" range="0 ${HALF_GRIP.toFixed(4)}"/>
                  <!-- High friction on the gripper pads so closing the
                       jaws traps the target via Coulomb friction (real
                       parallel-jaw arms grip the same way — soft pads
                       with high coefficient of friction). -->
                  <geom name="g_finger_l" type="box"
                        size="0.009 ${(L.fingerLength / 2).toFixed(4)} 0.012"
                        rgba="0.23 0.27 0.32 1" mass="0.005"
                        friction="2.0 0.1 0.01"/>
                </body>
                <body name="finger_r" pos="0 ${(L.fingerLength / 2 + 0.02).toFixed(4)} 0">
                  <joint name="j_grip_r" type="slide" axis="1 0 0" range="0 ${HALF_GRIP.toFixed(4)}"/>
                  <geom name="g_finger_r" type="box"
                        size="0.009 ${(L.fingerLength / 2).toFixed(4)} 0.012"
                        rgba="0.23 0.27 0.32 1" mass="0.005"
                        friction="2.0 0.1 0.01"/>
                </body>
              </body>
            </body>
          </body>
        </body>
      </body>
    </body>
  </worldbody>

  <actuator>
    <position name="a_base"        joint="j_base"        ctrlrange="${rng(BRACCIO_LIMITS_RAD[0])}"/>
    <position name="a_shoulder"    joint="j_shoulder"    ctrlrange="${rng(BRACCIO_LIMITS_RAD[1])}"/>
    <position name="a_elbow"       joint="j_elbow"       ctrlrange="${rng(BRACCIO_LIMITS_RAD[2])}"/>
    <position name="a_wrist_pitch" joint="j_wrist_pitch" ctrlrange="${rng(BRACCIO_LIMITS_RAD[3])}"/>
    <position name="a_wrist_roll"  joint="j_wrist_roll"  ctrlrange="${rng(BRACCIO_LIMITS_RAD[4])}"/>
    <position name="a_grip_l"      joint="j_grip_l"      ctrlrange="0 ${HALF_GRIP.toFixed(4)}" kp="100"/>
    <position name="a_grip_r"      joint="j_grip_r"      ctrlrange="0 ${HALF_GRIP.toFixed(4)}" kp="100"/>
  </actuator>

  <sensor>
    <accelerometer name="imu_accel" site="imu"/>
    <gyro          name="imu_gyro"  site="imu"/>
    <framequat     name="imu_quat"  objtype="site" objname="imu"/>
    <framepos      name="ee_pos"    objtype="site" objname="imu"/>
  </sensor>
</mujoco>
`.trim();
}

export const BRACCIO_MJCF = braccioMjcf();

/** Maps a normalized gripper aperture (0 = closed, 1 = open) to the
 * slide-joint distance each finger should travel from center. */
export function apertureToFingerSlide(aperture: number): number {
  const a = clamp01(aperture);
  return a * HALF_GRIP;
}

/** Same axis ordering as `armJoints` in the store: 6-vector where the
 * first five entries are servo angles in radians and the last is the
 * normalized aperture in [0, 1]. Used by the sim wrapper to write a
 * trajectory sample into `data.ctrl`. */
export const BRACCIO_ACTUATOR_NAMES = [
  'a_base',
  'a_shoulder',
  'a_elbow',
  'a_wrist_pitch',
  'a_wrist_roll',
] as const;

export const BRACCIO_JOINT_NAMES = [
  'j_base',
  'j_shoulder',
  'j_elbow',
  'j_wrist_pitch',
  'j_wrist_roll',
] as const;

export const BRACCIO_GRIP_ACTUATOR_NAMES = ['a_grip_l', 'a_grip_r'] as const;

/** Names used by `BraccioSim` to interact with the pickup target. The
 * free joint name is needed for qpos addressing; the body name is the
 * accessor for world-frame pose readouts (xpos/xquat). */
export const BRACCIO_TARGET = {
  body: 'target',
  joint: 'j_target',
} as const;

export const BRACCIO_IMU_SENSOR_NAMES = {
  accel: 'imu_accel',
  gyro: 'imu_gyro',
  quat: 'imu_quat',
  pos: 'ee_pos',
} as const;
