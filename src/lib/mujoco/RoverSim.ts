/**
 * MuJoCo wrapper for the differential-drive rover. Mirrors the shape of
 * `BraccioSim`: own a model+data pair, expose typed step + read +
 * write helpers, manage WASM-side memory.
 *
 * The chassis is a single planar-jointed body (x, z, yaw). Trajectories
 * push (x, z, heading) targets into position actuators; the IMU site
 * at the chassis center exposes accel + gyro + orientation sensors.
 * Contact spikes — for the rover's "bumper hit" signature — are
 * applied as world-frame impulses through `qfrc_applied`. The
 * integrator turns those into a physically-realistic transient on the
 * accelerometer instead of the previous hand-tuned velocity hack.
 */

import {
  ROVER_ACTUATOR_NAMES,
  ROVER_JOINT_NAMES,
  ROVER_IMU_SENSOR_NAMES,
  ROVER_CHASSIS_BODY,
  roverMjcf,
  type RoverObstacle,
} from './roverMjcf';
import type { MujocoModule } from './runtime';
import type { ImuReading } from './BraccioSim';

export type RoverPose = { x: number; z: number; heading: number };

export class RoverSim {
  private actuatorIds!: number[];
  private chassisBodyId!: number;
  private chassisGeomId!: number;
  private jointQposAdr!: number[];
  private sensorAdr!: { accel: number; gyro: number; quat: number; pos: number };
  private model!: ReturnType<MujocoModule['MjModel']['from_xml_string']>;
  private data!: InstanceType<MujocoModule['MjData']>;
  private mujoco: MujocoModule;
  private currentObstacles: ReadonlyArray<RoverObstacle> = [];

  constructor(mujoco: MujocoModule) {
    this.mujoco = mujoco;
    this._compileFor([]);
  }

  /** Build a fresh model+data pair for the given obstacle set. Used at
   * construction and whenever the obstacle list changes. The previous
   * pair is disposed first so the WASM heap doesn't accumulate dead
   * MuJoCo objects per iteration. */
  private _compileFor(obstacles: ReadonlyArray<RoverObstacle>): void {
    if (this.data) this.data.delete();
    if (this.model) this.model.delete();
    this.model = this.mujoco.MjModel.from_xml_string(roverMjcf(obstacles));
    this.data = new this.mujoco.MjData(this.model);
    this.currentObstacles = obstacles;

    this.actuatorIds = ROVER_ACTUATOR_NAMES.map(
      (n) => this.model.actuator(n).id,
    );
    this.chassisBodyId = this.model.body(ROVER_CHASSIS_BODY).id;
    this.chassisGeomId = this.model.geom('g_chassis').id;

    const jntQposAdr = this.model.jnt_qposadr as Int32Array;
    this.jointQposAdr = ROVER_JOINT_NAMES.map(
      (n) => jntQposAdr[this.model.jnt(n).id],
    );

    const sensorAdr = this.model.sensor_adr as Int32Array;
    this.sensorAdr = {
      accel: sensorAdr[this.model.sensor(ROVER_IMU_SENSOR_NAMES.accel).id],
      gyro: sensorAdr[this.model.sensor(ROVER_IMU_SENSOR_NAMES.gyro).id],
      quat: sensorAdr[this.model.sensor(ROVER_IMU_SENSOR_NAMES.quat).id],
      pos: sensorAdr[this.model.sensor(ROVER_IMU_SENSOR_NAMES.pos).id],
    };
  }

  /** Rebuild the sim with a new obstacle set. Skips the rebuild if the
   * obstacle list is structurally unchanged — cheap pointer / scalar
   * comparison so the controller can call this on every iteration
   * without worrying about wasted compiles. */
  rebuildWithObstacles(obstacles: ReadonlyArray<RoverObstacle>): void {
    if (this._obstaclesEqual(obstacles, this.currentObstacles)) return;
    this._compileFor(obstacles);
  }

