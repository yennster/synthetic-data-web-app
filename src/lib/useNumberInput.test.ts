import { describe, expect, it } from 'vitest';
import {
  clampNumber,
  decideOnBlur,
  decideOnChange,
} from './useNumberInput';

describe('clampNumber', () => {
  it('returns the value unchanged when no bounds are given', () => {
    expect(clampNumber(42)).toBe(42);
    expect(clampNumber(-7.5)).toBe(-7.5);
  });

  it('clamps to min when below', () => {
    expect(clampNumber(-3, { min: 1 })).toBe(1);
  });

  it('clamps to max when above', () => {
    expect(clampNumber(9999, { max: 500 })).toBe(500);
  });

  it('respects both bounds', () => {
    expect(clampNumber(50, { min: 1, max: 100 })).toBe(50);
    expect(clampNumber(0, { min: 1, max: 100 })).toBe(1);
    expect(clampNumber(150, { min: 1, max: 100 })).toBe(100);
  });
});

describe('decideOnChange', () => {
  it('preserves an empty draft without committing (the original bug)', () => {
    expect(decideOnChange('', 10)).toEqual({ draft: '', commit: null });
  });

  it('preserves a lone "-" so users can type negative numbers', () => {
    expect(decideOnChange('-', 0)).toEqual({ draft: '-', commit: null });
  });

  it('commits a finite number that differs from the current value', () => {
    expect(decideOnChange('25', 10)).toEqual({ draft: '25', commit: 25 });
  });

  it('does not commit when the typed number equals the current value', () => {
    expect(decideOnChange('10', 10)).toEqual({ draft: '10', commit: null });
  });

  it('clamps committed values to [min, max]', () => {
    expect(decideOnChange('9999', 10, { min: 1, max: 500 })).toEqual({
      draft: '9999',
      commit: 500,
    });
    expect(decideOnChange('-50', 10, { min: 1, max: 500 })).toEqual({
      draft: '-50',
      commit: 1,
    });
  });

  it('preserves garbage drafts without committing', () => {
    expect(decideOnChange('abc', 42)).toEqual({ draft: 'abc', commit: null });
  });

  it('handles decimal partial entries like "1." mid-typing', () => {
    // "1." parses as 1.
    const r = decideOnChange('1.', 0);
    expect(r.draft).toBe('1.');
    expect(r.commit).toBe(1);
  });
});

describe('decideOnBlur', () => {
  it('snaps an empty draft back to the upstream value', () => {
    expect(decideOnBlur('', 10)).toEqual({ draft: '10', commit: null });
  });

  it('snaps a lone "-" back to the upstream value', () => {
    expect(decideOnBlur('-', 7)).toEqual({ draft: '7', commit: null });
  });

  it('snaps unparseable garbage back to the upstream value', () => {
    expect(decideOnBlur('abc', 42)).toEqual({ draft: '42', commit: null });
  });

  it('keeps a valid draft as-is and does not re-commit if it matches', () => {
    expect(decideOnBlur('10', 10)).toEqual({ draft: '10', commit: null });
  });

  it('rewrites the draft to the clamped boundary when out of range', () => {
    expect(decideOnBlur('9999', 10, { min: 1, max: 500 })).toEqual({
      draft: '500',
      commit: 500,
    });
    expect(decideOnBlur('-50', 10, { min: 1, max: 500 })).toEqual({
      draft: '1',
      commit: 1,
    });
  });

  it('commits an in-range draft that differs from the upstream value', () => {
    expect(decideOnBlur('42', 10)).toEqual({ draft: '42', commit: 42 });
  });
});
