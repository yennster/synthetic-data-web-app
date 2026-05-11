import { describe, expect, it } from 'vitest';
import {
  sampleImu,
  type ImuSource,
  type NoiseStateRef,
} from './imuSensor';
import { DEFAULT_IMU_NOISE, type ImuNoiseConfig } from '../imuNoise';
import type { ImuReading } from './BraccioSim';

/** Fake `ImuSource` that returns whatever reading you wired up. The
 * shared sampler doesn't care where the values come from — that's the
 * whole point of the abstraction. */
function fakeSource(reading: ImuReading): ImuSource {
  return { readImu: () => reading };
}

/** Disable noise so the sample's accel/gyro fields equal the source
 * reading bit-for-bit. Keeps these tests focused on the pipeline
 * plumbing, not on the noise math (which has its own coverage in
 * `imuNoise.test.ts`). */
const NO_NOISE: ImuNoiseConfig = { ...DEFAULT_IMU_NOISE, enabled: false };

describe('sampleImu', () => {
  it('forwards accel + gyro from the source into the AccelSample shape', () => {
    const noiseRef: NoiseStateRef = { current: null };
    const source = fakeSource({
      accel: [1, 9.81, -2],
      gyro: [0.1, -0.2, 0.3],
      quat: [1, 0, 0, 0],
      pos: [0, 0, 0],
    });
    const sample = sampleImu(source, noiseRef, NO_NOISE, 0.01);
    expect(sample.ax).toBeCloseTo(1, 9);
    expect(sample.ay).toBeCloseTo(9.81, 9);
    expect(sample.az).toBeCloseTo(-2, 9);
    expect(sample.gx).toBeCloseTo(0.1, 9);
    expect(sample.gy).toBeCloseTo(-0.2, 9);
    expect(sample.gz).toBeCloseTo(0.3, 9);
  });

  it('stamps the sample with performance.now()', () => {
    const noiseRef: NoiseStateRef = { current: null };
    const source = fakeSource({
      accel: [0, 0, 0],
      gyro: [0, 0, 0],
      quat: [1, 0, 0, 0],
      pos: [0, 0, 0],
    });
    const before = performance.now();
    const sample = sampleImu(source, noiseRef, NO_NOISE, 0.01);
    const after = performance.now();
    expect(sample.t).toBeGreaterThanOrEqual(before);
    expect(sample.t).toBeLessThanOrEqual(after + 1); // 1 ms slack
  });

  it('lazily initializes the noise state on first call', () => {
    const noiseRef: NoiseStateRef = { current: null };
    const source = fakeSource({
      accel: [0, 9.81, 0],
      gyro: [0, 0, 0],
      quat: [1, 0, 0, 0],
      pos: [0, 0, 0],
    });
    expect(noiseRef.current).toBeNull();
    sampleImu(source, noiseRef, DEFAULT_IMU_NOISE, 0.01);
    expect(noiseRef.current).not.toBeNull();
  });

  it('reuses the noise state across calls (bias drift accumulates)', () => {
    const noiseRef: NoiseStateRef = { current: null };
    const source = fakeSource({
      accel: [0, 9.81, 0],
      gyro: [0, 0, 0],
      quat: [1, 0, 0, 0],
      pos: [0, 0, 0],
    });
    sampleImu(source, noiseRef, DEFAULT_IMU_NOISE, 0.01);
    const stateAfterFirst = noiseRef.current;
    sampleImu(source, noiseRef, DEFAULT_IMU_NOISE, 0.01);
    // Same object reference — the noise math mutates it in place
    // rather than allocating a fresh state each tick.
    expect(noiseRef.current).toBe(stateAfterFirst);
  });
});
