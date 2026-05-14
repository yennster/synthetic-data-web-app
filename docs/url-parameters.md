# URL parameters

Every parameter below is a query string you can append to the app URL — e.g. `https://synthetic.jennyspeelman.dev/?env=outdoor&objects=cube,sphere`. Invalid values are dropped silently (no error, just the default). All params are best-effort and never required.

The two most common use cases:

- **Sharing a setup**: `?env=outdoor&batchCount=20&trajectory=circle&radius=4&height=2` — collaborators land in your exact scene with one click.
- **Reproducible datasets**: `?seed=42` — every random choice in batch capture and the realism post-process becomes deterministic.

Parameters are parsed once at page load. Toggling things in the sidebar afterward does **not** push to the URL — these are deep-link presets, not state sync.

---

## Scene & framing

| Param | Type | Example | What it does |
| --- | --- | --- | --- |
| `env` | enum | `?env=outdoor` | Switch backdrop. One of `studio`, `warehouse`, `whitebox`, `outdoor`. |
| `objects` | csv | `?objects=cube,sphere,phone` | Pre-spawn these object kinds. Valid kinds: `cube`, `sphere`, `phone`, `capsule`, `cylinder`, `torus`, `soda_can` (also accepts `can`). |
| `objectCount` | int 0–200 | `?objectCount=10` | Spawn N random objects. Composes with `objects=` (e.g. `?objects=phone&objectCount=10` = one phone + 9 randoms). |
| `conveyor` | bool | `?conveyor=1` | Show the conveyor belt. |
| `conveyorSpeed` | -5..5 | `?conveyorSpeed=0.7` | Belt speed in m/s. |
| `lightIntensity` | 0..10 | `?lightIntensity=1.5` | Key-light brightness. |
| `camera` | x,y,z | `?camera=4,3,6` | Orbit camera position. |
| `target` | x,y,z | `?target=0,0.5,0` | Orbit camera target. |

## Mode & app entry point

| Param | Type | Example | What it does |
| --- | --- | --- | --- |
| `mode` | enum | `?mode=detection` | Land in a specific mode. Accepts `motion` (alias `imu`, `accel`), `detection` (alias `object`, `objects`, `object-detection`), `anomaly` (alias `visual-anomaly`), `robot` (alias `robotics`), `arm`, `rover`. |
| `robot` | enum | `?robot=arm` | Robot sub-mode independent of `mode`: `arm` or `rover`. |
| `theme` | enum | `?theme=dark` | Force `dark` / `light`. Overrides the persisted preference. Applied pre-paint via the bootstrap script so there's no flash. |

## Batch capture & virtual camera

| Param | Type | Example | What it does |
| --- | --- | --- | --- |
| `batchCount` | 1–500 | `?batchCount=50` | Preset the batch slider. |
| `trajectory` | enum | `?trajectory=circle` | Camera path for batch capture. One of `random`, `circle`, `figure8`, `arc`, `spiral`, `orbit_dome`. |
| `radius` | 0.1..50 | `?radius=4` | Trajectory horizontal radius (m). |
| `height` | -20..50 | `?height=2` | Trajectory vertical amplitude (m). |
| `fov` | 10..170 | `?fov=60` | Virtual capture-camera FOV. |
| `resolution` | WxH | `?resolution=1024x768` | Capture resolution. Width × height each clamped to 32–8192. |

## Reproducibility

