# URL parameters

Every parameter below is a query string you can append to the app URL — e.g. `https://synthetic.jennyspeelman.dev/?env=outdoor&objects=cube,sphere`. Invalid values are dropped silently. All params are best-effort and never required. Param **keys** are case-sensitive; enum **values** are case-insensitive.

The two most common use cases:

- **Sharing a setup** — `?env=outdoor&batchCount=20&trajectory=circle&radius=4&height=2`
- **Reproducible datasets** — `?seed=42` makes every random choice in batch capture + realism deterministic.

Parameters are parsed once at page load. Sidebar toggles afterward don't push to the URL — these are deep-link presets, not state sync.

## Conventions

- **`bool`** — accepts `1` / `true` / `yes` / `on` for true and `0` / `false` / `no` / `off` for false. Anything else is treated as the default.
- **`int`** / **`float`** — standard decimal numbers. Out-of-range values are rejected silently.
- **Comma-separated list** — values separated by commas (no spaces needed). Unknown items are dropped; the rest still apply.
- **`enum`** — one of the values listed in the row (any case).

## Scene & framing

| Param | Allowed values | Example | What it does |
| --- | --- | --- | --- |
| `env` | `studio` · `warehouse` · `whitebox` · `outdoor` | `?env=outdoor` | Switch backdrop. |
| `objects` | comma-separated list of `cube` · `sphere` · `phone` · `capsule` · `cylinder` · `torus` · `soda_can` (alias `can`) | `?objects=cube,sphere,phone` | Pre-spawn these object kinds. Unknown kinds dropped. |
| `objectCount` | int 0–200 | `?objectCount=10` | Spawn N random objects. Composes with `objects=`. |
| `conveyor` | bool | `?conveyor=1` | Show the conveyor belt. |
| `conveyorSpeed` | float -5 to 5 (m/s) | `?conveyorSpeed=0.7` | Belt speed. |
| `lightIntensity` | float 0 to 10 | `?lightIntensity=1.5` | Key-light brightness. |
| `camera` | `x,y,z` floats | `?camera=4,3,6` | Virtual capture-camera position. |
| `target` | `x,y,z` floats | `?target=0,0.5,0` | Virtual capture-camera look-at point; non-random batch trajectories orbit this point. |

## Mode

Every mode alias resolves to one of four canonical modes:

| Canonical mode | Accepted as |
| --- | --- |
| `motion` | `motion` · `imu` · `accel` |
| `detection` | `detection` · `object` · `objects` · `object-detection` · `objectdetection` |
| `anomaly` | `anomaly` · `visual-anomaly` |
| `robot` | `robot` · `robotics` |
| `robot` + `arm` sub-mode | `arm` |
| `robot` + `rover` sub-mode | `rover` |

| Param | Allowed values | Example | What it does |
| --- | --- | --- | --- |
| `mode` | any mode alias above | `?mode=objectdetection` | Land in a specific mode. |
| `robot` | `arm` · `rover` | `?robot=arm` | Robotics sub-mode (independent of `mode`). |
| `theme` | `dark` · `light` | `?theme=light` | Force the chrome theme. Applied pre-paint so there's no flash. |
| `onlyMode` | comma-separated list of mode aliases | `?onlyMode=detection` | Hide every Mode-picker button except the listed mode(s). Auto-snaps to the first allowed mode if the user's persisted mode isn't in the set. |

## Batch capture & virtual camera

| Param | Allowed values | Example | What it does |
| --- | --- | --- | --- |
| `trajectory` | `random` · `circle` · `figure8` · `arc` · `spiral` · `orbit_dome` | `?trajectory=circle` | Camera path for batch capture (each trajectory sampled at `batchCount`). |
| `radius` | float 0.1 to 50 (m) | `?radius=4` | Trajectory horizontal radius. |
| `height` | float -20 to 50 (m) | `?height=2` | Trajectory vertical amplitude. |
| `batchCount` | int 1–500 | `?batchCount=50` | Preset the batch slider. |
| `fov` | int 10–170 (deg) | `?fov=60` | Virtual capture-camera FOV. |
| `resolution` | `WxH` or `W×H`, each 32–8192 | `?resolution=1024x768` | Capture resolution. |

The trajectory paths:

| Value | Path |
| --- | --- |
| `random` | Legacy jitter around the base pose |
| `circle` | Horizontal ring at constant height |
| `figure8` | Lemniscate (figure-eight) at constant height |
| `arc` | 180° front-facing sweep |
| `spiral` | Ascending helix |
| `orbit_dome` | Hemisphere dome (azimuth × polar) |

## Reproducibility

