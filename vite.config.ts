import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    // Required for SharedArrayBuffer (used by the OpenUSD WASM runtime in
    // three-usdz-loader). `credentialless` is more permissive than
    // `require-corp` and doesn't require external resources (like the
    // MediaPipe CDN) to set CORP headers.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision'],
  },
  resolve: {
    dedupe: ['three'],
  },
});
