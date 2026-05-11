import { describe, expect, it } from 'vitest';
import {
  cameraRelativeToWorld,
  computePinchStrength,
  handOrientation,
  handSize,
  pinchCentroid,
  quatFromBasis,
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

describe('cameraRelativeToWorld', () => {
  // Identity basis: hand axes already aligned with world axes. Result is
  // anchor + target component-wise — i.e. the legacy world-space behavior.
  const idRight: [number, number, number] = [1, 0, 0];
  const idUp: [number, number, number] = [0, 1, 0];
  const idBack: [number, number, number] = [0, 0, 1];

  it('returns the anchor when target is zero', () => {
    expect(
      cameraRelativeToWorld([0, 0, 0], [0, 0.5, 0], idRight, idUp, idBack),
    ).toEqual([0, 0.5, 0]);
  });

  it('with identity basis, sums anchor + target component-wise', () => {
    expect(
      cameraRelativeToWorld([1, 2, 3], [0, 0.5, 0], idRight, idUp, idBack),
    ).toEqual([1, 2.5, 3]);
  });

  it('rotates hand-right by 90° around world Y so it maps to world -Z', () => {
    // Camera orbited 90° to the right around the anchor: the camera now
    // looks down +X, so its right vector points to world -Z and the back
    // vector (away from look direction) points to +X.
    const right: [number, number, number] = [0, 0, -1];
    const up: [number, number, number] = [0, 1, 0];
    const back: [number, number, number] = [1, 0, 0];
    const out = cameraRelativeToWorld([1, 0, 0], [0, 0.5, 0], right, up, back);
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(0.5);
    expect(out[2]).toBeCloseTo(-1);
  });

  it('keeps target on the camera-back axis (toward camera) regardless of orbit', () => {
    // Two camera orientations 180° apart should both move the body in
    // their own "toward camera" direction when target z > 0 — that is the
    // whole point of the orbit-aware mapping.
    const a = cameraRelativeToWorld(
      [0, 0, 1],
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    );
    const b = cameraRelativeToWorld(
      [0, 0, 1],
      [0, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, 0, -1],
    );
    expect(a).toEqual([0, 0, 1]);
    expect(b).toEqual([0, 0, -1]);
  });
});

describe('quatFromBasis', () => {
  it('returns identity for the world-aligned basis', () => {
    const q = quatFromBasis([1, 0, 0], [0, 1, 0], [0, 0, 1]);
    expect(q[0]).toBeCloseTo(0, 6);
    expect(q[1]).toBeCloseTo(0, 6);
    expect(q[2]).toBeCloseTo(0, 6);
    expect(q[3]).toBeCloseTo(1, 6);
  });

  it('represents a 90° rotation around +Z (right→+Y, up→-X)', () => {
    // After a +90° rotation around +Z, world +X (right) maps to +Y, and
    // world +Y (up) maps to -X. Quaternion = (0, 0, sin(45°), cos(45°)).
    const q = quatFromBasis([0, 1, 0], [-1, 0, 0], [0, 0, 1]);
    expect(q[0]).toBeCloseTo(0, 5);
    expect(q[1]).toBeCloseTo(0, 5);
    expect(q[2]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(q[3]).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('emits a unit quaternion', () => {
    // Arbitrary basis: 60° around +Y
    const c = Math.cos(Math.PI / 3);
    const s = Math.sin(Math.PI / 3);
    const q = quatFromBasis([c, 0, -s], [0, 1, 0], [s, 0, c]);
    const len = Math.hypot(q[0], q[1], q[2], q[3]);
    expect(len).toBeCloseTo(1, 5);
  });
});

describe('handOrientation', () => {
  /** Same fixture helper as above but with the extra landmarks 5 and 17
   * that handOrientation reads. */
  function makeOrientedHand(opts: {
    wrist: [number, number, number];
    middleMcp: [number, number, number];
    indexMcp: [number, number, number];
    pinkyMcp: [number, number, number];
  }): Landmark[] {
    const arr: Landmark[] = Array.from({ length: 21 }, () => ({
      x: 0,
      y: 0,
      z: 0,
    }));
    arr[0] = { x: opts.wrist[0], y: opts.wrist[1], z: opts.wrist[2] };
    arr[5] = { x: opts.indexMcp[0], y: opts.indexMcp[1], z: opts.indexMcp[2] };
    arr[9] = {
      x: opts.middleMcp[0],
      y: opts.middleMcp[1],
      z: opts.middleMcp[2],
    };
    arr[17] = { x: opts.pinkyMcp[0], y: opts.pinkyMcp[1], z: opts.pinkyMcp[2] };
    return arr;
  }

  it('returns ~identity for a right hand showing the palm with fingers up', () => {
    // Right hand, palm facing camera. In raw MediaPipe image coords:
    //   wrist below center, middleMCP above wrist (smaller y),
    //   index MCP on the LEFT of the image (smaller x),
    //   pinky MCP on the RIGHT of the image (larger x).
    // After camera-space conversion (negate each axis), this resolves to
    //   up = +Y, right = +X, forward = +Z — i.e. body identity.
    const q = handOrientation(
      makeOrientedHand({
        wrist: [0.5, 0.7, 0],
        middleMcp: [0.5, 0.4, 0],
        indexMcp: [0.4, 0.5, 0],
        pinkyMcp: [0.6, 0.5, 0],
      }),
    )!;
    expect(q[0]).toBeCloseTo(0, 5);
    expect(q[1]).toBeCloseTo(0, 5);
    expect(q[2]).toBeCloseTo(0, 5);
    expect(q[3]).toBeCloseTo(1, 5);
  });

  it('rotates the body around +Z when the hand rolls counter-clockwise on screen', () => {
    // Same right hand, rolled 90° counter-clockwise on the mirrored screen
    // (fingers point to screen-left). In raw MediaPipe coords (un-mirrored)
    // that puts middleMCP to the right of the wrist. Camera-space up =
    // +X, so body-local +Y maps to world +X — a +90° rotation around +Z
    // (q = (0, 0, +sin(45°), cos(45°))).
    const q = handOrientation(
      makeOrientedHand({
        wrist: [0.3, 0.5, 0],
        middleMcp: [0.6, 0.5, 0],
        indexMcp: [0.45, 0.4, 0],
        pinkyMcp: [0.45, 0.6, 0],
      }),
    )!;
    expect(q[0]).toBeCloseTo(0, 4);
    expect(q[1]).toBeCloseTo(0, 4);
    expect(q[2]).toBeCloseTo(Math.SQRT1_2, 4);
    expect(q[3]).toBeCloseTo(Math.SQRT1_2, 4);
  });

  it('returns null when palm-up landmarks coincide (degenerate)', () => {
    expect(
      handOrientation(
        makeOrientedHand({
          wrist: [0.5, 0.5, 0],
          middleMcp: [0.5, 0.5, 0],
          indexMcp: [0.4, 0.5, 0],
          pinkyMcp: [0.6, 0.5, 0],
        }),
      ),
    ).toBeNull();
  });
});

