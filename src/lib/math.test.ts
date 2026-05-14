import { describe, expect, it } from 'vitest';
import { clamp, clamp01, degToRad, lerp, radToDeg, smoothstep, wrapAngle } from './math';

describe('clamp', () => {
  it('passes values inside the range through unchanged', () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp(-2, -5, 5)).toBe(-2);
  });

  it('clamps to the lower bound', () => {
    expect(clamp(-1, 0, 1)).toBe(0);
  });

  it('clamps to the upper bound', () => {
    expect(clamp(2, 0, 1)).toBe(1);
  });

  it('collapses NaN / Infinity to the lower bound rather than propagating', () => {
    expect(clamp(NaN, 0, 1)).toBe(0);
    expect(clamp(Infinity, 0, 1)).toBe(0);
    expect(clamp(-Infinity, 0, 1)).toBe(0);
  });
});

describe('clamp01', () => {
  it('shorthand for clamp(v, 0, 1)', () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(7)).toBe(1);
  });
});

describe('lerp', () => {
  it('interpolates linearly between a and b', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
  });

  it('extrapolates past the endpoints when t is outside [0, 1]', () => {
    expect(lerp(0, 10, 2)).toBe(20);
    expect(lerp(0, 10, -1)).toBe(-10);
  });
});

describe('smoothstep', () => {
  it('pins endpoints', () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
  });

  it('matches the 3t²-2t³ formula at the midpoint', () => {
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 10);
  });

  it('clamps inputs outside [0, 1]', () => {
    expect(smoothstep(2)).toBe(1);
    expect(smoothstep(-1)).toBe(0);
  });
});

describe('degToRad / radToDeg', () => {
  it('round-trips', () => {
    expect(degToRad(180)).toBeCloseTo(Math.PI, 10);
    expect(radToDeg(Math.PI)).toBeCloseTo(180, 10);
  });

  it('handles zero and negative values', () => {
    expect(degToRad(0)).toBe(0);
    expect(radToDeg(-Math.PI / 2)).toBeCloseTo(-90, 10);
  });
});

describe('wrapAngle', () => {
  it('passes angles already in (-π, π] through unchanged', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI / 2)).toBeCloseTo(Math.PI / 2, 10);
    expect(wrapAngle(-Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 10);
  });

  it('wraps angles past π into the negative half', () => {
    expect(wrapAngle(Math.PI + 0.1)).toBeCloseTo(-Math.PI + 0.1, 10);
  });

  it('wraps angles past -π into the positive half', () => {
    expect(wrapAngle(-Math.PI - 0.1)).toBeCloseTo(Math.PI - 0.1, 10);
  });
});
