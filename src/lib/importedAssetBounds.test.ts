import { describe, expect, it } from 'vitest';
import { getImportedAssetHalfExtents } from './importedAssetBounds';

describe('imported asset bounds helpers', () => {
  it('computes scaled half extents for physics proxies', () => {
    const half = getImportedAssetHalfExtents({
      object: null as never,
      scale: 0.05,
      bounds: { size: [1, 2, 0.5], maxDim: 2 },
    });
    expect(half).toEqual([0.025, 0.05, 0.0125]);
  });
});
