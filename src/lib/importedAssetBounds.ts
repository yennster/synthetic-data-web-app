import * as THREE from 'three';
import type { ImportedAsset } from '../store/useStore';

export type ImportedAssetBounds = {
  size: [number, number, number];
  maxDim: number;
};

export function boundsFromBox(box: THREE.Box3): ImportedAssetBounds {
  const size = new THREE.Vector3();
  box.getSize(size);
  const dims: [number, number, number] = [size.x, size.y, size.z];
  return {
    size: dims,
    maxDim: Math.max(size.x, size.y, size.z) || 1,
  };
}

export function getImportedAssetBounds(
  asset: Pick<ImportedAsset, 'bounds' | 'object'>,
): ImportedAssetBounds {
  if (asset.bounds) return asset.bounds;
  asset.object.updateMatrixWorld(true);
  return boundsFromBox(new THREE.Box3().setFromObject(asset.object));
}

export function getImportedAssetScaledSize(
  asset: Pick<ImportedAsset, 'bounds' | 'object' | 'scale'>,
): [number, number, number] {
  const b = getImportedAssetBounds(asset);
  return [
    b.size[0] * asset.scale,
    b.size[1] * asset.scale,
    b.size[2] * asset.scale,
  ];
}

export function getImportedAssetHalfExtents(
  asset: Pick<ImportedAsset, 'bounds' | 'object' | 'scale'>,
): [number, number, number] {
  const size = getImportedAssetScaledSize(asset);
  return [size[0] / 2, size[1] / 2, size[2] / 2];
}

/** Imported USDZ assets are re-centered by `loadUsdz()` so their X/Z
 * origin is the footprint center and their Y origin rests on the floor.
 * Robotics pickup math wants the object center, so add half the scaled
 * height back onto the stored floor position. */
export function getImportedAssetCenter(
  asset: Pick<ImportedAsset, 'bounds' | 'object' | 'position' | 'scale'>,
): [number, number, number] {
  const size = getImportedAssetScaledSize(asset);
  return [
    asset.position[0],
    asset.position[1] + size[1] / 2,
    asset.position[2],
  ];
}
