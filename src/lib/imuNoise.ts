/**
 * Synthetic IMU noise model — applied to every clean IMU reading the
 * app produces (motion, rover chassis, arm end-effector).
 *
 * Modeled after MATLAB's `imuSensor` System object
 * (https://www.mathworks.com/help/fusion/ref/imusensor-system-object.html)
 * which is the standard reference for synthetic IMU data: a clean
 * inertial reading goes in, a realistic sensor reading comes out, with
 * configurable noise density, bias instability, axis-misalignment,
 * dynamic range, and quantization.
 *
 * Model components — applied in this order each tick:
 *
 *   1. **bias drift**  — slow random walk added to each axis. Real
 *      IMUs exhibit Allan-variance "bias instability" where the zero
 *      offset drifts on the order of mg/s² for accel and mdps for
 *      gyro. We model it as `bias[k+1] = bias[k] + N(0, σ_bw·√dt)`,
 *      capped to a few percent of measurement range so it can't run
 *      away.
 *
 *   2. **white noise** — gaussian noise with standard deviation
 *      `noiseDensity · √(sampleRate)`. Sample rate enters because
 *      noise density is specified per √Hz; the per-sample sigma is
 *      `density · √Hz` per Allan-variance convention.
 *
 *   3. **scale + clipping** — multiply by a per-axis scale factor (1 +
 *      ε for misalignment / scale-factor error) and clamp to the
 *      configured measurement range. Clipping matches what a real
 *      LSM6DS3 / ICM-20948 does on saturating readings.
 *
 *   4. **quantization** — round to the configured LSB (Resolution in
 *      MathWorks parlance). Default is 16-bit-effective: full range
 *      mapped to 65 536 codes.
 *
 * The defaults below are calibrated to match the LSM6DSO (Arduino
 * Nano 33 BLE Sense / Nano RP2040 Connect) at ±4 g / ±2000 dps —
 * representative of the hardware Edge Impulse users typically deploy
 * to. Override via the store's `imuNoise` config.
 *
 * The helper is a pure function over a `NoiseState` (carries the
 * running bias) so the per-sampler code can keep one piece of state
 * and not worry about the noise math beyond calling `applyImuNoise`.
 */

import { clamp } from './math';

/** 3-vector used for accel / gyro readings. Local to this module so
 * the noise helper doesn't depend on the (now-deleted) kinematic IMU
 * math file. */
type Vec3 = readonly [number, number, number];

export type ImuNoiseConfig = {
  /** Master switch — when false, samples pass through untouched. */
  enabled: boolean;
  /** Accelerometer dynamic range in m/s² (one-sided). Real LSM6DSO
   * options are 2g, 4g, 8g, 16g; default 4g (39.24 m/s²). */
  accelRange: number;
  /** Gyro dynamic range in rad/s (one-sided). Real LSM6DSO options
   * are 125, 250, 500, 1000, 2000 dps; default 2000 dps. */
  gyroRange: number;
  /** Accel noise density (m/s² / √Hz). LSM6DSO is ~0.06 mg/√Hz =
   * ~5.9e-4 m/s²/√Hz. */
  accelNoiseDensity: number;
  /** Gyro noise density (rad/s / √Hz). LSM6DSO is ~7 mdps/√Hz =
   * ~1.2e-4 rad/s/√Hz. */
  gyroNoiseDensity: number;
  /** Standard deviation of the per-tick bias random walk (m/s² for
   * accel, rad/s for gyro). Set to 0 to freeze bias. */
  accelBiasInstability: number;
  gyroBiasInstability: number;
  /** Per-axis scale-factor error fraction. 0.01 means up to 1 % of
   * gain on each axis. Set once at construction; doesn't drift. */
  scaleFactorError: number;
  /** ADC effective bits — `2^bits` codes mapped across the full
   * symmetric range. 16 matches LSM6DSO's 16-bit output register. */
  adcBits: number;
};

export const DEFAULT_IMU_NOISE: ImuNoiseConfig = {
  enabled: true,
  accelRange: 39.24, // ±4 g in m/s²
  gyroRange: 34.9, // ±2000 dps in rad/s
  accelNoiseDensity: 5.9e-4,
  gyroNoiseDensity: 1.2e-4,
  accelBiasInstability: 1e-4,
  gyroBiasInstability: 5e-6,
  scaleFactorError: 0.005,
  adcBits: 16,
};

