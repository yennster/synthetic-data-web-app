// Paused defensive-headers block from bin/serve.mjs. To re-enable: paste
// SECURITY_HEADERS back into bin/serve.mjs (just below COI_HEADERS), and
// spread `...SECURITY_HEADERS` into the two `res.writeHead` calls
// alongside the active `...COI_HEADERS`.
//
// COOP / COEP / CORP are intentionally NOT in this file — they stayed in
// production because SharedArrayBuffer (USDZ import) needs them. They
// live in bin/serve.mjs as COI_HEADERS.
//
// See drafts/security-hardening/README.md for context.

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Iframe-friendly Permissions-Policy:
  //   camera=*      — webcam hand tracking. `camera=(self)` would block
  //                   cross-origin parents that delegate via `<iframe
  //                   allow="camera">`. The user still has to accept the
  //                   browser permission prompt.
  //   autoplay=*    — `videoRef.play()` on the webcam <video> needs the
  //                   autoplay feature in cross-origin iframes; without
  //                   it Chromium silently rejects the play() promise.
  //   fullscreen=*  — let parents delegate fullscreen for the 3D canvas
  //                   (Element.requestFullscreen) so embedders can offer
  //                   "expand" controls.
  //   microphone=() — explicitly denied (we don't use mic).
  //   geolocation=()— explicitly denied.
  'Permissions-Policy':
    'camera=*, autoplay=*, fullscreen=*, microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    // cdn.jsdelivr.net hosts the MediaPipe `tasks-vision` WASM loader
    // (script + connect) AND the drei warehouse HDR mirror (connect).
    // storage.googleapis.com hosts the hand-landmarker model bytes.
    //
    // 'unsafe-eval' — required by @mujoco/mujoco's Emscripten runtime
    // (new Function() dispatch). 'wasm-unsafe-eval' alone doesn't cover
    // JS eval.
    //
    // 'unsafe-inline' — index.html runs two pre-paint bootstrap blocks
    // (theme persistence + ?clearStore handler) that must execute before
    // any module loads.
    //
    // blob: — eiModel.ts dynamic-imports a blob URL for ESM EI models.
    "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' 'unsafe-inline' blob: https://va.vercel-scripts.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "connect-src 'self' https://*.edgeimpulse.com https://api-inference.huggingface.co https://va.vercel-scripts.com https://*.vercel-insights.com https://cdn.jsdelivr.net https://storage.googleapis.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    // `frame-ancestors *` so the documented `?embed=1` cross-origin
    // iframe mode works. Tighten to a specific allowlist if/when known.
    'frame-ancestors *',
  ].join('; '),
};

export { SECURITY_HEADERS };
