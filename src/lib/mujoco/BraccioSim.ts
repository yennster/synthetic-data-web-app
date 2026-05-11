/**
 * Thin wrapper around a single MuJoCo `MjModel`+`MjData` pair for the
 * Braccio arm. The class owns:
 *
 *   - the compiled model (parsed from `BRACCIO_MJCF`),
 *   - the per-instance state (`MjData`),
 *   - cached actuator/sensor/joint ids so the per-frame hot path doesn't
 *     touch named-accessor lookups,
 *   - and a `dispose()` that releases the WASM-side memory.
 *
 * Trajectories produce 6-vectors in store space (`armJoints`):
 *
 *   joints[0..4]  servo angles in radians (M1..M5)
 *   joints[5]     gripper aperture in [0, 1]
 *
 * `setJointTargets` translates that vector into actuator targets in
 * `data.ctrl`, including the aperture-to-finger-slide mapping. The
 * caller decides how often to advance physics via `step(dtSec)`.
 *
 * IMU read-out uses MuJoCo's built-in accelerometer/gyro sensors at the
 * end-effector site, so the recorded signal includes real joint inertia,
 * gravity loading, and contact response — the whole point of swapping
 * the kinematic chain for a physics-backed sim. The previous
 * pose-delta math is gone; `applyImuNoise` still wraps the reading to
 * keep the recorded trace's noise profile consistent with motion mode.
 */

import {
  BRACCIO_ACTUATOR_NAMES,
  BRACCIO_GRIP_ACTUATOR_NAMES,
  BRACCIO_IMU_SENSOR_NAMES,
  BRACCIO_JOINT_NAMES,
  BRACCIO_MJCF,
  apertureToFingerSlide,
} from './braccioMjcf';
import type { MujocoModule } from './runtime';

export type BraccioJointPose = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
];

export type ImuReading = {
  /** Body-frame linear acceleration (m/s²), gravity-included — same
   * convention as a real MEMS accelerometer at rest reporting ~9.81
   * along the up axis. */
  accel: [number, number, number];
  /** Body-frame angular velocity (rad/s) from the gyroscope sensor. */
  gyro: [number, number, number];
  /** World-frame orientation of the IMU site, (w, x, y, z). */
  quat: [number, number, number, number];
  /** World-frame position of the IMU site (m). Used by the trajectory
   * runner / debug overlays — not part of the EI payload. */
  pos: [number, number, number];
};

export class BraccioSim {
  private actuatorIds: number[];
  private gripActuatorIds: number[];
  private jointQposAdr: number[];
  private sensorAdr: { accel: number; gyro: number; quat: number; pos: number };
  private model: ReturnType<MujocoModule['MjModel']['from_xml_string']>;
  private data: InstanceType<MujocoModule['MjData']>;
  private mujoco: MujocoModule;

  constructor(mujoco: MujocoModule) {
    this.mujoco = mujoco;
    this.model = mujoco.MjModel.from_xml_string(BRACCIO_MJCF);
    this.data = new mujoco.MjData(this.model);

    // Resolve named handles once. `data.actuator('name').ctrl` writes
    // into the live `data.ctrl` array, but going through the accessor
    // hits a string lookup each frame — we'd rather index a cached
    // Float64Array view, so resolve the ids now and address `ctrl` /
    // `qpos` / `sensordata` by integer offset in the hot path.
    this.actuatorIds = BRACCIO_ACTUATOR_NAMES.map(
      (n) => this.model.actuator(n).id,
    );
    this.gripActuatorIds = BRACCIO_GRIP_ACTUATOR_NAMES.map(
      (n) => this.model.actuator(n).id,
    );

    // `qpos` is indexed by joint qpos-address (every joint has nq slots;
    // hinge joints take 1, slide joints take 1, free joints take 7).
    // For hinge-only joints in the chain this collapses to a simple
    // increment, but pulling from `model.jnt_qposadr` keeps us correct
    // even if a free-joint object is added to the model later.
    const jntQposAdr = this.model.jnt_qposadr as Int32Array;
    this.jointQposAdr = BRACCIO_JOINT_NAMES.map(
      (n) => jntQposAdr[this.model.jnt(n).id],
    );

    const sensorAdr = this.model.sensor_adr as Int32Array;
    this.sensorAdr = {
      accel: sensorAdr[this.model.sensor(BRACCIO_IMU_SENSOR_NAMES.accel).id],
      gyro: sensorAdr[this.model.sensor(BRACCIO_IMU_SENSOR_NAMES.gyro).id],
      quat: sensorAdr[this.model.sensor(BRACCIO_IMU_SENSOR_NAMES.quat).id],
      pos: sensorAdr[this.model.sensor(BRACCIO_IMU_SENSOR_NAMES.pos).id],
    };
  }

  /** Reset the integrator to qpos0 / qvel0 — same as starting fresh.
   * Useful when the user retargets the arm or cancels a run, so the
   * sim doesn't carry leftover momentum into the next trajectory. */
  reset(): void {
    this.mujoco.mj_resetData(this.model, this.data);
  }

