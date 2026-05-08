import { describe, expect, it } from 'vitest';
import { randomPreReleaseMs } from './proceduralMotion';

describe('randomPreReleaseMs', () => {
  it('returns at least 40 ms (so the first sample captures pre-release baseline)', () => {
    const v = randomPreReleaseMs(1500, () => 0); // rng returns 0 → minimum
    expect(v).toBe(40);
  });

  it('caps at 200 ms for normal durations (40 + min(160, 0.15·1500))', () => {
    const v = randomPreReleaseMs(1500, () => 1); // rng → 1 → maximum
    expect(v).toBeCloseTo(200, 5);
  });

  it('caps at 15% of durationMs for short windows', () => {
    // 0.15 × 300 = 45 → max pre-release = 40 + 45 = 85.
    const v = randomPreReleaseMs(300, () => 1);
    expect(v).toBeCloseTo(85, 5);
  });

  it('caps at 200 ms even for very long windows', () => {
    const v = randomPreReleaseMs(60_000, () => 1);
    expect(v).toBeCloseTo(200, 5);
  });

  it('lands somewhere in (40, 200) for the 1500 ms default', () => {
    let n = 50;
    while (n--) {
      const v = randomPreReleaseMs(1500);
      expect(v).toBeGreaterThanOrEqual(40);
      expect(v).toBeLessThanOrEqual(200);
    }
  });

  it('handles zero / negative durationMs without going below the 40 ms floor', () => {
    expect(randomPreReleaseMs(0, () => 1)).toBe(40);
    expect(randomPreReleaseMs(-100, () => 1)).toBe(40);
  });

  it('is deterministic given a seeded rng', () => {
    let i = 0;
    const seq = [0.1, 0.5, 0.9];
    const rng = () => seq[i++ % seq.length];
    expect(randomPreReleaseMs(1500, rng)).toBeCloseTo(40 + 0.1 * 160, 5);
    expect(randomPreReleaseMs(1500, rng)).toBeCloseTo(40 + 0.5 * 160, 5);
    expect(randomPreReleaseMs(1500, rng)).toBeCloseTo(40 + 0.9 * 160, 5);
  });
});
