# URL parameters

Every parameter below is a query string you can append to the app URL — e.g. `https://synthetic.jennyspeelman.dev/?env=outdoor&objects=cube,sphere`. Invalid values are dropped silently (no error, just the default). All params are best-effort and never required. Values are **case-insensitive** for enums.

The two most common use cases:

- **Sharing a setup**: `?env=outdoor&batchCount=20&trajectory=circle&radius=4&height=2` — collaborators land in your exact scene with one click.
- **Reproducible datasets**: `?seed=42` — every random choice in batch capture and the realism post-process becomes deterministic.

Parameters are parsed once at page load. Toggling things in the sidebar afterward does **not** push to the URL — these are deep-link presets, not state sync.

---

## Boolean params

Anywhere a "bool" type appears, the following are accepted:

| Value | Means |
| --- | --- |
| `1` / `true` / `yes` / `on` | true |
| `0` / `false` / `no` / `off` | false |
| anything else | ignored (falls back to default) |

---

## Scene & framing

| Param | Type | Example | What it does |
| --- | --- | --- | --- |
| `env` | enum | `?env=outdoor` | Switch backdrop. **Allowed:** `studio`, `warehouse`, `whitebox`, `outdoor`. |
| `objects` | csv of `kind` | `?objects=cube,sphere,phone` | Pre-spawn these object kinds. **Allowed kinds:** `cube`, `sphere`, `phone`, `capsule`, `cylinder`, `torus`, `soda_can` (alias `can`). Unknown kinds dropped. |
| `objectCount` | int 0–200 | `?objectCount=10` | Spawn N random objects. Composes with `objects=` (e.g. `?objects=phone&objectCount=10` = one phone + 9 randoms). |
| `conveyor` | bool | `?conveyor=1` | Show the conveyor belt. |
| `conveyorSpeed` | -5..5 (m/s) | `?conveyorSpeed=0.7` | Belt speed. |
| `lightIntensity` | 0..10 | `?lightIntensity=1.5` | Key-light brightness. |
| `camera` | `x,y,z` floats | `?camera=4,3,6` | Orbit camera position. Three floats, comma-separated. |
| `target` | `x,y,z` floats | `?target=0,0.5,0` | Orbit camera target. Three floats, comma-separated. |

## Mode & app entry point

### `mode` — land in a specific mode

| Value (and aliases) | Resolves to |
| --- | --- |
| `motion`, `imu`, `accel` | Motion |
| `detection`, `object`, `objects`, `object-detection`, `objectdetection` | Object detection |
| `anomaly`, `visual-anomaly` | Visual anomaly |
| `robot`, `robotics` | Robotics (current `robotKind` preserved) |
| `arm` | Robotics + sub-mode = `arm` |
| `rover` | Robotics + sub-mode = `rover` |

### `robot` — robotics sub-mode (independent of `mode`)

| Value | Means |
| --- | --- |
| `arm` | Switch the Braccio arm rig on |
| `rover` | Switch the rover rig on |

### `theme` — force the chrome theme

| Value | Means |
| --- | --- |
| `dark` | Dark theme |
| `light` | Light theme |

Applied pre-paint via the bootstrap script so there's no flash.

### `onlyMode` — hide every other Mode button

`csv` accepting the same aliases as `?mode=`. Examples:

- `?onlyMode=detection` — only Object-detection visible.
- `?onlyMode=objectdetection` — same (alias).
- `?onlyMode=motion,detection` — show two.
- `?onlyMode=arm` — Robotics with arm sub-mode, single button.

If the user's persisted mode isn't in the allowed set, it snaps to the first listed mode automatically.

## Batch capture & virtual camera

### `trajectory` — camera path for batch capture

| Value | Means |
| --- | --- |
| `random` | Legacy jitter around the base pose |
| `circle` | Horizontal ring at constant height |
| `figure8` | Lemniscate (figure-eight) at constant height |
| `arc` | 180° front-facing sweep |
| `spiral` | Ascending helix |
| `orbit_dome` | Hemisphere dome (azimuth × polar) |

| Param | Type | Example | What it does |
| --- | --- | --- | --- |
| `batchCount` | int 1–500 | `?batchCount=50` | Preset the batch slider. |
| `radius` | 0.1..50 (m) | `?radius=4` | Trajectory horizontal radius. |
| `height` | -20..50 (m) | `?height=2` | Trajectory vertical amplitude. |
| `fov` | 10..170 (deg) | `?fov=60` | Virtual capture-camera FOV. |
| `resolution` | `WxH` or `W×H` | `?resolution=1024x768` | Capture resolution. Width × height each clamped to 32–8192. |

## Reproducibility

