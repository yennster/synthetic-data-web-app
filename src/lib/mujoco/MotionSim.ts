/**
 * MuJoCo wrapper for motion mode — the free-body manipulation scene
 * where the user grabs an object with hand tracking, releases it,
 * watches it fall. Mirrors the shape of `BraccioSim` / `RoverSim`:
 * own a model+data, expose typed read/write helpers, dispose at end.
 *
 * Grab/release is implemented via a weld equality constraint between a
 * mocap "hand" body and the free-joint manipulated body. While
 * grabbed, the constraint is active and the hand pose is written each
 * frame; while released, the constraint is disabled and gravity takes
 * over. Throw velocities are written directly into `qvel` at the
 * moment of release so the procedural-motion runner can impart a
 * scripted post-release velocity exactly like the old Rapier code did.
 *
 * Switching object kind requires recompiling the model — the geom and
 * mass change with the shape. `loadShape()` does this atomically:
 * dispose the old model+data, build new ones, reset history.
 */

import type { ObjectKind } from '../../store/useStore';
import {
  motionMjcf,
  MOTION_BODY_NAMES,
  MOTION_FREE_JOINT_NAME,
  MOTION_IMU_SENSOR_NAMES,
} from './motionMjcf';
import type { MujocoModule } from './runtime';
import type { ImuReading } from './BraccioSim';
import type { ImuSource } from './imuSensor';

export class MotionSim implements ImuSource {
  private kind: ObjectKind;
  private mujoco: MujocoModule;
  private model: ReturnType<MujocoModule['MjModel']['from_xml_string']>;
  private data: InstanceType<MujocoModule['MjData']>;
  private objectJointQposAdr: number;
  private objectJointDofAdr: number;
  private sensorAdr: { accel: number; gyro: number; quat: number; pos: number };

  constructor(mujoco: MujocoModule, kind: ObjectKind) {
    this.mujoco = mujoco;
    this.kind = kind;
    const { model, data, qposAdr, dofAdr, sensorAdr } = this._compile(kind);
    this.model = model;
    this.data = data;
    this.objectJointQposAdr = qposAdr;
    this.objectJointDofAdr = dofAdr;
    this.sensorAdr = sensorAdr;
  }

  /** Build a fresh model+data pair for the given shape. Used both at
   * construction and on `loadShape` — the latter disposes the previous
   * pair first. */
  private _compile(kind: ObjectKind) {
    const model = this.mujoco.MjModel.from_xml_string(motionMjcf(kind));
    const data = new this.mujoco.MjData(model);
    const jntQposAdr = model.jnt_qposadr as Int32Array;
    const jntDofAdr = model.jnt_dofadr as Int32Array;
    const qposAdr = jntQposAdr[model.jnt(MOTION_FREE_JOINT_NAME).id];
    const dofAdr = jntDofAdr[model.jnt(MOTION_FREE_JOINT_NAME).id];
    const sensorAdrArr = model.sensor_adr as Int32Array;
    const sensorAdr = {
      accel: sensorAdrArr[model.sensor(MOTION_IMU_SENSOR_NAMES.accel).id],
      gyro: sensorAdrArr[model.sensor(MOTION_IMU_SENSOR_NAMES.gyro).id],
      quat: sensorAdrArr[model.sensor(MOTION_IMU_SENSOR_NAMES.quat).id],
      pos: sensorAdrArr[model.sensor(MOTION_IMU_SENSOR_NAMES.pos).id],
    };
    return { model, data, qposAdr, dofAdr, sensorAdr };
  }

  get currentKind(): ObjectKind {
    return this.kind;
  }

  /** Recompile the model for a new shape. The previous WASM-side
   * model+data are disposed; callers should make sure no in-flight
   * reads (e.g. a useFrame that ran a millisecond ago) hold raw
   * Float64Array views — those become dangling pointers after the
   * underlying MjData is freed. The recommendation is to drive
   * loadShape() from a useEffect on `objectKind` so React's commit
   * ordering keeps the per-frame loop off the dead instance. */
  loadShape(kind: ObjectKind): void {
    if (kind === this.kind) return;
    this.data.delete();
    this.model.delete();
    const { model, data, qposAdr, dofAdr, sensorAdr } = this._compile(kind);
    this.model = model;
    this.data = data;
    this.objectJointQposAdr = qposAdr;
    this.objectJointDofAdr = dofAdr;
    this.sensorAdr = sensorAdr;
    this.kind = kind;
  }

  /** True while the grab weld is engaged. The runtime keeps this flag
   * in MuJoCo's own eq_active table — no separate state to drift. */
  get isGrabbed(): boolean {
    const ea = this.data.eq_active as Uint8Array;
    return ea[0] === 1;
  }

