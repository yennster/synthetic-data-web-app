# Defensive security headers (paused)

The strict defensive response-header stack — CSP, Permissions-Policy,
X-Content-Type-Options, Referrer-Policy — has been removed from
`vercel.json` and `bin/serve.mjs` and parked here. They're intact and
re-attachable; we paused them because iframe embedability kept fighting
with them.

**What stayed in production:** `Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: credentialless`, and `Cross-Origin-Resource-Policy: cross-origin`. Those are **not** defensive overlays — they're
functional requirements: the OpenUSD WASM that powers USDZ import uses
`SharedArrayBuffer`, which only works under cross-origin isolation. Removing
them broke USDZ import. They stay.

## What's in this folder

- `vercel-headers.json` — the headers block that used to live in
  `vercel.json`. Paste back into the file's `headers` array (alongside
  the still-active COOP/COEP/CORP block) to re-enable.
- `serve-headers.mjs` — the SECURITY_HEADERS block that used to live in
  `bin/serve.mjs`. Re-import by pasting it back in and spreading into
  the two `res.writeHead` calls.
- `csp.test.ts` — the vitest suite that asserted every external host the
  app fetches is allow-listed in CSP, that `vercel.json` and
  `bin/serve.mjs` ship the same CSP, and that Permissions-Policy isn't
  `camera=(self)`. Move back to `src/lib/csp.test.ts` when CSP comes
  back.
- `_headers`, `vite-headers.ts` — old copies of the Netlify/dev-server
  headers from when COOP/COEP were also paused. Kept for reference; the
  active versions are now the ones at `public/_headers` and
  `vite.config.ts`.

## Why we paused them

1. **Iframe friction.** The `?embed=1` flow needs `frame-ancestors *`
   plus `camera=*` (not `camera=(self)`), plus `autoplay=*` so the
   webcam `<video>.play()` doesn't get rejected in cross-origin iframes,
   plus `fullscreen=*` for the 3D canvas. Each new embedder use case
   nibbled at the policy.
2. **CSP drift across surfaces.** The CSP was duplicated in
   `vercel.json` (production) and `bin/serve.mjs` (npm-installed
   self-host). When `vercel.json` got a new allowlist entry,
   `bin/serve.mjs` was easy to forget. The original security-hardening
   regression that motivated this whole arc was exactly this drift.
3. **CSP friction with external CDNs.** Every dependency (drei HDR,
   MediaPipe WASM, MediaPipe model) needed an allowlist entry. Adding
   one was easy to forget; landing one in the wrong directive (`script-src`
   vs `connect-src`) was easy to miss.

We'd rather ship working iframes than ship half-hardened-but-fragile
production. When we revisit, the path forward is:

- Single source of truth for the CSP: generate `bin/serve.mjs`'s header
  block from `vercel.json` (or vice versa) at build time.
- Land `csp.test.ts` again with that single source asserted.
- Start the Permissions-Policy at `camera=*, autoplay=*, fullscreen=*,
  microphone=(), geolocation=()` (the iframe-friendly version), not at
  the over-restrictive `camera=(self)` we shipped first.

## What's still in place

- **COOP `same-origin` + COEP `credentialless` + CORP `cross-origin`** —
  required for USDZ import (SharedArrayBuffer). Not security overlays;
  removing them broke functionality.
- **Cache-Control for `/assets/(.*)`** — pure performance, never
  security. Stays in `vercel.json`.
- **Vercel edge defaults** — DDoS protection, HTTPS, HSTS. Out of our
  control, unchanged.

## Trade-offs while the defensive block is off

- **No CSP** — XSS surface goes from "narrow allow-list" to "browser
  default". For a single-tenant tool where the user supplies their own
  API key via URL params, the practical risk is low; for any future
  shared-state or multi-tenant scenario, this needs to come back first.
- **No Permissions-Policy** — features default to `self`. Iframe parents
  can still delegate webcam to us via `<iframe allow="camera">` (browser
  default behaviour kicks in when no header is set), which matches what
  most embedders expect.
- **No X-Content-Type-Options / Referrer-Policy** — minor info-leakage
  vectors are unmitigated. Vercel sets sensible defaults at the edge
  anyway.

## Iframe embedder requirements (still valid)

A parent that wants the full feature set should embed like this:

```html
<iframe
  src="https://synthetic.jennyspeelman.dev/"
  allow="camera; autoplay; fullscreen"
  width="800"
  height="600">
</iframe>
```

For USDZ import in the iframe, the parent must also set
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: credentialless` (or `require-corp`) on its
own document — otherwise the iframe loses cross-origin isolation and
SharedArrayBuffer becomes unavailable, breaking the OpenUSD WASM worker.