  /** Set the home pose as the current position. Useful when the user
   * adjusts the home sliders — without this, the arm would drift back
   * from wherever it was last commanded under the PD controller. We
   * write directly into qpos AND ctrl so the integrator sees no error
   * and stays put on the next step. */
  snapToPose(pose: BraccioJointPose): void {
    const qpos = this.data.qpos as Float64Array;
    for (let i = 0; i < 5; i++) {
      qpos[this.jointQposAdr[i]] = pose[i];
    }
    // Finger slide joints take their own qpos slots (same order as the
    // rest of the chain, since BRACCIO_JOINT_NAMES tracks only the
    // first five servo joints). The fingers live one slot past the
    // wrist roll — read them from the model's joint table directly.
    const jntQposAdr = this.model.jnt_qposadr as Int32Array;
    const fingerSlide = apertureToFingerSlide(pose[5]);
    qpos[jntQposAdr[this.model.jnt('j_grip_l').id]] = fingerSlide;
    qpos[jntQposAdr[this.model.jnt('j_grip_r').id]] = fingerSlide;

    // Clear velocity so a snap doesn't manifest as a velocity spike in
    // the next IMU sample.
    const qvel = this.data.qvel as Float64Array;
    qvel.fill(0);

    this.setJointTargets(pose);
    // Run a forward pass so derived quantities (`xpos`, sensor data) are
    // consistent with the new pose before the caller reads them.
    this.mujoco.mj_forward(this.model, this.data);
  }

  /** Push a joint-space target into the position actuators. The PD
   * controller in the actuator definition drives each joint there;
   * the resulting motion is what the IMU sensor sees. */
  setJointTargets(pose: BraccioJointPose): void {
    const ctrl = this.data.ctrl as Float64Array;
    for (let i = 0; i < 5; i++) {
      ctrl[this.actuatorIds[i]] = pose[i];
    }
    const fingerSlide = apertureToFingerSlide(pose[5]);
    ctrl[this.gripActuatorIds[0]] = fingerSlide;
    ctrl[this.gripActuatorIds[1]] = fingerSlide;
  }

  /** Advance the simulation by approximately `dtSec` of wall-clock
   * time. We step at the model's fixed timestep until simulated time
   * catches up — same "catch-up" pattern the official MuJoCo demo
   * uses. A safety cap on max steps per call keeps a stalled frame
   * (or a tab returning from background) from triggering a multi-
   * second physics burst that blocks the main thread. */
  step(dtSec: number): void {
    if (!Number.isFinite(dtSec) || dtSec <= 0) return;
    const ts = this.model.opt.timestep as number;
    // Cap at ~50 ms of wall-clock catch-up (25 steps at 2 ms). Beyond
    // that we just drop the surplus — physics isn't worth blocking the
    // UI for.
    const stepsRequested = Math.ceil(dtSec / ts);
    const stepsToRun = Math.min(stepsRequested, 25);
    for (let i = 0; i < stepsToRun; i++) {
      this.mujoco.mj_step(this.model, this.data);
    }
  }

  /** Read the current joint positions in store-space order. The
   * gripper component is reconstructed from the finger-slide joint
   * back into normalized aperture [0, 1] so the visual rig can drive
   * its finger meshes without knowing the slide range. */
  readJointPositions(): [number, number, number, number, number, number] {
    const qpos = this.data.qpos as Float64Array;
    const jntQposAdr = this.model.jnt_qposadr as Int32Array;
    const fingerSlide = qpos[jntQposAdr[this.model.jnt('j_grip_l').id]];
    // Inverse of `apertureToFingerSlide`. HALF_GRIP = gripperWidth/2,
    // but we read from the actual joint range so the conversion stays
    // correct if the MJCF ever changes.
    const jntRange = this.model.jnt_range as Float64Array;
    const gripJointId = this.model.jnt('j_grip_l').id;
    const halfGrip = jntRange[gripJointId * 2 + 1];
    const aperture = halfGrip > 0 ? fingerSlide / halfGrip : 0;
    return [
      qpos[this.jointQposAdr[0]],
      qpos[this.jointQposAdr[1]],
      qpos[this.jointQposAdr[2]],
      qpos[this.jointQposAdr[3]],
      qpos[this.jointQposAdr[4]],
      Math.max(0, Math.min(1, aperture)),
    ];
  }

  /** Read the end-effector IMU. All four sensors live in the flat
   * `sensordata` array at addresses cached in the constructor. */
  readImu(): ImuReading {
    const s = this.data.sensordata as Float64Array;
    const a = this.sensorAdr.accel;
    const g = this.sensorAdr.gyro;
    const q = this.sensorAdr.quat;
    const p = this.sensorAdr.pos;
    return {
      accel: [s[a], s[a + 1], s[a + 2]],
      gyro: [s[g], s[g + 1], s[g + 2]],
      // MuJoCo's framequat returns (w, x, y, z). We keep that ordering
      // here; callers needing three.js (x, y, z, w) re-pack at the
      // boundary.
      quat: [s[q], s[q + 1], s[q + 2], s[q + 3]],
      pos: [s[p], s[p + 1], s[p + 2]],
    };
  }

  /** Release the underlying WASM-side memory. Embind objects are not
   * garbage-collected by the JS runtime, so omitting this leaks the
   * model + data on every component unmount. Must not be called more
   * than once per instance. */
  dispose(): void {
    this.data.delete();
    this.model.delete();
  }
}
