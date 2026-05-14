/**
 * Centralised URL-query-parameter handling.
 *
 * Two kinds of params:
 *
 *   - **Deep-link presets** apply state once at startup (env, objects,
 *     batch count, EI label, …). Parsed eagerly, then applied via the
 *     zustand store in `applyUrlParams()`.
 *
 *   - **Persistent flags** stay readable for the lifetime of the page:
 *     `embed`, `ui=minimal`, `gizmos=0`, `debug`, etc. Read via the
 *     `URL_FLAGS` export — components branch on these to hide chrome,
 *     short-circuit auth checks, log timing, etc.
 *
 * The whole file runs in the browser only — all `window.location`
 * access is guarded so SSR / Node tests don't blow up.
 *
 * See `docs/url-parameters.md` for the user-facing reference.
 */

import type {
  AppMode,
  CameraTrajectory,
  EnvPreset,
  ObjectKind,
  RealismMode,
  RoverEvent,
} from '../store/useStore';
import type { Theme } from './useTheme';

const VALID_ENV_PRESETS: ReadonlySet<EnvPreset> = new Set([
  'studio',
  'warehouse',
  'whitebox',
  'outdoor',
]);

const VALID_OBJECT_KINDS: ReadonlySet<ObjectKind> = new Set([
  'cube',
  'sphere',
  'phone',
  'capsule',
  'cylinder',
  'torus',
  'soda_can',
]);

const VALID_TRAJECTORIES: ReadonlySet<CameraTrajectory> = new Set([
  'random',
  'circle',
  'figure8',
  'arc',
  'spiral',
  'orbit_dome',
]);

const VALID_REALISM_MODES: ReadonlySet<RealismMode> = new Set([
  'off',
  'random',
  'diffusion',
]);

const VALID_ROVER_EVENTS: ReadonlySet<RoverEvent> = new Set([
  'cruise',
  'collision',
  'stuck',
]);

const VALID_EI_CATEGORIES: ReadonlySet<'training' | 'testing' | 'split'> =
  new Set(['training', 'testing', 'split']);

/** Boolean-ish param parser. Accepts `1`, `0`, `true`, `false`, `yes`, `no`. */
function parseBool(raw: string | null): boolean | undefined {
  if (raw == null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return undefined;
}

function parseNumber(
  raw: string | null,
  bounds: { min?: number; max?: number } = {},
): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  if (bounds.min != null && n < bounds.min) return undefined;
  if (bounds.max != null && n > bounds.max) return undefined;
  return n;
}

function parseInteger(
  raw: string | null,
  bounds: { min?: number; max?: number } = {},
): number | undefined {
  const n = parseNumber(raw, bounds);
  return n == null ? undefined : Math.round(n);
}

function parseTuple3(raw: string | null): [number, number, number] | undefined {
  if (raw == null) return undefined;
  const tokens = raw.split(',').map((s) => s.trim());
  // Reject empty components — `Number('')` is 0, which would silently
  // accept malformed input like `target=,,`.
  if (tokens.length !== 3 || tokens.some((t) => t === '')) return undefined;
  const parts = tokens.map((s) => Number(s));
  if (parts.some((p) => !Number.isFinite(p))) return undefined;
  return [parts[0], parts[1], parts[2]];
}

/** Parse `WIDTHxHEIGHT` (e.g. `1024x768`). */
function parseResolution(
  raw: string | null,
): { width: number; height: number } | undefined {
  if (raw == null) return undefined;
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(raw.trim());
  if (!m) return undefined;
  const w = parseInt(m[1], 10);
  const h = parseInt(m[2], 10);
  if (!(w >= 32 && w <= 8192 && h >= 32 && h <= 8192)) return undefined;
  return { width: w, height: h };
}

/** Parse a six-component arm pose like `1.57,1.0,0.5,1.57,1.57,0.5`. */
function parseArmPose(
  raw: string | null,
): [number, number, number, number, number, number] | undefined {
  if (raw == null) return undefined;
  const tokens = raw.split(',').map((s) => s.trim());
  if (tokens.length !== 6 || tokens.some((t) => t === '')) return undefined;
  const parts = tokens.map((s) => Number(s));
  if (parts.some((p) => !Number.isFinite(p))) return undefined;
  return [parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]];
}

