import { afterEach, describe, expect, it } from 'vitest';
import { mulberry32 } from './realism';
import { _resetRngForTest, getRng, isSeeded, rng } from './rng';

afterEach(() => {
  _resetRngForTest(); // back to lazy Math.random fallback
});

describe('rng', () => {
  it('falls through to a uniform [0, 1) when no seed is configured', () => {
    // Without ?seed in the URL, the singleton resolves to Math.random.
    for (let i = 0; i < 50; i++) {
      const n = rng();
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
  });

  it('isSeeded reflects the URL state', () => {
    // urlParams parsed at module load — without ?seed, this is false.
    expect(isSeeded()).toBe(false);
  });

  it('a seeded RNG is fully reproducible', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });

  it('different seeds produce different streams', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    let same = 0;
    for (let i = 0; i < 100; i++) {
      if (Math.abs(a() - b()) < 1e-12) same += 1;
    }
    expect(same).toBeLessThan(5);
  });

  it('_resetRngForTest accepts a custom rng for injection', () => {
    let n = 0;
    _resetRngForTest(() => ++n / 10);
    expect(rng()).toBeCloseTo(0.1);
    expect(rng()).toBeCloseTo(0.2);
    expect(getRng()()).toBeCloseTo(0.3);
  });
});