| Param | Type | Example | What it does |
| --- | --- | --- | --- |
| `seed` | int | `?seed=42` | Seed the global RNG via [mulberry32](https://github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32). Affects batch jitter (`randomizeCamera/Lighting/Objects`), the realism post-process, and the `objectCount` random-kind picker. **Not yet seeded:** motion-mode procedural drops, MuJoCo physics. Pair with `?batchCount=N` for byte-stable datasets. |

## Edge Impulse

### `eiCategory` — upload bucket (alias `category`)

| Value | Means |
| --- | --- |
| `training` (alias `train`) | All samples → training bucket |
| `testing` (alias `test`) | All samples → testing bucket |
| `split` | 80/20 client-side split per sample |

| Param | Type | Example | What it does |
| --- | --- | --- | --- |
| `eiLabel` | string | `?eiLabel=normal` | Preset the upload label. |
| `eiProject` | int ≥1 | `?eiProject=12345` | Pre-fill a project ID. Exposed via `URL_PRESETS.eiProject` for retrain flows. |
| `apiKey` | string | `?apiKey=ei_…` | Pre-fill the EI API key (existing param, kept for back-compat). |

## Realism post-process

### `realism` — post-process mode

| Value | Means |
| --- | --- |
| `off` | No post-process (the raw render) |
| `random` | Per-effect pixel transforms (grain, CA, vignette, jitter, JPEG round-trip) |
| `diffusion` | Reserved for the server-side img2img path (UI hidden in the panel) |

| Param | Type | Example | What it does |
| --- | --- | --- | --- |
| `grain` | 0..1 | `?grain=0.5` | Film-grain intensity. |
| `chromatic` | 0..1 | `?chromatic=0.3` | Chromatic-aberration intensity. |
| `vignette` | 0..1 | `?vignette=0.2` | Vignette intensity. |
| `jitter` | 0..1 | `?jitter=0.5` | Color-jitter intensity. |
| `jpeg` | 0..1 | `?jpeg=0.4` | JPEG round-trip artefact intensity. |

## Motion & robotics

### `roverEvent` — rover event class

| Value | Means |
| --- | --- |
| `cruise` | Steady straight-line driving |
| `collision` | Hits an obstacle mid-run |
| `stuck` | Wheels spin without forward motion |

| Param | Type | Example | What it does |
| --- | --- | --- | --- |
| `sampleRate` | int 1–2000 (Hz) | `?sampleRate=200` | IMU sample rate. |
| `armPose` | 6 comma-separated floats | `?armPose=1.57,1.0,0.5,1.57,1.57,0.5` | Braccio home pose. M1–M4 + wrist roll in radians, gripper aperture normalised [0, 1]. |

## UI chrome

### `ui` — chrome level

| Value | Means |
| --- | --- |
| `default` (omitted) | Full UI (sidebar, HUD, drawer toggle, gizmos) |
| `minimal` | Hides sidebar + drawer toggle, keeps HUD |

| Param | Type | Example | What it does |
| --- | --- | --- | --- |
| `embed` | bool | `?embed=1` | Hide the sidebar, HUD pills, and drawer-toggle button. Designed for `<iframe>` embeds. Strictest of the three chrome-hiding flags. |
| `gizmos` | bool | `?gizmos=0` | Hide the trajectory tube and the capture-camera handle from the live view. Captures already exclude these (separate render layer) — this just cleans up the editor view for screenshots. `1`/omitted leaves them visible. |

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

---

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

**Single-purpose demo locked to Object-detection**
```
?onlyMode=objectdetection&env=outdoor&objects=cube,sphere&objectCount=10
```

**Robotics deep link straight to the Braccio with a custom home pose**
```
?mode=arm&armPose=1.57,1.0,0.5,1.57,1.57,0.5
```

---

## How parameters compose

- Parsing is single-pass: invalid values are dropped, valid values land on the store.
- Order in the URL doesn't matter.
- Enum **values** are lowercase-normalised before lookup (so `?env=OUTDOOR` works).
- Param **keys** are case-sensitive — `?cameraTrajectory=` won't match; use `?trajectory=`.
- Bool flags follow the table at the top of this doc.
- Conflicting flags (e.g. `embed=1` + `ui=default`) follow whichever is more restrictive — `embed=1` always wins because it short-circuits the sidebar render entirely.
- When `?onlyMode=` excludes the user's current/persisted mode, the app auto-snaps to the first allowed mode so the highlight stays visible.

If something doesn't behave as expected, open the browser console with `?debug=1` — `window.__sds_debug` exposes the live `scene` and `camera`. You can also inspect the parsed singletons by importing `URL_FLAGS` / `URL_PRESETS` from `/src/lib/urlParams.ts` in the Vite dev console.
