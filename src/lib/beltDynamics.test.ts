import { describe, expect, it } from 'vitest';
import {
  BELT_LENGTH,
  BELT_TOP_Y,
  BELT_TRANSPORTABLES,
  BELT_WIDTH,
  beltTextureOffsetDelta,
  isOnBelt,
  visualScrollDistance,
} from './beltDynamics';

describe('isOnBelt', () => {
  it('returns true for a body sitting on the belt centre', () => {
    expect(isOnBelt({ x: 0, y: BELT_TOP_Y + 0.1, z: 0 })).toBe(true);
  });

  it('returns true for a body resting just above the belt surface', () => {
    expect(isOnBelt({ x: 0.5, y: BELT_TOP_Y + 0.01, z: 1 })).toBe(true);
  });

  it('returns false for a body below the belt surface', () => {
    // Slightly below the lower bound of the on-belt band.
    expect(isOnBelt({ x: 0, y: BELT_TOP_Y - 0.5, z: 0 })).toBe(false);
  });

  it('returns false for a body high above the belt', () => {
    expect(isOnBelt({ x: 0, y: BELT_TOP_Y + 5, z: 0 })).toBe(false);
  });

  it('returns false for a body outside the belt X footprint', () => {
    expect(
      isOnBelt({ x: BELT_WIDTH / 2 + 0.5, y: BELT_TOP_Y + 0.1, z: 0 }),
    ).toBe(false);
  });

  it('returns false for a body past the belt Z extent', () => {
    expect(
      isOnBelt({ x: 0, y: BELT_TOP_Y + 0.1, z: BELT_LENGTH / 2 + 0.5 }),
    ).toBe(false);
  });
});

describe('BELT_TRANSPORTABLES', () => {
  it('is a Set, mutable from any module', () => {
    expect(BELT_TRANSPORTABLES).toBeInstanceOf(Set);
    const fake = {} as never;
    BELT_TRANSPORTABLES.add(fake);
    expect(BELT_TRANSPORTABLES.has(fake)).toBe(true);
    BELT_TRANSPORTABLES.delete(fake);
  });
});

/**
 * Regression coverage for the "stripes scroll faster than the bodies" bug
 * (#10). The fix scales the per-frame UV-offset advance by `repeat /
 * length` so the visible texture motion (m/s of world) matches whatever
 * the rigid bodies on top are doing. These tests lock that math in:
 * if anyone ever drops the scaling factor, simulates the body in a
 * different unit, or flips the ratio, the round-trip distance check
 * fails immediately.
 */
describe('beltTextureOffsetDelta / visualScrollDistance', () => {
  /** Defaults that match the live conveyor — keep these mirrored with
   *  Conveyor.tsx so the test reflects the deployed configuration. */
  const REPEAT = 6;
  const LENGTH = BELT_LENGTH; // 8m

  it('round-trips: stripes travel exactly `speed * dt` in world space', () => {
    // For a range of belt speeds and frame durations, advancing the
    // UV offset by `beltTextureOffsetDelta(...)` and then converting
    // it back through `visualScrollDistance(...)` must yield the same
    // distance the rigid body would have travelled — that's the whole
    // invariant the conveyor relies on.
    for (const speed of [-2, -0.5, 0, 0.5, 1, 1.5, 2]) {
      for (const dt of [1 / 120, 1 / 60, 1 / 30, 0.1, 1.0]) {
        const offset = beltTextureOffsetDelta(speed, dt, REPEAT, LENGTH);
        const scrolled = visualScrollDistance(offset, REPEAT, LENGTH);
        expect(scrolled).toBeCloseTo(speed * dt, 9);
      }
    }
  });

  it('does not regress to the unscaled formula', () => {
    // Pre-fix code did `offset.y += speed * dt`, which overshot the
    // actual body distance by a factor of `length / repeat` (= 8/6 ≈
    // 1.33 for the live config). Guard against the most likely
    // regression by asserting the helper does NOT equal the naive form.
    const speed = 1;
    const dt = 1 / 60;
    expect(beltTextureOffsetDelta(speed, dt, REPEAT, LENGTH)).not.toBeCloseTo(
      speed * dt,
      6,
    );
    // And asserts the exact value at the live config so a future
    // refactor can't silently shift the ratio.
    expect(beltTextureOffsetDelta(1, 1, REPEAT, LENGTH)).toBeCloseTo(
      REPEAT / LENGTH,
      9,
    );
  });

  it('flips sign with belt speed', () => {
    // Negative belt speed has to scroll the texture backwards.
    expect(beltTextureOffsetDelta(-1, 0.1, REPEAT, LENGTH)).toBeLessThan(0);
    expect(beltTextureOffsetDelta(0, 0.1, REPEAT, LENGTH)).toBe(0);
  });

  it('handles arbitrary repeat / length without breaking the invariant', () => {
    // Surface the invariant for non-default configurations too — if the
    // belt geometry ever changes, the helper still has to track it.
    for (const repeat of [1, 3, 6, 12]) {
      for (const length of [2, 8, 20]) {
        const offset = beltTextureOffsetDelta(1.5, 0.05, repeat, length);
        const scrolled = visualScrollDistance(offset, repeat, length);
        expect(scrolled).toBeCloseTo(1.5 * 0.05, 9);
      }
    }
  });
});
