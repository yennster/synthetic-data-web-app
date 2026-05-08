import * as THREE from 'three';
// @needle-tools/usd ships a self-built OpenUSD WebAssembly runtime + a
// three.js Hydra render delegate. We pick it over the smaller
// `three-usdz-loader` because its WASM bundles the UsdSkel schema plugins,
// which Apple's animated AR Quick Look samples (hummingbird, drummer,
// chameleon) need — without UsdSkel, Hydra never instantiates render prims
// for those files and the asset shows up invisibly. The .wasm/.data/.js/.worker.js
// files are copied to public/usdz-wasm/ by scripts/setup-usdz-wasm.mjs.
import {
  createThreeHydra,
  getUsdModule,
  type HydraFile,
  type NeedleThreeHydraHandle,
  type USD,
} from '@needle-tools/usd';

export type LoadedUsdz = {
  object: THREE.Group;
  /** Live needle hydra handle. Call `handle.update(dt)` per frame to advance
   * any baked time-sampled animation. `dispose()` releases the virtual
   * filesystem entries the loader created for this asset. */
  handle: NeedleThreeHydraHandle;
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

let _usdPromise: Promise<USD> | null = null;
function getUsd(): Promise<USD> {
  if (!_usdPromise) {
    _usdPromise = getUsdModule({
      // Vite serves /public/* at the site root, so the four emHdBindings.*
      // files live at /usdz-wasm/* and need to be co-located: the .js
      // bootstrapper internally fetches the .wasm/.data/.worker.js siblings
      // by relative URL.
      mainScriptUrlOrBlob: '/usdz-wasm/emHdBindings.js',
    });
  }
  return _usdPromise;
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
  const USD = await getUsd();

  // Outer wrapper that we own; the loader populates it with the imported
  // prims directly (no `inner` child added by the loader itself).
  const wrapper = new THREE.Group();
  wrapper.userData.usdzWrapper = true;

  const buffer = await file.arrayBuffer();
  // The needle loader needs `path` on the file so it can place it under the
  // right directory in its in-memory virtual filesystem. We copy the File
  // rather than mutate the caller's object.
  const hydraFile = new File([buffer], file.name, { type: file.type }) as HydraFile;
  hydraFile.path = file.name;

  const handle = await createThreeHydra({
    USD,
    buffer,
    files: [hydraFile],
    scene: wrapper,
  });

  // Detect whether the USD stage has any time-sampled animation. The driver
  // exposes start/end timecodes; if they're equal the stage is static.
  const stage = handle.driver.GetStage();
  const startTC = stage.GetStartTimeCode?.() ?? 0;
  const endTC = stage.GetEndTimeCode?.() ?? 0;
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

  // Compute local-space bounding box. For static assets we re-centre on the
  // origin (XZ centred, Y resting on 0) so position/scale sliders behave
  // intuitively. For animated assets we leave the geometry alone: the
  // delegate sets each mesh's matrix from the USD prim's absolute world
  // transform with matrixAutoUpdate=false, so subsequent SetTime+Draw frames
  // can stamp the asset far from its bind-pose bbox — any recenter shift we
  // compute then drags the animated pose off-screen.
  wrapper.updateMatrixWorld(true);
  const localBox = new THREE.Box3().setFromObject(wrapper);
  const size = new THREE.Vector3();
  localBox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  if (!isAnimated) {
    const cx = (localBox.min.x + localBox.max.x) / 2;
    const cz = (localBox.min.z + localBox.max.z) / 2;
    const minY = localBox.min.y;
    const inner = new THREE.Group();
    while (wrapper.children.length) {
      inner.add(wrapper.children[0]);
    }
    inner.position.set(-cx, -minY, -cz);
    wrapper.add(inner);
  }

  return {
    object: wrapper,
    handle,
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
export function disposeUsdz(group: THREE.Group, handle?: NeedleThreeHydraHandle): void {
  // Tear down the USD driver + virtual-filesystem entries first so the
  // loader stops trying to push frames into meshes we're about to free.
  try {
    handle?.dispose();
  } catch {
    // Disposing twice or against a stale handle is a no-op for our purposes.
  }
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
