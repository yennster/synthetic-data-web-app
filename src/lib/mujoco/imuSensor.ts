/**
 * Shared IMU sampling pipeline used by every mode (motion, arm, rover).
 *
 * Before MuJoCo, each mode had its own copy of the kinematics →
 * accelerometer/gyro conversion plus the per-mode noise wiring. Now
 * the conversion is owned by MuJoCo's built-in `accelerometer` + `gyro`
 * sensors at an IMU site on whatever body is being instrumented, and
 * this module is the single place that turns the raw sensor read into
 * a noisy `AccelSample` ready for the recording store.
 *
 * Anything that exposes a `readImu()` returning the same `ImuReading`
 * shape can plug in — `BraccioSim`, `RoverSim`, `MotionSim` all do.
 * That's the unified IMU codepath: one noise model, one sample
 * convention, one place to evolve when EI's recording schema changes.
 */

import type { AccelSample } from '../../store/useStore';
import {
  applyImuNoise,
  makeImuNoiseState,
  type ImuNoiseConfig,
  type ImuNoiseState,
} from '../imuNoise';
import type { ImuReading } from './BraccioSim';

/** Minimal interface a sim must implement to be IMU-sampled. */
export interface ImuSource {
  readImu(): ImuReading;
}

/** Reusable per-mode noise state. The bias-drift accumulators inside
 * advance in place on every call to `sampleImu`, so successive samples
 * within a recording share the same Allan-variance random walk. Reset
 * (set to `null`) when the underlying body remounts so a fresh
 * recording gets its own drift trajectory. */
export type NoiseStateRef = { current: ImuNoiseState | null };

/** Single entry point used by every mode's per-frame sampler. Returns
 * the `AccelSample` for the store, or `null` if the noise state can't
 * be initialized (defensive — shouldn't happen with a valid config).
 *
 * Callers are responsible for:
 *   - their own sample-rate accumulator (this fn doesn't gate on dt),
 *   - pushing the returned sample into the store while a recording is
 *     active.
 */
export function sampleImu(
  source: ImuSource,
  noiseStateRef: NoiseStateRef,
  noiseCfg: ImuNoiseConfig,
  sampleDt: number,
): AccelSample {
  const reading = source.readImu();
  if (!noiseStateRef.current) {
    noiseStateRef.current = makeImuNoiseState(noiseCfg);
  }
  const noisy = applyImuNoise(
    reading.accel,
    reading.gyro,
    noiseStateRef.current,
    noiseCfg,
    sampleDt,
  );
  return {
    t: performance.now(),
    ax: noisy.accel[0],
    ay: noisy.accel[1],
    az: noisy.accel[2],
    gx: noisy.gyro[0],
    gy: noisy.gyro[1],
    gz: noisy.gyro[2],
  };
}
