/**
 * Lazy loader for the MuJoCo WebAssembly module. The package is ~5 MB
 * gzipped (mostly the WASM binary), so we don't want it in the initial
 * bundle — the dynamic `import()` here lets Vite split it into its own
 * chunk that only downloads when robotics mode actually mounts.
 *
 * The module is a singleton: every consumer awaits the same Promise.
 * Emscripten-built modules carry significant heap state, and a second
 * instantiation would be both wasteful and a potential source of
 * cross-talk between unrelated simulations.
 */

import type loadMujoco from '@mujoco/mujoco';
// Vite-resolved URL for the WASM binary. The `?url` suffix tells Vite to
// emit the file as an asset and give us back its served URL — without
// this, the Emscripten loader's default `new URL('mujoco.wasm',
// import.meta.url)` resolves to a path Vite's middleware doesn't
// recognize as an asset, and the dev server falls back to the SPA
// `index.html`. We hand the resolved URL to the loader's `locateFile`
// hook so the WASM is fetched from the right place.
import wasmUrl from '@mujoco/mujoco/mujoco.wasm?url';

export type MujocoModule = Awaited<ReturnType<typeof loadMujoco>>;

let pending: Promise<MujocoModule> | null = null;

export function loadMujocoModule(): Promise<MujocoModule> {
  if (!pending) {
    pending = import('@mujoco/mujoco').then((mod) =>
      mod.default({
        locateFile: (path: string) =>
          path.endsWith('.wasm') ? wasmUrl : path,
      } as Parameters<typeof mod.default>[0]),
    );
  }
  return pending;
}
