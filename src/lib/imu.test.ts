import { describe, expect, it } from 'vitest';
import { computeImuReading } from './imu';

const IDENTITY: [number, number, number, number] = [0, 0, 0, 1];
const G = 9.81;

const close = (a: number, b: number, eps = 1e-6) =>
  Math.abs(a - b) < eps;

describe('computeImuReading', () => {
  it('stationary body reads (0, +g, 0) on the accelerometer and zero on the gyro', () => {
    const r = computeImuReading({
      linvel: [0, 0, 0],
      prevLinvel: [0, 0, 0],
      angVelWorld: [0, 0, 0],
      qCur: IDENTITY,
      dt: 0.01,
    });
    expect(r.ax).toBeCloseTo(0, 6);
    expect(r.ay).toBeCloseTo(G, 6);
    expect(r.az).toBeCloseTo(0, 6);
    expect(r.gx).toBeCloseTo(0, 6);
    expect(r.gy).toBeCloseTo(0, 6);
    expect(r.gz).toBeCloseTo(0, 6);
  });

  it('free-fall reads (0, 0, 0) on the accelerometer', () => {
    // After one tick of free-fall: linvel grew from 0 to -g·dt along the
    // world Y axis. a_inertial = -g, a_proper = a_inertial − g_world = 0.
    const dt = 0.01;
    const r = computeImuReading({
      linvel: [0, -G * dt, 0],
      prevLinvel: [0, 0, 0],
      angVelWorld: [0, 0, 0],
      qCur: IDENTITY,
      dt,
    });
    expect(r.ax).toBeCloseTo(0, 5);
    expect(r.ay).toBeCloseTo(0, 5);
    expect(r.az).toBeCloseTo(0, 5);
  });

  it('continuous free-fall (steady -g linvel growth) keeps the accelerometer at zero', () => {
    // Several consecutive ticks where linvel keeps growing by -g·dt.
    const dt = 0.01;
    let prev: [number, number, number] = [0, 0, 0];
    for (let i = 1; i <= 5; i++) {
      const linvel: [number, number, number] = [0, -G * i * dt, 0];
      const r = computeImuReading({
        linvel,
        prevLinvel: prev,
        angVelWorld: [0, 0, 0],
        qCur: IDENTITY,
        dt,
      });
      expect(r.ax).toBeCloseTo(0, 5);
      expect(r.ay).toBeCloseTo(0, 5);
      expect(r.az).toBeCloseTo(0, 5);
      prev = linvel;
    }
  });

  it('hard impact (sudden velocity reversal) produces a large positive y reading', () => {
    // Hitting the floor: linvel snaps from -5 m/s to +1 m/s in one tick.
    // a_inertial_y = (1 − (−5))/0.01 = 600 m/s². a_proper_y = 600 − (−9.81) ≈ 609.81.
    const r = computeImuReading({
      linvel: [0, 1, 0],
      prevLinvel: [0, -5, 0],
      angVelWorld: [0, 0, 0],
      qCur: IDENTITY,
      dt: 0.01,
    });
    expect(r.ay).toBeCloseTo(609.81, 2);
    expect(r.ax).toBeCloseTo(0, 5);
    expect(r.az).toBeCloseTo(0, 5);
  });

  it('zero dt is clamped (no division-by-zero blowup)', () => {
    const r = computeImuReading({
      linvel: [0.001, -0.002, 0.003],
      prevLinvel: [0, 0, 0],
      angVelWorld: [0, 0, 0],
      qCur: IDENTITY,
      dt: 0,
    });
    // Values are finite; the magnitudes are large (because the eps clamp
    // is 1e-9) but they don't NaN or Infinity.
    expect(Number.isFinite(r.ax)).toBe(true);
    expect(Number.isFinite(r.ay)).toBe(true);
    expect(Number.isFinite(r.az)).toBe(true);
  });

  it('respects a custom gravity vector (e.g. zero-g spaceflight)', () => {
    const r = computeImuReading({
      linvel: [0, 0, 0],
      prevLinvel: [0, 0, 0],
      angVelWorld: [0, 0, 0],
      qCur: IDENTITY,
      dt: 0.01,
      gWorld: [0, 0, 0],
    });
    expect(r.ax).toBeCloseTo(0, 6);
    expect(r.ay).toBeCloseTo(0, 6);
    expect(r.az).toBeCloseTo(0, 6);
  });

  it('rotates gravity into the body frame: body tipped 90° about Z', () => {
    // q = (0, 0, sin(45°), cos(45°)) rotates the body +90° about world Z,
    // so the body's +X axis ends up pointing along world +Y. Expressing
    // world-frame proper acceleration (0, +g, 0) in the body frame
    // therefore lands +g on body +X.
    const s = Math.SQRT1_2;
    const r = computeImuReading({
      linvel: [0, 0, 0],
      prevLinvel: [0, 0, 0],
      angVelWorld: [0, 0, 0],
      qCur: [0, 0, s, s],
      dt: 0.01,
    });
    expect(r.ax).toBeCloseTo(G, 5);
    expect(r.ay).toBeCloseTo(0, 5);
    expect(r.az).toBeCloseTo(0, 5);
  });

  it('rotates gyro into the body frame: body tipped 90° about X', () => {
    // q = (sin(45°), 0, 0, cos(45°)) rotates the body +90° about world X,
    // so the body's +Y axis ends up pointing along world +Z. World-frame
    // angular velocity (0, 1.5708, 0) (≈ 90°/s about world Y) therefore
    // lands on the body's local −Z.
    const s = Math.SQRT1_2;
    const r = computeImuReading({
      linvel: [0, 0, 0],
      prevLinvel: [0, 0, 0],
      angVelWorld: [0, 1.5708, 0],
      qCur: [s, 0, 0, s],
      dt: 0.01,
      gWorld: [0, 0, 0],
    });
    expect(close(r.gx, 0, 1e-3)).toBe(true);
    expect(close(r.gy, 0, 1e-3)).toBe(true);
    expect(r.gz).toBeCloseTo(-1.5708, 3);
  });

  it('regression — does NOT spike when prevLinvel and linvel are equal across many ticks', () => {
    // The bug we just fixed: a previous version emitted multiple samples
    // per render frame, so the second sample saw linvel collapse to zero
    // and the next frame's first sample saw a (V − 0)/dt spike. With the
    // new "at most one sample per frame" + Rapier-linvel approach the
    // sampler can't see a phantom velocity drop. Sanity check: a constant
    // (drifting) linvel should produce zero proper acceleration on a
    // gravity-free path, no matter how many ticks we run.
    const v: [number, number, number] = [0.5, -0.3, 0.2];
    let prev: [number, number, number] = [...v];
    for (let i = 0; i < 20; i++) {
      const r = computeImuReading({
        linvel: v,
        prevLinvel: prev,
        angVelWorld: [0, 0, 0],
        qCur: IDENTITY,
        dt: 0.01,
        gWorld: [0, 0, 0],
      });
      expect(close(r.ax, 0)).toBe(true);
      expect(close(r.ay, 0)).toBe(true);
      expect(close(r.az, 0)).toBe(true);
      prev = [...v];
    }
  });
});
