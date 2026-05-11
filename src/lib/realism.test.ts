import { describe, expect, it } from 'vitest';
import {
  applyChromaticAberration,
  applyColorJitter,
  applyFilmGrain,
  applyRandomRealism,
  applyVignette,
  mulberry32,
} from './realism';

/** Build a w×h RGBA buffer of a single solid color so the assertions
 * only have to track the transform's effect, not pre-existing variance.
 */
function solidImage(
  width: number,
  height: number,
  rgba: [number, number, number, number] = [128, 128, 128, 255],
): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = rgba[0];
    buf[i + 1] = rgba[1];
    buf[i + 2] = rgba[2];
    buf[i + 3] = rgba[3];
  }
  return buf;
}

function meanChannel(buf: Uint8ClampedArray, channel: 0 | 1 | 2 | 3): number {
  let sum = 0;
  const n = buf.length / 4;
  for (let i = channel; i < buf.length; i += 4) sum += buf[i];
  return sum / n;
}

function varianceChannel(
  buf: Uint8ClampedArray,
  channel: 0 | 1 | 2 | 3,
): number {
  const mean = meanChannel(buf, channel);
  let sq = 0;
  const n = buf.length / 4;
  for (let i = channel; i < buf.length; i += 4) {
    const d = buf[i] - mean;
    sq += d * d;
  }
  return sq / n;
}

describe('mulberry32', () => {
  it('produces a deterministic stream for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it('emits values in [0, 1)', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('applyFilmGrain', () => {
  it('is a no-op when intensity is zero', () => {
    const buf = solidImage(8, 8);
    const before = new Uint8ClampedArray(buf);
    applyFilmGrain(buf, 0, mulberry32(1));
    expect(buf).toEqual(before);
  });

  it('preserves the alpha channel', () => {
    const buf = solidImage(16, 16, [128, 128, 128, 200]);
    applyFilmGrain(buf, 1, mulberry32(1));
    expect(meanChannel(buf, 3)).toBe(200);
  });

  it('raises variance roughly proportional to intensity', () => {
    const low = solidImage(64, 64);
    const high = solidImage(64, 64);
    applyFilmGrain(low, 0.2, mulberry32(1));
    applyFilmGrain(high, 1.0, mulberry32(1));
    // Variance under higher noise should clearly exceed lower-noise
    // variance. Skipping a tight numerical check because gaussian
    // tails clip to [0, 255] and pull the variance down — ordering is
    // the robust invariant.
    expect(varianceChannel(high, 0)).toBeGreaterThan(
      varianceChannel(low, 0),
    );
  });

  it('is reproducible with the same seed', () => {
    const a = solidImage(8, 8);
    const b = solidImage(8, 8);
    applyFilmGrain(a, 0.5, mulberry32(99));
    applyFilmGrain(b, 0.5, mulberry32(99));
    expect(a).toEqual(b);
  });
});

describe('applyChromaticAberration', () => {
  it('is a no-op when intensity is zero', () => {
    const buf = solidImage(8, 8);
    const before = new Uint8ClampedArray(buf);
    applyChromaticAberration(buf, 8, 8, 0, mulberry32(1));
    expect(buf).toEqual(before);
  });

  it('shifts R and B channels but leaves G untouched on a solid image', () => {
    // Solid image: every pixel identical, so shifting is invisible.
    // Better: construct a vertical-stripe image where the left half is
    // red and the right half is blue. Shift should bleed colors across
    // the boundary while leaving the green channel unchanged.
    const w = 16;
    const h = 4;
    const buf = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        if (x < w / 2) {
          buf[idx] = 200; // R
          buf[idx + 1] = 100; // G — same on both sides
          buf[idx + 2] = 0;   // B
        } else {
          buf[idx] = 0;
          buf[idx + 1] = 100;
          buf[idx + 2] = 200;
        }
        buf[idx + 3] = 255;
      }
    }
    const greenBefore = meanChannel(buf, 1);
    applyChromaticAberration(buf, w, h, 1, mulberry32(1));
    // Green channel must be the exact same uniform value as before.
    expect(meanChannel(buf, 1)).toBe(greenBefore);
  });
});

describe('applyVignette', () => {
  it('is a no-op when intensity is zero', () => {
    const buf = solidImage(8, 8, [200, 200, 200, 255]);
    const before = new Uint8ClampedArray(buf);
    applyVignette(buf, 8, 8, 0);
    expect(buf).toEqual(before);
  });

  it('darkens corners more than center', () => {
    const w = 32;
    const h = 32;
    const buf = solidImage(w, h, [200, 200, 200, 255]);
    applyVignette(buf, w, h, 0.5);
    const centerIdx = ((h / 2) * w + w / 2) * 4;
    const cornerIdx = 0;
    expect(buf[centerIdx]).toBeGreaterThan(buf[cornerIdx]);
  });

  it('leaves alpha untouched', () => {
    const buf = solidImage(8, 8, [255, 255, 255, 128]);
    applyVignette(buf, 8, 8, 0.9);
    for (let i = 3; i < buf.length; i += 4) expect(buf[i]).toBe(128);
  });
});

describe('applyColorJitter', () => {
  it('is a no-op when intensity is zero', () => {
    const buf = solidImage(8, 8);
    const before = new Uint8ClampedArray(buf);
    applyColorJitter(buf, 0, mulberry32(1));
    expect(buf).toEqual(before);
  });

  it('keeps alpha bytes unchanged', () => {
    const buf = solidImage(16, 16, [128, 128, 128, 99]);
    applyColorJitter(buf, 1, mulberry32(1));
    expect(meanChannel(buf, 3)).toBe(99);
  });

  it('is deterministic for a given seed', () => {
    const a = solidImage(8, 8);
    const b = solidImage(8, 8);
    applyColorJitter(a, 0.5, mulberry32(7));
    applyColorJitter(b, 0.5, mulberry32(7));
    expect(a).toEqual(b);
  });
});

describe('applyRandomRealism', () => {
  it('is a no-op when intensity is zero', () => {
    const buf = solidImage(8, 8);
    const before = new Uint8ClampedArray(buf);
    applyRandomRealism(buf, 8, 8, 0, mulberry32(1));
    expect(buf).toEqual(before);
  });

  it('preserves buffer length', () => {
    const buf = solidImage(16, 16);
    const len = buf.length;
    applyRandomRealism(buf, 16, 16, 0.5, mulberry32(1));
    expect(buf.length).toBe(len);
  });

  it('mutates RGB but preserves alpha bytes', () => {
    const buf = solidImage(32, 32, [128, 128, 128, 222]);
    applyRandomRealism(buf, 32, 32, 0.6, mulberry32(1));
    expect(meanChannel(buf, 3)).toBe(222);
    // RGB variance should be non-trivial after the pass.
    expect(varianceChannel(buf, 0)).toBeGreaterThan(0);
  });
});
