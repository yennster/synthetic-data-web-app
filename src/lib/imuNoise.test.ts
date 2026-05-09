import { describe, expect, it } from 'vitest';
import {
  applyImuNoise,
  DEFAULT_IMU_NOISE,
  makeImuNoiseState,
} from './imuNoise';

function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('applyImuNoise', () => {
  it('passes through unchanged when disabled', () => {
    const state = makeImuNoiseState({ ...DEFAULT_IMU_NOISE, enabled: false });
    const cfg = { ...DEFAULT_IMU_NOISE, enabled: false };
    const out = applyImuNoise(
      [1, 2, 3],
      [0.1, 0.2, 0.3],
      state,
      cfg,
      0.05,
      seededRng(1),
    );
    expect(out.accel).toEqual([1, 2, 3]);
    expect(out.gyro).toEqual([0.1, 0.2, 0.3]);
  });

  it('produces values within the configured dynamic range', () => {
    const cfg = { ...DEFAULT_IMU_NOISE };
    const state = makeImuNoiseState(cfg, seededRng(2));
    // Drive in values inside the range and check output saturates correctly.
    for (let i = 0; i < 100; i++) {
      const out = applyImuNoise(
        [cfg.accelRange * 2, 0, 0], // intentionally beyond range
        [cfg.gyroRange * 2, 0, 0],
        state,
        cfg,
        0.05,
        seededRng(3 + i),
      );
      expect(Math.abs(out.accel[0])).toBeLessThanOrEqual(cfg.accelRange);
      expect(Math.abs(out.gyro[0])).toBeLessThanOrEqual(cfg.gyroRange);
    }
  });

  it('quantizes to the configured ADC step', () => {
    const cfg = { ...DEFAULT_IMU_NOISE, adcBits: 8, scaleFactorError: 0, accelBiasInstability: 0, gyroBiasInstability: 0, accelNoiseDensity: 0, gyroNoiseDensity: 0 };
    const state = makeImuNoiseState(cfg, seededRng(4));
    const lsbA = (2 * cfg.accelRange) / Math.pow(2, cfg.adcBits);
    const out = applyImuNoise([1.234, 5.678, -2.5], [0.1, -0.2, 0.3], state, cfg, 0.05, seededRng(5));
    // Each output should be a multiple of LSB.
    for (const v of out.accel) {
      const rem = Math.abs(v / lsbA - Math.round(v / lsbA));
      expect(rem).toBeLessThan(1e-6);
    }
  });

  it('exposes a non-zero bias drift over many samples', () => {
    const cfg = {
      ...DEFAULT_IMU_NOISE,
      // Tighten the noise density to near-zero so the bias drift
      // dominates and isn't lost in white noise.
      accelNoiseDensity: 0,
      gyroNoiseDensity: 0,
      // High instability so we get visible drift quickly in the test.
      accelBiasInstability: 0.05,
      gyroBiasInstability: 0.005,
      scaleFactorError: 0,
      adcBits: 32, // disable quantization noise for this test
    };
    const state = makeImuNoiseState(cfg, seededRng(11));
    let last: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 200; i++) {
      const out = applyImuNoise(
        [0, 0, 0],
        [0, 0, 0],
        state,
        cfg,
        0.05,
        seededRng(12 + i),
      );
      last = out.accel as [number, number, number];
    }
    // After 200 ticks of 0.05 s with instability 0.05 m/s², the bias
    // walk should have drifted well away from zero on at least one axis.
    const maxAbs = Math.max(...last.map(Math.abs));
    expect(maxAbs).toBeGreaterThan(0.01);
  });
});
