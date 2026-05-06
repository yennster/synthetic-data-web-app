import { describe, expect, it } from 'vitest';
import {
  BELT_LENGTH,
  BELT_TOP_Y,
  BELT_TRANSPORTABLES,
  BELT_WIDTH,
  isOnBelt,
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