/** Per-IMU running state: the bias drift accumulators and a fixed
 * per-axis scale factor sampled once at construction. The sampler
 * threads this through `applyImuNoise` so multiple IMUs (rover +
 * arm + hand body) don't share bias trajectories.
 */
export type ImuNoiseState = {
  accelBias: [number, number, number];
  gyroBias: [number, number, number];
  /** 1 + ε per axis. Constant for the lifetime of the sensor. */
  accelScale: [number, number, number];
  gyroScale: [number, number, number];
};

/** Box–Muller gaussian sample with mean 0 and unit standard deviation. */
function gauss(rng: () => number = Math.random): number {
  // Avoid Math.log(0) by clamping u1 away from 0.
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function makeImuNoiseState(
  cfg: ImuNoiseConfig,
  rng: () => number = Math.random,
): ImuNoiseState {
  const sFactor = (): [number, number, number] => [
    1 + (rng() - 0.5) * 2 * cfg.scaleFactorError,
    1 + (rng() - 0.5) * 2 * cfg.scaleFactorError,
    1 + (rng() - 0.5) * 2 * cfg.scaleFactorError,
  ];
  return {
    accelBias: [0, 0, 0],
    gyroBias: [0, 0, 0],
    accelScale: sFactor(),
    gyroScale: sFactor(),
  };
}

/**
 * Apply the noise model to one (accel, gyro) reading. Returns the
 * noisy reading; the per-axis biases inside `state` are mutated in
 * place to advance the random walk for the next call.
 *
 * `dt` is the elapsed time since the previous sample in seconds.
 * Used both for converting noise density to per-sample sigma and for
 * scaling the bias random walk.
 */
export function applyImuNoise(
  accel: Vec3,
  gyro: Vec3,
  state: ImuNoiseState,
  cfg: ImuNoiseConfig,
  dt: number,
  rng: () => number = Math.random,
): { accel: Vec3; gyro: Vec3 } {
  if (!cfg.enabled) {
    return { accel, gyro };
  }

  const sqrtDt = Math.sqrt(Math.max(1e-6, dt));
  // Per-sample noise sigma. NoiseDensity is per √Hz; per √dt is the
  // Allan-variance equivalent, so `density / √dt` is the per-sample
  // sigma. (Equivalently: `density · √(1/dt)` = `density · √Hz`.)
  const accSigma = cfg.accelNoiseDensity / sqrtDt;
  const gyrSigma = cfg.gyroNoiseDensity / sqrtDt;
  const accBiasStep = cfg.accelBiasInstability * sqrtDt;
  const gyrBiasStep = cfg.gyroBiasInstability * sqrtDt;

  // Quantization step — full symmetric range mapped over 2^bits codes.
  const accLsb = (2 * cfg.accelRange) / Math.pow(2, cfg.adcBits);
  const gyrLsb = (2 * cfg.gyroRange) / Math.pow(2, cfg.adcBits);

  const out: { accel: [number, number, number]; gyro: [number, number, number] } = {
    accel: [0, 0, 0],
    gyro: [0, 0, 0],
  };

  for (let i = 0; i < 3; i++) {
    // 1. Advance bias random walk (capped to ±5% of range so it
    //    can't run away for a long-running session).
    state.accelBias[i] += gauss(rng) * accBiasStep;
    state.gyroBias[i] += gauss(rng) * gyrBiasStep;
    const accCap = cfg.accelRange * 0.05;
    const gyrCap = cfg.gyroRange * 0.05;
    state.accelBias[i] = clamp(state.accelBias[i], -accCap, accCap);
    state.gyroBias[i] = clamp(state.gyroBias[i], -gyrCap, gyrCap);

    // 2. Apply scale + add bias + add white noise.
    let a = accel[i] * state.accelScale[i] + state.accelBias[i];
    let g = gyro[i] * state.gyroScale[i] + state.gyroBias[i];
    a += gauss(rng) * accSigma;
    g += gauss(rng) * gyrSigma;

    // 3. Clip to dynamic range (saturation).
    a = clamp(a, -cfg.accelRange, cfg.accelRange);
    g = clamp(g, -cfg.gyroRange, cfg.gyroRange);

    // 4. Quantize.
    a = Math.round(a / accLsb) * accLsb;
    g = Math.round(g / gyrLsb) * gyrLsb;

    out.accel[i] = a;
    out.gyro[i] = g;
  }

  return out;
}

