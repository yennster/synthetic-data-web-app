# Troubleshooting

**Camera permission denied** (motion mode) — Allow camera in your browser's site settings, then reload.

**Bounding boxes look wrong** — Make sure the object is fully on-screen in the virtual camera preview. Boxes are clipped at image edges, and very small / occluded objects are dropped.

**USDZ import: "module could not initialize"** — the page isn't cross-origin-isolated. Check that your static host is sending `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`. The dev server already does. **Vercel users**: make sure `vercel.json` is at the repo root (not just `_headers` in `public/` — Vercel doesn't read that file). You can verify with `curl -I https://your-deployment.vercel.app/` and look for both headers in the response. See [docs/usdz.md](usdz.md#cross-origin-isolation-requirement) for full host setup.

**USDZ import: file imported but invisible** — the asset may have been auto-scaled too small; drag the **Scale** slider in its row, or check the **Y** position (e.g. lift it onto the belt at `y = 0.1`).

**USDZ import: asset is flat magenta** — see [docs/usdz.md](usdz.md#asset-shows-up-flat-magenta--pink).

**Edge Impulse 401 / 403** — API key missing or invalid. Double-check **Dashboard → Keys** in your project.

**Edge Impulse "invalid signature"** (motion only) — Either fill in the HMAC key from your project, or leave it blank to send unsigned (`alg: "none"`). HMAC is **only** for the JSON data-acquisition format used by motion uploads; image / file uploads (vision modes) authenticate with the API key alone, so there's no HMAC field there.

**"No WebAssembly deployment built yet"** when fetching a model — go to the Edge Impulse Studio: **Deployment → WebAssembly → Build**. Once the build completes the studio caches it and the app's Fetch & load button will work.

**Retrain says "Pick a project"** — click **🔑 List projects** in the Inference card and select the Edge Impulse project you uploaded to. If your API key only has one accessible project, the app can auto-select it for retraining.

**Model load hangs at `onRuntimeInitialized`** — use `edge-impulse-standalone.js` plus the matching `.wasm` from the WebAssembly deployment. The loader supports both MODULARIZE browser builds and newer non-MODULARIZE Emscripten outputs, but Node-only wrappers such as `run-impulse.js`, `run-classifier.js`, or `index.js` cannot run in the browser.

**Model loaded but `bounding_boxes` is empty** — your model probably isn't an object-detection model. Classification heads return `classification` only; for boxes you need a YOLO/MobileNet object detector or a FOMO model. Check the line `… · obj-det` in the loaded-model summary.