| Param | Type | Example | What it does |
| --- | --- | --- | --- |
| `seed` | int | `?seed=42` | Seed the global RNG via [mulberry32](https://github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32). Affects batch jitter (`randomizeCamera/Lighting/Objects`), the realism post-process, and the `objectCount` random-kind picker. **Not yet seeded**: motion-mode procedural drops, MuJoCo physics. Pair with `?batchCount=N` for byte-stable datasets. |

## Edge Impulse

| Param | Type | Example | What it does |
| --- | --- | --- | --- |
| `eiLabel` | string | `?eiLabel=normal` | Preset the upload label. |
| `eiCategory` | enum | `?eiCategory=split` | One of `training`, `testing`, `split`. |
| `eiProject` | int | `?eiProject=12345` | Pre-fill a project ID. Exposed via `URL_PRESETS.eiProject` for retrain flows; doesn't auto-select projects in the auth card yet. |
| `apiKey` | string | `?apiKey=ei_…` | Pre-fill the EI API key (existing param, kept for back-compat). |
| `category` | enum | `?category=split` | Legacy alias of `eiCategory` (existing param). |

## Realism post-process

| Param | Type | Example | What it does |
| --- | --- | --- | --- |
| `realism` | enum | `?realism=random` | One of `off`, `random`, `diffusion`. |
| `grain` | 0..1 | `?grain=0.5` | Film-grain intensity. |
| `chromatic` | 0..1 | `?chromatic=0.3` | Chromatic-aberration intensity. |
| `vignette` | 0..1 | `?vignette=0.2` | Vignette intensity. |
| `jitter` | 0..1 | `?jitter=0.5` | Color jitter intensity. |
| `jpeg` | 0..1 | `?jpeg=0.4` | JPEG round-trip artefact intensity. |

## Motion & robotics

| Param | Type | Example | What it does |
| --- | --- | --- | --- |
| `sampleRate` | 1–2000 | `?sampleRate=200` | IMU sample rate in Hz. |
| `armPose` | csv×6 | `?armPose=1.57,1.0,0.5,1.57,1.57,0.5` | Braccio home pose (M1..M6 in the published units — radians for joints 0–4, normalised gripper aperture for joint 5). |
| `roverEvent` | enum | `?roverEvent=collision` | Rover event class. One of `cruise`, `collision`, `stuck`. |

## UI chrome

| Param | Type | Example | What it does |
| --- | --- | --- | --- |
| `embed` | bool | `?embed=1` | Hide the sidebar, HUD pills, and drawer-toggle button. Designed for `<iframe>` embeds. |
| `ui` | enum | `?ui=minimal` | Sibling of `embed`: hides sidebar + drawer-toggle but keeps the HUD. |
| `gizmos` | bool | `?gizmos=0` | Hide the trajectory tube and the capture-camera handle from the live view. Captures already exclude these (separate render layer) — this just cleans up the editor view for screenshots. |

## Internal / debug

These don't appear in the user-facing UI and are subject to change.

| Param | Type | Example | What it does |
| --- | --- | --- | --- |
| `debug` | bool | `?debug=1` | FPS counter, 5 m axis helper at the origin, exposes `window.__sds_debug = { scene, camera }`. |
| `perf` | bool | `?perf=1` | Per-frame `dt` log to console at 1 Hz. |
| `camLog` | bool | `?camLog=1` | Logs orbit-camera position changes at 4 Hz (when actually moving). |
| `bypassAuth` | bool | `?bypassAuth=1` | Skip EI auth checks. Useful for offline UI testing. |
| `autoUpload` | bool | `?autoUpload=1` | Auto-upload after a batch finishes. Pair with `?seed=` + `?batchCount=` + `?apiKey=` for "regenerate dataset on every page load." |
| `clearStore` | bool | `?clearStore=1` | Wipe `localStorage` and `IndexedDB` before any state rehydrates. Runs from the bootstrap script in `index.html`, so even the persist middleware sees a clean slate. |
| `studioHost` | host | `?studioHost=staging-studio.example.com` | Override the Edge Impulse Studio API base. Accepts a bare host (defaults to https://) or a fully-qualified URL (`http://localhost:4800` is kept as-is for local backends). |
| `ingestionHost` | host | `?ingestionHost=staging-ingestion.example.com` | Same idea for the ingestion API. |

## Recipes

A few useful URL combinations:

**Documentation hero — a clean outdoor demo with three primitives**
```
?env=outdoor&objects=cube,sphere,phone&embed=1&theme=light
```

**Reproducible dataset — same 50 images on every page load, uploaded automatically**
```
?env=warehouse&objectCount=15&batchCount=50&trajectory=circle&radius=4&height=2&seed=42&autoUpload=1&apiKey=ei_…
```

**Debug a slow frame**
```
?debug=1&perf=1&camLog=1
```

**Reset everything for a support session**
```
?clearStore=1
```

**Iframe-friendly embed showing the live scene only**
```
?embed=1&gizmos=0&env=studio
```

**Robotics deep link straight to the Braccio with a custom home pose**
```
?mode=arm&armPose=1.57,1.0,0.5,1.57,1.57,0.5
```

---

## How parameters compose

- Parsing is single-pass: invalid values are dropped, valid values land on the store.
- Conflicting flags (e.g. `embed=1` + `ui=default`) follow whichever is more restrictive — `embed=1` always wins because it short-circuits the sidebar render entirely.
- Order in the URL doesn't matter.
- All params are case-sensitive **keys** (e.g. `cameraTrajectory` isn't a thing; the key is `trajectory`); enum **values** are lowercase-normalised.

If something doesn't behave as expected, open the browser console with `?debug=1` — `window.__sds_debug` exposes the live `scene` and `camera`, and the urlParams module logs nothing (so you'll need to inspect `URL_FLAGS` / `URL_PRESETS` from the source if you're poking around).