| Param | Allowed values | Example | What it does |
| --- | --- | --- | --- |
| `seed` | int | `?seed=42` | Seed the global RNG via [mulberry32](https://github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32). Affects batch jitter (`randomizeCamera/Lighting/Objects`), the realism post-process, and `objectCount` random-kind picking. **Not seeded yet:** motion-mode procedural drops, MuJoCo physics. |

## Edge Impulse

| Param | Allowed values | Example | What it does |
| --- | --- | --- | --- |
| `eiLabel` | string | `?eiLabel=normal` | Preset the upload label. |
| `eiCategory` | `training` (alias `train`) · `testing` (alias `test`) · `split` | `?eiCategory=split` | Upload bucket. `split` rolls 80/20 per sample. |
| `eiProject` | int ≥ 1 | `?eiProject=12345` | Pre-fill a project ID. Exposed via `URL_PRESETS.eiProject`. |
| `apiKey` | EI API key (`ei_…`) | `?apiKey=ei_…` | Pre-fill the EI API key. |
| `category` | same as `eiCategory` | `?category=split` | Legacy alias of `eiCategory`. |

## Realism post-process

| Param | Allowed values | Example | What it does |
| --- | --- | --- | --- |
| `realism` | `off` · `random` · `diffusion` | `?realism=random` | Post-process mode. `random` applies grain/CA/vignette/jitter/JPEG; `diffusion` is reserved for the server-side img2img path. |
| `grain` | float 0..1 | `?grain=0.5` | Film-grain intensity. |
| `chromatic` | float 0..1 | `?chromatic=0.3` | Chromatic-aberration intensity. |
| `vignette` | float 0..1 | `?vignette=0.2` | Vignette intensity. |
| `jitter` | float 0..1 | `?jitter=0.5` | Color-jitter intensity. |
| `jpeg` | float 0..1 | `?jpeg=0.4` | JPEG round-trip artefact intensity. |

## Motion & robotics

| Param | Allowed values | Example | What it does |
| --- | --- | --- | --- |
| `sampleRate` | int 1–2000 (Hz) | `?sampleRate=200` | IMU sample rate. |
| `armPose` | 6 comma-separated floats | `?armPose=1.57,1.0,0.5,1.57,1.57,0.5` | Braccio home pose. M1–M4 + wrist roll in radians, gripper aperture normalised to [0, 1]. |
| `roverEvent` | `cruise` · `collision` · `stuck` | `?roverEvent=collision` | Rover event class label for the next batch. |

## UI chrome

| Param | Allowed values | Example | What it does |
| --- | --- | --- | --- |
| `embed` | bool | `?embed=1` | Hide the sidebar, HUD pills, and drawer-toggle button. Designed for `<iframe>` embeds. Strictest of the three chrome-hiding flags. |
| `ui` | `default` · `minimal` | `?ui=minimal` | Hides sidebar + drawer toggle, keeps HUD. |
| `gizmos` | bool | `?gizmos=0` | Hide the trajectory tube, pink orbit-center marker, and capture-camera handle from the live view. Captures already exclude these (separate render layer). |

## Internal / debug

These don't appear in the user-facing UI and are subject to change.

| Param | Allowed values | Example | What it does |
| --- | --- | --- | --- |
| `debug` | bool | `?debug=1` | FPS counter, 5 m axis helper at the origin, exposes `window.__sds_debug = { scene, camera }`. |
| `perf` | bool | `?perf=1` | Per-frame `dt` log to console at 1 Hz. |
| `camLog` | bool | `?camLog=1` | Logs orbit-camera position changes at 4 Hz when actually moving. |
| `bypassAuth` | bool | `?bypassAuth=1` | Skip EI auth checks. Offline UI testing. |
| `autoUpload` | bool | `?autoUpload=1` | Auto-upload after a batch finishes. Pair with `?seed=` + `?batchCount=` + `?apiKey=` for "regenerate dataset on every page load." |
| `clearStore` | bool | `?clearStore=1` | Wipe `localStorage` and `IndexedDB` before any state rehydrates. Runs from the bootstrap script in `index.html`, so even the persist middleware sees a clean slate. |
| `studioHost` | host or URL | `?studioHost=staging-studio.example.com` | Override the Edge Impulse Studio API base. Bare host defaults to https://; `http://localhost:4800` is kept as-is for local backends. |
| `ingestionHost` | host or URL | `?ingestionHost=staging-ingestion.example.com` | Same idea for the ingestion API. |

## Recipes

**Documentation hero — a clean outdoor demo with three primitives**
```
https://synthetic.jennyspeelman.dev/?env=outdoor&objects=cube,sphere,phone&embed=1&theme=light
```

**Reproducible dataset — same 50 images on every page load, uploaded automatically**
```
https://synthetic.jennyspeelman.dev/?env=warehouse&objectCount=15&batchCount=50&trajectory=circle&radius=4&height=2&seed=42&autoUpload=1&apiKey=ei_…
```

**Debug a slow frame**
```
https://synthetic.jennyspeelman.dev/?debug=1&perf=1&camLog=1
```

**Reset everything for a support session**
```
https://synthetic.jennyspeelman.dev/?clearStore=1
```

**Iframe-friendly embed showing the live scene only**
```
https://synthetic.jennyspeelman.dev/?embed=1&gizmos=0&env=studio
```

**Single-purpose demo locked to Object-detection**
```
https://synthetic.jennyspeelman.dev/?onlyMode=objectdetection&env=outdoor&objects=cube,sphere&objectCount=10
```

**Robotics deep link straight to the Braccio with a custom home pose**
```
https://synthetic.jennyspeelman.dev/?mode=arm&armPose=1.57,1.0,0.5,1.57,1.57,0.5
```

## How parameters compose

- Parsing is single-pass: invalid values are dropped, valid values land on the store.
- Order in the URL doesn't matter.
- Enum **values** are lowercase-normalised before lookup (so `?env=OUTDOOR` works).
- Param **keys** are case-sensitive — `?cameraTrajectory=` won't match; use `?trajectory=`.
- Conflicting flags (e.g. `embed=1` + `ui=default`) follow whichever is more restrictive — `embed=1` always wins because it short-circuits the sidebar render entirely.
- When `?onlyMode=` excludes the user's current/persisted mode, the app auto-snaps to the first allowed mode so the highlight stays visible.

If something doesn't behave as expected, open the browser console with `?debug=1` — `window.__sds_debug` exposes the live `scene` and `camera`. You can also inspect the parsed singletons by importing `URL_FLAGS` / `URL_PRESETS` from `src/lib/urlParams.ts` in the Vite dev console.