  private _obstaclesEqual(
    a: ReadonlyArray<RoverObstacle>,
    b: ReadonlyArray<RoverObstacle>,
  ): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      if (
        x.id !== y.id ||
        x.x !== y.x ||
        x.z !== y.z ||
        x.r !== y.r ||
        x.height !== y.height
      ) {
        return false;
      }
    }
    return true;
  }

  reset(): void {
    this.mujoco.mj_resetData(this.model, this.data);
  }

  /** Snap the rover to a specific (x, z, heading) pose with zero
   * velocity. Used at iteration start so the controller doesn't have
   * to wait for the PD loop to catch up from wherever the previous
   * iteration ended. */
  snapToPose(pose: RoverPose): void {
    const qpos = this.data.qpos as Float64Array;
    qpos[this.jointQposAdr[0]] = pose.x;
    qpos[this.jointQposAdr[1]] = pose.z;
    qpos[this.jointQposAdr[2]] = pose.heading;
    (this.data.qvel as Float64Array).fill(0);
    (this.data.qfrc_applied as Float64Array).fill(0);
    this.setTargets(pose);
    this.mujoco.mj_forward(this.model, this.data);
  }

  setTargets(pose: RoverPose): void {
    const ctrl = this.data.ctrl as Float64Array;
    ctrl[this.actuatorIds[0]] = pose.x;
    ctrl[this.actuatorIds[1]] = pose.z;
    ctrl[this.actuatorIds[2]] = pose.heading;
  }

  /** True iff the chassis geom is in contact with anything this step.
   * Reads `data.ncon` (number of detected contacts) and scans the
   * contact list for entries involving the chassis geom. Used by the
   * sampler to drive the in-contact indicator on the rig — the actual
   * IMU spike comes from MuJoCo's contact solver running normally
   * inside `mj_step`. */
  chassisInContact(): boolean {
    const ncon = this.data.ncon as number;
    if (ncon === 0) return false;
    // `data.contact` is a copy-on-access vector — getting it once per
    // call is fine, but we delete it after use to avoid heap leaks.
    const contacts = this.data.contact;
    let inContact = false;
    for (let i = 0; i < contacts.size(); i++) {
      const c = contacts.get(i);
      if (!c) continue;
      if (c.geom1 === this.chassisGeomId || c.geom2 === this.chassisGeomId) {
        inContact = true;
      }
      c.delete();
    }
    contacts.delete();
    return inContact;
  }

  step(dtSec: number): void {
    if (!Number.isFinite(dtSec) || dtSec <= 0) return;
    const ts = this.model.opt.timestep as number;
    const stepsRequested = Math.ceil(dtSec / ts);
    const stepsToRun = Math.min(stepsRequested, 25);
    for (let i = 0; i < stepsToRun; i++) {
      this.mujoco.mj_step(this.model, this.data);
    }
  }

  readPose(): RoverPose {
    const qpos = this.data.qpos as Float64Array;
    return {
      x: qpos[this.jointQposAdr[0]],
      z: qpos[this.jointQposAdr[1]],
      heading: qpos[this.jointQposAdr[2]],
    };
  }

  readImu(): ImuReading {
    const s = this.data.sensordata as Float64Array;
    const a = this.sensorAdr.accel;
    const g = this.sensorAdr.gyro;
    const q = this.sensorAdr.quat;
    const p = this.sensorAdr.pos;
    return {
      accel: [s[a], s[a + 1], s[a + 2]],
      gyro: [s[g], s[g + 1], s[g + 2]],
      quat: [s[q], s[q + 1], s[q + 2], s[q + 3]],
      pos: [s[p], s[p + 1], s[p + 2]],
    };
  }

  /** World-frame position of the chassis body — used by the lidar
   * raycaster, which still operates against the three.js obstacle
   * group. Pulled from `xpos` so it stays accurate even with offsets
   * the joint qpos can't represent. */
  readChassisWorldPos(): [number, number, number] {
    const xpos = this.data.xpos as Float64Array;
    const i = this.chassisBodyId * 3;
    return [xpos[i], xpos[i + 1], xpos[i + 2]];
  }

  dispose(): void {
    this.data.delete();
    this.model.delete();
  }
}
