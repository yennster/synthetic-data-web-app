# Troubleshooting

**Camera permission denied** (motion mode) — Allow camera in your browser's site settings, then reload.

**Bounding boxes look wrong** — Make sure the object is fully on-screen in the virtual camera preview. Boxes are clipped at image edges, and very small / occluded objects are dropped.

**USDZ import: "module could not initialize"** — the page isn't cross-origin-isolated. Check that your static host is sending `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`. The dev server already does. **Vercel users**: make sure `vercel.json` is at the repo root (not just `_headers` in `public/` — Vercel doesn't read that file). You can verify with `curl -I https://your-deployment.vercel.app/` and look for both headers in the response. See [docs/usdz.md](usdz.md#cross-origin-isolation-requirement) for full host setup.

**USDZ import: file imported but invisible** — the asset may have been auto-scaled too small; drag the **Scale** slider in its row, or check the **Y** position (e.g. lift it onto the belt at `y = 0.1`).

**USDZ import: asset is flat magenta** — see [docs/usdz.md](usdz.md#asset-shows-up-flat-magenta--pink).

**Edge Impulse 401 / 403** — API key missing or invalid. Double-check **Dashboard → Keys** in your project.

**Edge Impulse "invalid signature"** (motion / robotics time-series) — Either fill in the HMAC key from your project, or leave it blank to send unsigned (`alg: "none"`). HMAC signs the JSON data-acquisition envelope before it is attached to the multipart `/files` upload. Image uploads authenticate with the API key alone, so vision modes do not show an HMAC field.

**Edge Impulse metadata is missing in Studio** — Re-upload samples generated with the current app. Direct uploads attach metadata as the `x-metadata` header; downloaded time-series zips attach the same metadata in `info.labels`. If you upload individual JSON files from inside the zip without the sidecar, Studio cannot recover the metadata. In Studio, metadata is shown on the selected sample's details, not as a default column in the dataset table.

**"No WebAssembly deployment built yet"** when fetching a model — go to the Edge Impulse Studio: **Deployment → WebAssembly → Build**. Once the build completes the studio caches it and the app's Fetch & load button will work.

**Retrain says "Pick a project"** — click **🔑 List projects** in the Inference card and select the Edge Impulse project you uploaded to. If your API key only has one accessible project, the app can auto-select it for retraining.

**Model load hangs at `onRuntimeInitialized`** — use `edge-impulse-standalone.js` plus the matching `.wasm` from the WebAssembly deployment. The loader supports both MODULARIZE browser builds and newer non-MODULARIZE Emscripten outputs, but Node-only wrappers such as `run-impulse.js`, `run-classifier.js`, or `index.js` cannot run in the browser.

**Model loaded but `bounding_boxes` is empty** — your model probably isn't an object-detection model. Classification heads return `classification` only; for boxes you need a YOLO/MobileNet object detector or a FOMO model. Check the line `… · obj-det` in the loaded-model summary.

**Rover is spinning in circles or hitting obstacles** — the `cruise` trajectory requires a clear straight path. Try clicking **Reset scene** to get a new layout, or drag obstacles manually with `Shift+drag` to clear a path.

**Braccio arm "Target unreachable"** — the analytical IK solver clamps to the physical limits of the arm. If the pickup target is too far or too close, the arm will reach as far as it can. Use **Randomize pickups** or position floor pickup targets near the reachable annulus in front of the base (roughly 11–22 cm radial distance for floor pick-and-place).

**Arm pickup is marked failed** — this is intentional when the target tipped over, drifted away, or could not plausibly fit the gripper during the close / lift window. The simulator keeps the gripper from grabbing impossible targets and records the failure in metadata (`pickup_success=false`, plus a failure reason when known).

**ROS 2 export files are missing** — make sure **ROS export** is toggled ON in the Sensor modality card before starting the generator. The files are bundled into the same zip as the Edge Impulse samples. Rover exports include IMU + LaserScan JSONL; arm exports include IMU + JointState JSONL.
