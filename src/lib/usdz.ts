import * as THREE from 'three';
// three-usdz-loader bundles a WASM build of OpenUSD; the WASM/JS deps are
// served from public/usdz-wasm/ (copied by scripts/setup-usdz-wasm.mjs).
// It supports both ASCII (.usda) and Crate (.usdc / binary) USD inside .usdz,
// unlike three.js's built-in USDZLoader which is ASCII-only.
import { USDZLoader as WasmUSDZLoader } from 'three-usdz-loader';
import type { USDZInstance } from 'three-usdz-loader/lib/USDZInstance';

export type LoadedUsdz = {
  object: THREE.Group;
  /** Live USD instance — call `instance.update(seconds)` to advance any
   * baked time-sampled animation (skinning, transforms, vertex). */
  instance: USDZInstance;
  /** True when the USD stage actually has animation baked on it (i.e.
   * endTimeCode > startTimeCode). Apple's animated AR Quick Look samples
   * have this; static models don't. */
  isAnimated: boolean;
  /** Bounding box of the imported geometry in its own local space. */
  localBox: THREE.Box3;
  /** Largest dimension, useful for normalising scale. */
  maxDim: number;
  /** Number of meshes traversed in the imported subtree. */
  meshCount: number;
  /** Approximate triangle count across all meshes. */
  triangleCount: number;
  /** Number of meshes whose only material is the OpenUSD WASM default
   * (typically the magenta "no MDL translator" placeholder). When this is
   * high, the user probably wants to enable the Override Material toggle. */
  defaultMaterialMeshes: number;
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

  const instance = await loader.loadFile(file, wrapper);

  // Detect whether the USD stage has any time-sampled animation. The loader
  // exposes endTimecode in seconds-equivalent (relative to its own internal
  // tick); a value > 1 means the stage was authored with a duration. Static
  // assets default to endTimecode == 1 with timeCodesPerSecond == 24.
  const driverStage = instance.driver.GetStage();
  const startTC = driverStage.GetStartTimeCode?.() ?? 0;
  const endTC = driverStage.GetEndTimeCode?.() ?? 0;
  const isAnimated = endTC > startTC + 0.0001;

  // Apply nice defaults to the imported meshes, and gather diagnostics.
  let meshCount = 0;
  let triangleCount = 0;
  let defaultMaterialMeshes = 0;
  wrapper.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    meshCount += 1;
    m.castShadow = true;
    m.receiveShadow = true;
    if (m.geometry?.index) triangleCount += m.geometry.index.count / 3;
    else if (m.geometry?.attributes?.position)
      triangleCount += m.geometry.attributes.position.count / 3;

    const mats = Array.isArray(m.material) ? m.material : [m.material];
    let allDefaults = true;
    for (const mat of mats) {
      if (!mat) continue;
      const std = mat as THREE.MeshStandardMaterial;
      if (std.envMapIntensity === undefined) std.envMapIntensity = 1.0;
      // Heuristic for "this is the OpenUSD WASM default placeholder material":
      // unnamed, no map, and the colour is bright magenta-ish.
      const hasName = (mat.name && mat.name.length > 0) || false;
      const hasMap = !!(std.map || std.normalMap || std.roughnessMap);
      const c = std.color;
      const isMagenta = c && c.r > 0.85 && c.g < 0.4 && c.b > 0.5;
      if (hasName || hasMap || !isMagenta) allDefaults = false;
    }
    if (mats.length > 0 && allDefaults) defaultMaterialMeshes += 1;
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

  return {
    object: wrapper,
    instance,
    isAnimated,
    localBox,
    maxDim,
    meshCount,
    triangleCount: Math.round(triangleCount),
    defaultMaterialMeshes,
  };
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
