import { describe, expect, it } from 'vitest';
import {
  computePinchStrength,
  handSize,
  pinchCentroid,
  type Landmark,
} from './handMath';

/**
 * Build a 21-landmark hand. We only populate the landmarks the math actually
 * reads (wrist=0, thumb-tip=4, index-tip=8, middle-MCP=9); the rest are
 * zero-filled so the array length matches what MediaPipe normally emits.
 */
function makeHand(opts: {
  wrist: [number, number, number];
  thumbTip: [number, number, number];
  indexTip: [number, number, number];
  middleMcp: [number, number, number];
}): Landmark[] {
  const arr: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  arr[0] = { x: opts.wrist[0], y: opts.wrist[1], z: opts.wrist[2] };
  arr[4] = { x: opts.thumbTip[0], y: opts.thumbTip[1], z: opts.thumbTip[2] };
  arr[8] = { x: opts.indexTip[0], y: opts.indexTip[1], z: opts.indexTip[2] };
  arr[9] = { x: opts.middleMcp[0], y: opts.middleMcp[1], z: opts.middleMcp[2] };
  return arr;
}

describe('computePinchStrength', () => {
  it('returns ~1 (closed) when thumb and index tips are touching', () => {
    const hand = makeHand({
      wrist: [0, 0, 0],
      middleMcp: [0, -1, 0], // hand size = 1
      thumbTip: [0, -0.5, 0],
      indexTip: [0.001, -0.5, 0], // basically the same point
    });
    expect(computePinchStrength(hand)).toBeCloseTo(1, 1);
  });

  it('returns 0 (open) when tips are far apart relative to hand size', () => {
    const hand = makeHand({
      wrist: [0, 0, 0],
      middleMcp: [0, -1, 0], // hand size = 1
      thumbTip: [-0.4, -0.5, 0],
      indexTip: [0.4, -0.5, 0], // ratio 0.8 → above the 0.6 cutoff → 0
    });
    expect(computePinchStrength(hand)).toBe(0);
  });

  it('clamps result into [0, 1]', () => {
    const hand = makeHand({
      wrist: [0, 0, 0],
      middleMcp: [0, -1, 0],
      thumbTip: [10, -0.5, 0],
      indexTip: [-10, -0.5, 0], // distance way bigger than hand
    });
    const v = computePinchStrength(hand);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });

  it('handles a degenerate hand size without dividing by zero', () => {
    const hand = makeHand({
      wrist: [0, 0, 0],
      middleMcp: [0, 0, 0], // hand size = 0 → should fall back, not NaN
      thumbTip: [0, 0, 0],
      indexTip: [0, 0, 0],
    });
    const v = computePinchStrength(hand);
    expect(Number.isFinite(v)).toBe(true);
  });
});

describe('pinchCentroid', () => {
  it('returns the midpoint of thumb-tip and index-tip', () => {
    const hand = makeHand({
      wrist: [0, 0, 0],
      middleMcp: [0, -1, 0],
      thumbTip: [0.2, 0.4, -0.1],
      indexTip: [0.4, 0.6, 0.3],
    });
    const c = pinchCentroid(hand);
    expect(c.x).toBeCloseTo(0.3, 5);
    expect(c.y).toBeCloseTo(0.5, 5);
    expect(c.z).toBeCloseTo(0.1, 5);
  });

  it('treats missing landmark.z as 0', () => {
    const hand: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));
    hand[4] = { x: 0.2, y: 0.4 };
    hand[8] = { x: 0.4, y: 0.6 };
    const c = pinchCentroid(hand);
    expect(c.z).toBe(0);
  });
});

describe('handSize', () => {
  it('returns the wrist→middle-MCP distance in image-normalized units', () => {
    const hand = makeHand({
      wrist: [0.5, 0.8, 0],
      middleMcp: [0.5, 0.68, 0], // 0.12 below the wrist
      thumbTip: [0, 0, 0],
      indexTip: [0, 0, 0],
    });
    expect(handSize(hand)).toBeCloseTo(0.12, 5);
  });

  it('grows when the hand is closer to the camera (landmarks more spread)', () => {
    const far = makeHand({
      wrist: [0.5, 0.8, 0],
      middleMcp: [0.5, 0.74, 0], // 0.06
      thumbTip: [0, 0, 0],
      indexTip: [0, 0, 0],
    });
    const near = makeHand({
      wrist: [0.5, 0.85, 0],
      middleMcp: [0.5, 0.65, 0], // 0.20
      thumbTip: [0, 0, 0],
      indexTip: [0, 0, 0],
    });
    expect(handSize(near)).toBeGreaterThan(handSize(far));
  });

  it('uses xy only — ignores landmark.z so missing z is fine', () => {
    const a = makeHand({
      wrist: [0, 0, 0],
      middleMcp: [0, 0.1, 0],
      thumbTip: [0, 0, 0],
      indexTip: [0, 0, 0],
    });
    const b = makeHand({
      wrist: [0, 0, 5],
      middleMcp: [0, 0.1, -5],
      thumbTip: [0, 0, 0],
      indexTip: [0, 0, 0],
    });
    expect(handSize(a)).toBeCloseTo(handSize(b), 5);
  });
});