/** Parse a comma-separated object kinds list like `cube,sphere,phone`. */
function parseObjectKindsList(raw: string | null): ObjectKind[] | undefined {
  if (raw == null) return undefined;
  const items = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => (s === 'can' ? 'soda_can' : s));
  const out: ObjectKind[] = [];
  for (const item of items) {
    if (VALID_OBJECT_KINDS.has(item as ObjectKind)) {
      out.push(item as ObjectKind);
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Shape of every preset value we may extract from the URL. */
export type UrlPresets = {
  env?: EnvPreset;
  objects?: ObjectKind[];
  objectCount?: number;
  theme?: Theme;
  seed?: number;
  batchCount?: number;
  trajectory?: CameraTrajectory;
  trajectoryRadius?: number;
  trajectoryHeight?: number;
  fov?: number;
  resolution?: { width: number; height: number };
  camPos?: [number, number, number];
  camTarget?: [number, number, number];
  conveyor?: boolean;
  conveyorSpeed?: number;
  lightIntensity?: number;
  eiLabel?: string;
  eiCategory?: 'training' | 'testing' | 'split';
  eiProject?: number;
  realismMode?: RealismMode;
  realism?: {
    grain?: number;
    chromatic?: number;
    vignette?: number;
    jitter?: number;
    jpeg?: number;
  };
  armPose?: [number, number, number, number, number, number];
  roverEvent?: RoverEvent;
  sampleRate?: number;
  mode?: AppMode;
  /** Robot sub-mode (`rover` / `arm`). Independent of `mode` so users can
   * deep-link to e.g. arm mode directly. */
  robotKind?: 'rover' | 'arm';
  /** Hide the Mode-picker buttons for any mode NOT in this list. The
   * user can still switch programmatically via `setMode`, but the
   * sidebar UI is locked down to the listed modes. Useful for
   * single-purpose deep links / iframe embeds (`?onlyMode=detection`
   * shows only Object-detection; `?onlyMode=motion,robot` shows two).
   * Empty / undefined keeps all modes visible (the default). */
  onlyMode?: AppMode[];
};

/** Flags that persist for the page lifetime — read by components. */
export type UrlFlags = {
  embed: boolean;
  /** `'minimal'` hides the sidebar; future values may hide more chrome. */
  ui: 'default' | 'minimal';
  /** Show editor gizmos (trajectory tube + capture-cam icon). `false` =
   * scrub them from the live view; captures are unaffected since
   * gizmos already live on a separate render layer. */
  gizmos: boolean;
  /** Show FPS counter + axis helper + expose extra console handles. */
  debug: boolean;
  /** Log per-frame timing breakdowns to the console. */
  perf: boolean;
  /** Log every camera-state mutation. */
  camLog: boolean;
  /** Skip EI auth checks (lets UI run offline against fake project IDs). */
  bypassAuth: boolean;
  /** Kick off upload automatically when a batch finishes. */
  autoUpload: boolean;
  /** Wipe localStorage + IndexedDB before any state rehydrates. */
  clearStore: boolean;
};

const DEFAULT_FLAGS: UrlFlags = {
  embed: false,
  ui: 'default',
  gizmos: true,
  debug: false,
  perf: false,
  camLog: false,
  bypassAuth: false,
  autoUpload: false,
  clearStore: false,
};

/**
 * Parse `URLSearchParams` into `{ presets, flags }`. Pure function — no
 * side effects, safe to unit-test against synthetic inputs.
 */
export function parseUrlParams(params: URLSearchParams): {
  presets: UrlPresets;
  flags: UrlFlags;
} {
  const flags: UrlFlags = { ...DEFAULT_FLAGS };

  const setFlag = <K extends keyof UrlFlags>(key: K, raw: string | null) => {
    const b = parseBool(raw);
    if (b !== undefined) flags[key] = b as UrlFlags[K];
  };
  setFlag('embed', params.get('embed'));
  setFlag('debug', params.get('debug'));
  setFlag('perf', params.get('perf'));
  setFlag('camLog', params.get('camLog'));
  setFlag('bypassAuth', params.get('bypassAuth'));
  setFlag('autoUpload', params.get('autoUpload'));
  setFlag('clearStore', params.get('clearStore'));

  // Gizmos: only `0` / `false` etc. flips off the default `true`.
  const gizmosRaw = parseBool(params.get('gizmos'));
  if (gizmosRaw === false) flags.gizmos = false;

  const uiRaw = params.get('ui')?.trim().toLowerCase();
  if (uiRaw === 'minimal') flags.ui = 'minimal';

  const presets: UrlPresets = {};

  // Scene presets ------------------------------------------------
  const envRaw = params.get('env')?.trim().toLowerCase();
  if (envRaw && VALID_ENV_PRESETS.has(envRaw as EnvPreset)) {
    presets.env = envRaw as EnvPreset;
  }

  const objectsList = parseObjectKindsList(params.get('objects'));
  if (objectsList) presets.objects = objectsList;

  const objectCount = parseInteger(params.get('objectCount'), {
    min: 0,
    max: 200,
  });
  if (objectCount !== undefined) presets.objectCount = objectCount;

  const themeRaw = params.get('theme')?.trim().toLowerCase();
  if (themeRaw === 'dark' || themeRaw === 'light') presets.theme = themeRaw;

  const seed = parseInteger(params.get('seed'));
  if (seed !== undefined) presets.seed = seed;

  const batchCount = parseInteger(params.get('batchCount'), {
    min: 1,
    max: 500,
  });
  if (batchCount !== undefined) presets.batchCount = batchCount;

  const trajectoryRaw = params.get('trajectory')?.trim().toLowerCase();
  if (trajectoryRaw && VALID_TRAJECTORIES.has(trajectoryRaw as CameraTrajectory)) {
    presets.trajectory = trajectoryRaw as CameraTrajectory;
  }
  const trajectoryRadius = parseNumber(params.get('radius'), {
    min: 0.1,
    max: 50,
  });
  if (trajectoryRadius !== undefined) presets.trajectoryRadius = trajectoryRadius;
  const trajectoryHeight = parseNumber(params.get('height'), {
    min: -20,
    max: 50,
  });
  if (trajectoryHeight !== undefined) presets.trajectoryHeight = trajectoryHeight;

  const fov = parseNumber(params.get('fov'), { min: 10, max: 170 });
  if (fov !== undefined) presets.fov = fov;

  const resolution = parseResolution(params.get('resolution'));
  if (resolution) presets.resolution = resolution;

  const camPos = parseTuple3(params.get('camera'));
  if (camPos) presets.camPos = camPos;
  const camTarget = parseTuple3(params.get('target'));
  if (camTarget) presets.camTarget = camTarget;

  const conveyor = parseBool(params.get('conveyor'));
  if (conveyor !== undefined) presets.conveyor = conveyor;
  const conveyorSpeed = parseNumber(params.get('conveyorSpeed'), {
    min: -5,
    max: 5,
  });
  if (conveyorSpeed !== undefined) presets.conveyorSpeed = conveyorSpeed;

  const lightIntensity = parseNumber(params.get('lightIntensity'), {
    min: 0,
    max: 10,
  });
  if (lightIntensity !== undefined) presets.lightIntensity = lightIntensity;

  // Edge Impulse presets -----------------------------------------
  const eiLabel = params.get('eiLabel')?.trim();
  if (eiLabel) presets.eiLabel = eiLabel;

  const eiCategoryRaw = params.get('eiCategory')?.trim().toLowerCase();
  if (eiCategoryRaw && VALID_EI_CATEGORIES.has(eiCategoryRaw as 'training')) {
    presets.eiCategory = eiCategoryRaw as 'training' | 'testing' | 'split';
  }

  const eiProject = parseInteger(params.get('eiProject'), { min: 1 });
  if (eiProject !== undefined) presets.eiProject = eiProject;

  // Realism presets ----------------------------------------------
  const realismRaw = params.get('realism')?.trim().toLowerCase();
  if (realismRaw && VALID_REALISM_MODES.has(realismRaw as RealismMode)) {
    presets.realismMode = realismRaw as RealismMode;
  }
  const realism: NonNullable<UrlPresets['realism']> = {};
  const intensity01 = (raw: string | null) =>
    parseNumber(raw, { min: 0, max: 1 });
  const grain = intensity01(params.get('grain'));
  if (grain !== undefined) realism.grain = grain;
  const chromatic = intensity01(params.get('chromatic'));
  if (chromatic !== undefined) realism.chromatic = chromatic;
  const vignette = intensity01(params.get('vignette'));
  if (vignette !== undefined) realism.vignette = vignette;
  const jitter = intensity01(params.get('jitter'));
  if (jitter !== undefined) realism.jitter = jitter;
  const jpeg = intensity01(params.get('jpeg'));
  if (jpeg !== undefined) realism.jpeg = jpeg;
  if (Object.keys(realism).length > 0) presets.realism = realism;

  // Robotics presets ---------------------------------------------
  const armPose = parseArmPose(params.get('armPose'));
  if (armPose) presets.armPose = armPose;
  const roverEventRaw = params.get('roverEvent')?.trim().toLowerCase();
  if (roverEventRaw && VALID_ROVER_EVENTS.has(roverEventRaw as RoverEvent)) {
    presets.roverEvent = roverEventRaw as RoverEvent;
  }
  const sampleRate = parseInteger(params.get('sampleRate'), {
    min: 1,
    max: 2000,
  });
  if (sampleRate !== undefined) presets.sampleRate = sampleRate;

  // Mode (mirrors the pre-existing `mode` / `robot` params in App.tsx
  // so we have a single source of truth).
  const modeRaw = params.get('mode')?.trim().toLowerCase();
  switch (modeRaw) {
    case 'motion':
    case 'imu':
    case 'accel':
      presets.mode = 'motion';
      break;
    case 'detection':
    case 'object':
    case 'objects':
    case 'object-detection':
    case 'objectdetection':
      presets.mode = 'detection';
      break;
    case 'anomaly':
    case 'visual-anomaly':
      presets.mode = 'anomaly';
      break;
    case 'robot':
    case 'robotics':
      presets.mode = 'robot';
      break;
    case 'arm':
      presets.mode = 'robot';
      presets.robotKind = 'arm';
      break;
    case 'rover':
      presets.mode = 'robot';
      presets.robotKind = 'rover';
      break;
  }
  const robotRaw = params.get('robot')?.trim().toLowerCase();
  if (robotRaw === 'arm' || robotRaw === 'rover') presets.robotKind = robotRaw;

  // ?onlyMode= — comma-separated list of modes that should remain
  // visible in the Mode card. Aliases ("objects", "robotics", "arm",
  // "rover") collapse to the underlying canonical mode, so deep links
  // read naturally regardless of which spelling the user picks.
  const onlyModeRaw = params.get('onlyMode');
  if (onlyModeRaw) {
    const allowed: AppMode[] = [];
    for (const raw of onlyModeRaw.split(',')) {
      const tok = raw.trim().toLowerCase();
      switch (tok) {
        case 'motion':
        case 'imu':
        case 'accel':
          allowed.push('motion');
          break;
        case 'detection':
        case 'object':
        case 'objects':
        case 'object-detection':
        case 'objectdetection':
          allowed.push('detection');
          break;
        case 'anomaly':
        case 'visual-anomaly':
          allowed.push('anomaly');
          break;
        case 'robot':
        case 'robotics':
        case 'arm':
        case 'rover':
          allowed.push('robot');
          break;
      }
    }
    // Dedupe while preserving first-seen order so e.g. `?onlyMode=detection,detection` is harmless.
    const uniq = Array.from(new Set(allowed));
    if (uniq.length > 0) presets.onlyMode = uniq;
  }

  return { presets, flags };
}

/** Singleton parsed from `window.location.search` at module load. The
 * `URL_FLAGS` export is read by components throughout the app. */
let _flags: UrlFlags = DEFAULT_FLAGS;
let _presets: UrlPresets = {};

if (typeof window !== 'undefined') {
  try {
    const parsed = parseUrlParams(
      new URLSearchParams(window.location.search),
    );
    _flags = parsed.flags;
    _presets = parsed.presets;
  } catch {
    // URLSearchParams shouldn't throw; be defensive anyway
  }
}

export const URL_FLAGS = _flags;
export const URL_PRESETS = _presets;

/** Re-parse the URL — used by tests and the `?clearStore=1` reload. */
export function refreshUrlParams(): void {
  if (typeof window === 'undefined') return;
  const parsed = parseUrlParams(new URLSearchParams(window.location.search));
  // Mutate exports in-place so existing references stay valid.
  Object.assign(_flags, DEFAULT_FLAGS, parsed.flags);
  for (const k of Object.keys(_presets)) {
    delete (_presets as Record<string, unknown>)[k];
  }
  Object.assign(_presets, parsed.presets);
}
