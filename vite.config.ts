/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // Honor the PORT env var so harnesses (preview tool, CI) that assign
    // a port via env can override the default without a config edit.
    port: Number(process.env.PORT) || 5173,
    // Required for SharedArrayBuffer (used by the OpenUSD WASM runtime in
    // three-usdz-loader). `credentialless` is more permissive than
    // `require-corp` and doesn't require external resources (like the
    // MediaPipe CDN) to set CORP headers. These are NOT defensive
    // overlays — they're functional requirements for USDZ import.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      // Match production (vercel.json + bin/serve.mjs). Without CORP, a
      // cross-origin parent with strict COEP can't iframe the dev build,
      // and scripts/test-iframe-embed.mjs can't validate the embed flow.
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  },
  optimizeDeps: {
    // @needle-tools/usd's bindings index uses `import("./emHdBindings.data?url")`
    // and similar `?url` imports for the WASM/worker assets. Vite handles
    // `?url` natively but esbuild (the dep pre-bundler) doesn't recognise
    // `.data` files and bails. Excluding the package lets Vite resolve
    // those URLs at runtime.
    // `@mujoco/mujoco` ships its Emscripten loader as ESM and uses
    // `new URL('mujoco.wasm', import.meta.url)` to fetch the binary
    // next to the JS. When Vite pre-bundles the package into
    // `node_modules/.vite/deps/`, the wasm sibling isn't copied along,
    // and the runtime ends up fetching the SPA fallback. Excluding
    // keeps the import resolving to the real package directory.
    exclude: ['@mediapipe/tasks-vision', '@needle-tools/usd', '@mujoco/mujoco'],
  },
  resolve: {
    dedupe: ['three'],
  },
  test: {
    // happy-dom is faster than jsdom and covers everything we need (DOM,
    // crypto.subtle is delegated to Node's WebCrypto). Tests that don't
    // touch the DOM still benefit from a stable global env.
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The OpenUSD WASM loader reads @needle-tools/usd/src/bindings/ at
    // runtime and the MediaPipe SDK touches the DOM aggressively. Both
    // fail in tests because we're not wiring up their assets — exclude
    // them.
    server: {
      deps: {
        external: ['@mediapipe/tasks-vision', '@needle-tools/usd'],
      },
    },
  },
});