  /** Engage the weld constraint and pin the mocap hand to a target
   * world-space pose. Quaternion is (w, x, y, z) — same ordering as
   * MuJoCo's mocap_quat and the rest of this codebase's MJCF reads.
   * Caller should keep writing the hand pose every frame while
   * grabbed; the weld is what pulls the object along. */
  grab(pos: [number, number, number], quat: [number, number, number, number]): void {
    const ea = this.data.eq_active as Uint8Array;
    ea[0] = 1;
    this.setHandPose(pos, quat);
  }

  /** Update the hand's pose without changing grab state. While
   * grabbed, this is how the procedural runner / hand-tracker drives
   * the object motion. */
  setHandPose(
    pos: [number, number, number],
    quat: [number, number, number, number],
  ): void {
    const mocapPos = this.data.mocap_pos as Float64Array;
    const mocapQuat = this.data.mocap_quat as Float64Array;
    mocapPos[0] = pos[0];
    mocapPos[1] = pos[1];
    mocapPos[2] = pos[2];
    mocapQuat[0] = quat[0];
    mocapQuat[1] = quat[1];
    mocapQuat[2] = quat[2];
    mocapQuat[3] = quat[3];
  }

  /** Disengage the weld constraint, optionally setting a one-shot
   * release velocity. The throw-velocity values are written into the
   * free-joint's qvel slots so the integrator carries the body along
   * naturally from the next step onward. */
  release(opts?: {
    linvel?: [number, number, number];
    angvel?: [number, number, number];
  }): void {
    const ea = this.data.eq_active as Uint8Array;
    ea[0] = 0;
    if (opts?.linvel || opts?.angvel) {
      const qvel = this.data.qvel as Float64Array;
      const adr = this.objectJointDofAdr;
      if (opts.linvel) {
        qvel[adr + 0] = opts.linvel[0];
        qvel[adr + 1] = opts.linvel[1];
        qvel[adr + 2] = opts.linvel[2];
      }
      if (opts.angvel) {
        qvel[adr + 3] = opts.angvel[0];
        qvel[adr + 4] = opts.angvel[1];
        qvel[adr + 5] = opts.angvel[2];
      }
    }
  }

  /** Reset the body to a fixed pose (the default spawn) and clear all
   * velocities. Used when the user changes the object kind — the new
   * geom should appear at a predictable spot, not at wherever the
   * previous shape last landed. */
  resetToSpawn(): void {
    this.mujoco.mj_resetData(this.model, this.data);
    // The MJCF defines the body at (0, 2, 0); mj_resetData restores it.
    // We additionally clear the weld so a fresh shape isn't stuck mid-
    // grab from the previous one's state.
    const ea = this.data.eq_active as Uint8Array;
    ea[0] = 0;
    this.mujoco.mj_forward(this.model, this.data);
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

  /** World-space pose + orientation of the manipulated body. Used by
   * the three.js rig to render the mesh at MuJoCo's settled position.
   * Quaternion comes out as (w, x, y, z) — same ordering as the rest
   * of the MuJoCo API. */
  readPose(): {
    pos: [number, number, number];
    quat: [number, number, number, number];
  } {
    const xpos = this.data.xpos as Float64Array;
    const xquat = this.data.xquat as Float64Array;
    const bodyId = this.model.body(MOTION_BODY_NAMES.object).id;
    const i = bodyId * 3;
    const j = bodyId * 4;
    return {
      pos: [xpos[i], xpos[i + 1], xpos[i + 2]],
      quat: [xquat[j], xquat[j + 1], xquat[j + 2], xquat[j + 3]],
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

  /** Use rarely — most callers should reach for the typed helpers
   * above. Exposed because the qpos address is the only way to write
   * the initial spawn pose without `mj_resetData` resetting other
   * state too. */
  setQpos(pos: [number, number, number], quat: [number, number, number, number]): void {
    const qpos = this.data.qpos as Float64Array;
    const adr = this.objectJointQposAdr;
    qpos[adr + 0] = pos[0];
    qpos[adr + 1] = pos[1];
    qpos[adr + 2] = pos[2];
    qpos[adr + 3] = quat[0];
    qpos[adr + 4] = quat[1];
    qpos[adr + 5] = quat[2];
    qpos[adr + 6] = quat[3];
    (this.data.qvel as Float64Array).fill(0);
    this.mujoco.mj_forward(this.model, this.data);
  }

  dispose(): void {
    this.data.delete();
    this.model.delete();
  }
}
