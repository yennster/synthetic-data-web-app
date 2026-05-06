import * as THREE from 'three';
// three-usdz-loader bundles a WASM build of OpenUSD; the WASM/JS deps are
// served from public/usdz-wasm/ (copied by scripts/setup-usdz-wasm.mjs).
// It supports both ASCII (.usda) and Crate (.usdc / binary) USD inside .usdz,
// unlike three.js's built-in USDZLoader which is ASCII-only.
import { USDZLoader as WasmUSDZLoader } from 'three-usdz-loader';

export type LoadedUsdz = {
  object: THREE.Group;
  /** Bounding box of the imported geometry in its own local space. */
  localBox: THREE.Box3;
  /** Largest dimension, useful for normalising scale. */
  maxDim: number;
};

let _loader: WasmUSDZLoader | null = null;

function getLoader(): WasmUSDZLoader {
  if (!_loader) _loader = new WasmUSDZLoader('/usdz-wasm');
  return _loader;
}

/**
 * Load a `.usdz` file (which is a ZIP of USD + textures) into a three.js
 * Group. Plain `.usd` / `.usda` / `.usdc` files need to be packaged into a
 * `.usdz` (or converted) before importing — see the README.
 *
 * The returned Group's `userData` is empty; callers attach `label` and
 * other metadata as needed for bounding-box projection / capture.
 */
export async function loadUsdz(file: File): Promise<LoadedUsdz> {
  const loader = getLoader();

  // Outer wrapper that we own; the loader populates a child group within.
  const wrapper = new THREE.Group();
  wrapper.userData.usdzWrapper = true;

  await loader.loadFile(file, wrapper);

  // Apply nice defaults to the imported meshes.
  wrapper.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        if ((mat as THREE.MeshStandardMaterial).envMapIntensity === undefined) {
          (mat as THREE.MeshStandardMaterial).envMapIntensity = 1.0;
        }
      }
    }
  });

  // Compute local-space bounding box and re-centre on origin (XZ centred,
  // Y resting on 0) so position/scale controls behave intuitively.
  wrapper.updateMatrixWorld(true);
  const localBox = new THREE.Box3().setFromObject(wrapper);
  const size = new THREE.Vector3();
  localBox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  const cx = (localBox.min.x + localBox.max.x) / 2;
  const cz = (localBox.min.z + localBox.max.z) / 2;
  const minY = localBox.min.y;
  // Shift the children of wrapper, not wrapper itself, so the user's
  // outer transform is unaffected.
  const inner = new THREE.Group();
  while (wrapper.children.length) {
    inner.add(wrapper.children[0]);
  }
  inner.position.set(-cx, -minY, -cz);
  wrapper.add(inner);

  return { object: wrapper, localBox, maxDim };
}

/**
 * Free GPU resources held by an imported asset. Call when removing it
 * from the scene.
 */
export function disposeUsdz(group: THREE.Group): void {
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose?.();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      for (const key of Object.keys(mat)) {
        const v = (mat as unknown as Record<string, unknown>)[key];
        if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
      }
      mat?.dispose?.();
    }
  });
}
