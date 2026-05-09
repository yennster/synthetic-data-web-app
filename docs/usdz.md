# USDZ import

The app uses [`@needle-tools/usd`](https://www.npmjs.com/package/@needle-tools/usd), a WASM build of Pixar / Autodesk's OpenUSD with a three.js Hydra render delegate, and supports the formats most production tools emit:

- ✅ `.usdz` containing **ASCII USD** (`.usda`) — exported by Blender's "USD" exporter, Maya, Houdini.
- ✅ `.usdz` containing **binary Crate USD** (`.usdc`) — what NVIDIA Omniverse, Reality Composer, and Apple's tools produce by default. *This is what most modern `.usdz` files are.*
- ✅ **Animated USD with `UsdSkel` rigs** — Apple's animated AR Quick Look samples (hummingbird, drummer, chameleon, robot, etc.) play their baked skeletal animation in-browser. Each animated asset shows a play/pause toggle in the import panel.
- ⚠️ Plain `.usd`, `.usda`, `.usdc` files (not zipped) — convert to `.usdz` first (see below).

## Capturing real-world objects as USDZ

The **Capture from real life** card (in the Detection / Anomaly / Robotics sidebars) routes you to Apple's [RealityKit Object Capture]
(https://developer.apple.com/documentation/realitykit/realitykit-object-capture) pipeline — the studio detects whether you're on iOS 17+ or macOS 12+ and tailors the instructions accordingly. Object Capture is native-only (no JavaScript API), so the workflow is:

1. **On iPhone (iOS 17+)**: install [RealityScan](https://apps.apple.com/us/app/realityscan-mobile/id1584832280) (Epic Games, free, built on Object Capture). Walk around the object taking ~50–200 overlapping photos under even lighting (avoid shiny / transparent / featureless surfaces). Export as `.usdz`.
2. **On Mac (macOS 12+)**: run Apple's [`HelloPhotogrammetry`](https://developer.apple.com/documentation/realitykit/creating-a-photogrammetry-command-line-app) command-line sample on a folder of photos to produce a USDZ headlessly.
3. AirDrop / copy the resulting `.usdz` over and drop it into the **Import (.usdz)** card. From there it has scale / position / yaw / label / physics controls just like any other imported asset.

## Converting `.usd` / `.usda` / `.usdc` to `.usdz`

If you have a non-zipped USD file, you can package it with the OpenUSD CLI tools:

```bash
# Install: pip install usd-core
usdzip my_scene.usdz my_scene.usda
```

Or in Blender: **File → Export → Universal Scene Description (.usd)**, then choose `.usdz` as the extension.

Or via NVIDIA Omniverse: **File → Save As → .usdz**.

## Asset shows up flat magenta / pink

That's three.js's "no material bound" placeholder. The most common cause is **Omniverse MDL materials**: if the asset was authored in Omniverse and exported with its native MDL material network, the OpenUSD WASM runtime in the browser can't translate those materials into three.js's PBR pipeline and falls back to magenta.

Fixes, in order of effort:

1. **Tick "Override material" on the asset row.** This swaps every mesh in the imported subtree to a plain MeshStandardMaterial with a color/roughness/metalness you choose. You lose the original textures but the geometry is usable (and the bounding-box projection still works).
2. **Re-export from Omniverse using USD Preview Surface materials** instead of MDL. In Omniverse, this usually means converting MDL → UsdPreviewSurface before saving, or selecting "USD Preview Surface" as the export shader.
3. **In Blender**, just re-import the USD and re-export — Blender's USD exporter writes UsdPreviewSurface materials by default, which the WASM loader handles.

## Texture missing entirely

`usdzip` zips a `.usd` / `.usda` file together with referenced textures into a `.usdz`. If the original USD references a texture by **absolute path** or by a path that doesn't exist on disk at zip time, the texture won't be in the archive. Check by unzipping the `.usdz` (it's a regular zip): `unzip -l my_scene.usdz`. Re-export with relative texture paths or use the Override material toggle.

## Omniverse scene templates / room-scale USD references

NVIDIA's Omniverse scene templates (and most production USD layouts) heavily use **`References`** — the top-level `.usd` is a thin layout that points at separate `.usd` files for each prop / wall / fixture. `usdzip` does **not** chase those references by default, so you end up with a `.usdz` containing only the layout and missing all the geometry — which renders as nothing, or as the magenta placeholder if the layout itself has any prims.

The fix is to **flatten** the scene before zipping. Run from a shell with the OpenUSD CLI tools installed (`pip install usd-core` is enough):

```bash
usdcat --flatten room.usd --out room_flat.usda
usdzip room.usdz room_flat.usda
```

`usdcat --flatten` resolves all `References` / `Payloads` / `SubLayers` and writes a single self-contained `.usda` with everything inlined. Then `usdzip` packages that one file plus its textures.

**Caveat**: even after flattening, Omniverse scenes typically use **MDL materials**, which the OpenUSD WASM runtime can't translate. After import, the studio auto-enables the **Override material** toggle for assets where >50% of meshes are placeholder-shaded — flip it on yourself if it didn't trigger and pick a colour. The geometry will still be correct (you can see the room outlines, train detection on its layout, etc.) — just unshaded.

**Another option**: open the Omniverse asset in Blender (4.0+ has a USD importer), let Blender translate MDL → Principled BSDF → UsdPreviewSurface on export, and use Blender's USD exporter directly. The output works without flattening or material overrides.

## Import diagnostics

After every import the status bar shows what was loaded:

```
Imported room_flat.usdz: 142 meshes · 2,815,432 tris · 9.83m max · 142/142 default-material (override auto-enabled)
```

That tells you how much geometry came in, how big the asset is, and whether materials translated. If `default-material` is 0, you're getting real PBR shading.

## Cross-origin isolation requirement

The OpenUSD WASM uses `SharedArrayBuffer`, which requires the page to be served with **cross-origin isolation** headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

The Vite dev server is preconfigured to send these. If you self-host the production build, your static host needs to send them too:

- **Netlify / Cloudflare Pages** — pick up the `_headers` file shipped in the build output automatically.
- **Vercel** — uses the `vercel.json` at the repo root. The committed copy already maps both headers to every path. (Note: Vercel does **not** read `_headers`, so the `_headers` file alone won't work there.)
- **Other static hosts (Caddy, nginx, S3+CloudFront)** — set the two headers via your host's config.
