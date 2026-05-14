/**
 * Edge Impulse WebAssembly model loader.
 *
 * Targets the standard EI "WebAssembly" deployment block, which produces:
 *   - edge-impulse-standalone.js   (Emscripten module factory, MODULARIZE=1)
 *   - edge-impulse-standalone.wasm (the actual model)
 *
 * Users unzip the deployment locally and upload both files. We blob-URL the
 * .wasm, inject the .js as a classic <script> (which handles UMD/CommonJS/
 * global-Module patterns uniformly), call the factory with a `locateFile`
 * hook so it loads our blob-URL .wasm, and wrap the resulting Emscripten
 * module in a tiny classifier convenience class.
 *
 * The Embind exports we rely on:
 *   - mod.run_classifier(features: number[] | VectorFloat, debug: bool) -> Result
 *   - mod.get_properties() -> { ... }
 *   - mod.get_project()    -> JSON string with metadata
 *
 * The Result struct fields we read (all best-effort — different EI versions
 * shape these slightly differently):
 *   - bounding_boxes: vector<{label, value, x, y, width, height}>
 *   - classification: vector<{label, value}>
 *   - anomaly:        float
 *   - visual_ad_grid_cells, visual_ad_max, visual_ad_mean (visual anomaly)
 */

export type EiBoundingBox = {
  label: string;
  value: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type EiClassification = { label: string; value: number };

export type EiResult = {
  /** Object detection / FOMO output. Coordinates are in INPUT pixels (EI
   * model input dims, e.g. 96×96), origin top-left. */
  bounding_boxes: EiBoundingBox[];
  /** Per-class probabilities (classification head). */
  classification: EiClassification[];
  /** Anomaly score (k-means / GMM heads). */
  anomaly?: number;
  /** Visual anomaly heatmap cells (if present). */
  visual_ad_grid_cells?: Array<{
    label: string;
    value: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  visual_ad_max?: number;
  visual_ad_mean?: number;
};

export type EiModelInfo = {
  /** Model input width in pixels. */
  inputWidth: number;
  /** Model input height in pixels. */
  inputHeight: number;
  /** Whether to feed RGB-packed pixels (3 ch) or grayscale luma (1 ch). */
  isRgb: boolean;
  /** True for object_detection / FOMO models. */
  isObjectDetection: boolean;
  /** True if a separate anomaly head exists. */
  hasAnomaly: boolean;
  /** True for visual anomaly detection (GMM heatmap output). */
  hasVisualAnomaly: boolean;
  /** Raw model type string from the Edge Impulse build. */
  modelType: string;
  /** Class label list. May be empty if EI didn't ship them. */
  labels: string[];
};

function num(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

// --- Classifier wrapper ---------------------------------------------------

/**
 * Wraps the Edge Impulse Embind module. Mirrors the contract documented by
 * EI's own run-impulse.js test harness:
 *
 *   - Module.init() — returns 0 on success, non-zero error code otherwise.
 *   - Module.get_properties() — returns an Embind object whose getters
 *     expose `model_type`, `has_object_tracking`, `has_visual_anomaly_detection`,
 *     etc. We walk Module.emcc_classification_properties_t.prototype to copy
 *     them into a plain JS object.
 *   - Module.get_project() — same shape as properties for project metadata.
 *   - Module.run_classifier(featuresPtr, len, debug) — features must be in
 *     the wasm heap as Float32 (so we malloc + memcpy), returns a result
 *     struct with `.result` (error code), `.anomaly`, `.size()`, `.get(i)`,
 *     and (for visual anomaly) `.visual_ad_*` accessors.
 *   - Module._malloc / Module._free / Module.HEAPU8 — heap helpers.
 */
class EdgeImpulseClassifier {
  private initialized = false;
  private propsCache: Record<string, unknown> | null = null;
  constructor(private mod: any) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    if (typeof this.mod.init === 'function') {
      const ret = this.mod.init();
      if (typeof ret === 'number' && ret !== 0) {
        throw new Error(`Module.init() failed with code ${ret}`);
      }
    }
    this.initialized = true;
  }

  getProperties(): Record<string, unknown> {
    if (this.propsCache) return this.propsCache;
    if (typeof this.mod.get_properties !== 'function') return {};
    const raw = this.mod.get_properties();
    const proto = this.mod.emcc_classification_properties_t?.prototype;
    const obj = unwrapEmbindStruct(raw, proto);
    this.propsCache = obj;
    return obj;
  }

  getProject(): Record<string, unknown> {
    if (typeof this.mod.get_project !== 'function') return {};
    const raw = this.mod.get_project();
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    }
    const proto = this.mod.emcc_classification_project_t?.prototype;
    return unwrapEmbindStruct(raw, proto);
  }

  classify(features: number[]): EiResult {
    if (!this.initialized) throw new Error('Classifier not initialized');
    // Copy the JS feature array into a Float32Array, then malloc a chunk of
    // wasm heap and memcpy the bytes in. run_classifier gets the heap
    // pointer (in bytes) and the feature count (NOT byte count).
    const typed = new Float32Array(features);
    const numBytes = typed.length * Float32Array.BYTES_PER_ELEMENT;
    const ptr = this.mod._malloc(numBytes);
    try {
      const heap = new Uint8Array(this.mod.HEAPU8.buffer, ptr, numBytes);
      heap.set(new Uint8Array(typed.buffer));
      const ret = this.mod.run_classifier(ptr, typed.length, false);
      try {
        if (ret && typeof ret.result === 'number' && ret.result !== 0) {
          throw new Error(`run_classifier failed (code ${ret.result})`);
        }
        return parseResult(ret, this.getProperties());
      } finally {
        if (ret && typeof ret.delete === 'function') ret.delete();
      }
    } finally {
      this.mod._free(ptr);
    }
  }
}

/**
 * Embind classes expose their fields as getter properties on the class
 * prototype, not as own properties of each instance. To get a plain JS
 * object we walk the prototype, grab everything that has a getter, and
 * call it through the live instance. (This is exactly what EI's own
 * run-impulse.js does.)
 */
function unwrapEmbindStruct(
  embindObj: any,
  prototype: any,
): Record<string, unknown> {
  if (!embindObj) return {};
  // Fall back to own keys if the prototype isn't available.
  if (!prototype) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(embindObj)) out[k] = embindObj[k];
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(prototype)) {
    const desc = Object.getOwnPropertyDescriptor(prototype, key);
    if (desc && typeof desc.get === 'function') {
      try {
        out[key] = embindObj[key];
      } catch {
        // Some getters throw if optional fields aren't populated; skip them.
      }
    }
  }
  return out;
}

/**
 * Convert an EI run_classifier result into the shape the rest of the app
 * consumes. The result struct is an Embind vector — iterate via .size() and
 * .get(i), each entry being a per-detection or per-class struct. Visual
 * anomaly cells live on a separate `visual_ad_grid_cells_*` accessor.
 */
function parseResult(r: any, props: Record<string, unknown>): EiResult {
  const modelType = String(props.model_type ?? '');
  const isObjectDetection =
    modelType === 'object_detection' ||
    modelType === 'constrained_object_detection';
  const hasVisualAnomaly = !!props.has_visual_anomaly_detection;

  const bounding_boxes: EiResult['bounding_boxes'] = [];
  const classification: EiResult['classification'] = [];
  if (typeof r?.size === 'function') {
    const n = r.size();
    for (let i = 0; i < n; i++) {
      const c = r.get(i);
      try {
        if (isObjectDetection) {
          bounding_boxes.push({
            label: String(c.label ?? ''),
            value: num(c.value),
            x: num(c.x),
            y: num(c.y),
            width: num(c.width),
            height: num(c.height),
          });
        } else {
          classification.push({
            label: String(c.label ?? ''),
            value: num(c.value),
          });
        }
      } finally {
        if (typeof c.delete === 'function') c.delete();
      }
    }
  }

  let visual_ad_grid_cells: EiResult['visual_ad_grid_cells'];
  let visual_ad_max: number | undefined;
  let visual_ad_mean: number | undefined;
  if (hasVisualAnomaly) {
    visual_ad_max = typeof r?.visual_ad_max === 'number' ? r.visual_ad_max : undefined;
    visual_ad_mean = typeof r?.visual_ad_mean === 'number' ? r.visual_ad_mean : undefined;
    if (typeof r?.visual_ad_grid_cells_size === 'function') {
      visual_ad_grid_cells = [];
      const n = r.visual_ad_grid_cells_size();
      for (let i = 0; i < n; i++) {
        const c = r.visual_ad_grid_cells_get(i);
        try {
          visual_ad_grid_cells.push({
            label: String(c.label ?? ''),
            value: num(c.value),
            x: num(c.x),
            y: num(c.y),
            width: num(c.width),
            height: num(c.height),
          });
        } finally {
          if (typeof c.delete === 'function') c.delete();
        }
      }
    }
  }

  return {
    bounding_boxes,
    classification,
    anomaly: typeof r?.anomaly === 'number' ? r.anomaly : undefined,
    visual_ad_grid_cells,
    visual_ad_max,
    visual_ad_mean,
  };
}

// --- Loader ---------------------------------------------------------------

export type LoadedEiModel = {
  classifier: EdgeImpulseClassifier;
  info: EiModelInfo;
};

let _moduleCounter = 0;

/**
 * Load an EI WebAssembly model from the user-uploaded .js + .wasm files.
 *
 * Strategy: rewrite the EI script so that it captures the produced module
 * factory under a unique global name regardless of whether the original code
 * uses `module.exports` (CommonJS), `define([],...)` (AMD), or just `var
 * Module = ...` (browser global). Inject the rewrite as a classic <script>
 * so syntax-level features like top-level `var Module = ...` work.
 */
/**
 * Load an EI WebAssembly model from a deployment zip blob — typically the
 * raw bytes returned by the Studio "deployment/download?type=wasm" endpoint.
 * Locates the standalone .js + .wasm inside and forwards to `loadEiModel`.
 */
export async function loadEiModelFromZip(
  zipBlob: Blob,
  modelName?: string,
): Promise<LoadedEiModel> {
  const { readZip } = await import('./zipReader');
  const entries = await readZip(zipBlob);
  // Prefer files named edge-impulse-standalone.* if present; otherwise pick
  // the largest .wasm and a sibling .js.
  const wasms = entries.filter((e) => e.name.toLowerCase().endsWith('.wasm'));
  const jss = entries.filter((e) => e.name.toLowerCase().endsWith('.js'));
  if (wasms.length === 0) throw new Error('No .wasm found in deployment zip');
  if (jss.length === 0) throw new Error('No .js found in deployment zip');

  // EI deployment zips ship multiple .js files — only the Emscripten
  // standalone module can actually be loaded in the browser. The rest are
  // Node.js wrappers and harnesses that throw at runtime here:
  //   - run-impulse.js / run-classifier.js → use require('fs') etc.
  //   - index.js (Node test app)             → require('./edge-impulse-standalone')
  // We hard-prefer `edge-impulse-standalone.*` and explicitly drop the
  // known Node-only filenames so picking by file size doesn't accidentally
  // grab the wrong one.
  const NODE_ONLY = /^run-impulse|^run-classifier|^index\.js$/i;
  const pickPreferred = <T extends { name: string; data: Uint8Array }>(
    arr: T[],
  ): T => {
    const named = arr.find((e) =>
      e.name.toLowerCase().includes('edge-impulse-standalone'),
    );
    if (named) return named;
    const filtered = arr.filter((e) => {
      const base = e.name.split('/').pop() ?? e.name;
      return !NODE_ONLY.test(base);
    });
    const candidates = filtered.length > 0 ? filtered : arr;
    // Fallback: largest by size from the surviving set.
    return candidates.reduce((a, b) => (a.data.length > b.data.length ? a : b));
  };

  const wasm = pickPreferred(wasms);
  const js = pickPreferred(jss);
  const jsBlob = new Blob([js.data.slice().buffer], { type: 'text/javascript' });
  const wasmBlob = new Blob([wasm.data.slice().buffer], {
    type: 'application/wasm',
  });
  return loadEiModel(jsBlob, wasmBlob, modelName ?? js.name);
}

export async function loadEiModel(
  jsFile: File | Blob,
  wasmFile: File | Blob,
  modelName?: string,
): Promise<LoadedEiModel> {
  const jsText = await blobText(jsFile);

  // Bail out early *only* if the script is a pure Node-only file (typically
  // EI's run-impulse.js test harness, which starts with
  // `const Module = require('./edge-impulse-standalone')` and won't run in
  // a browser at all).
  //
  // Earlier versions scanned for `require('fs')` / `__dirname` / etc. in the
  // first 4KB, but those references DO appear inside guarded
  // `if (ENVIRONMENT_IS_NODE) { … }` blocks of valid universal Emscripten
  // outputs (the kind a "WebAssembly (browser)" deployment ships). That
  // false-positive blocked good files. The first-executable-line check is
  // much narrower: real browser builds always start with comments + a
  // `var Module = typeof Module != 'undefined' ? Module : {};` line, never
  // with a top-level `require(...)`.
  if (firstStatementIsRequire(jsText)) {
    throw new Error(
      `${
        modelName ?? 'Uploaded JS'
      } looks like a Node.js test harness (top-level require), not a browser-loadable WebAssembly module. ` +
        `In an unzipped deployment, pick edge-impulse-standalone.js — not run-impulse.js / index.js. ` +
        `If your project only has the WebAssembly (Node.js) deployment, click 🔨 Build browser deployment above.`,
    );
  }

  const wasmUrl = URL.createObjectURL(wasmFile);
  // Pre-read the wasm bytes once so we can hand them straight to the
  // Emscripten runtime via Module.wasmBinary, avoiding the runtime's own
  // fetch on the blob URL. (That fetch can fail under COEP credentialless
  // or when the runtime expects a fs path, not a URL.)
  const wasmBytes = new Uint8Array(await (wasmFile as Blob).arrayBuffer());

  const id = ++_moduleCounter;
  const captureKey = `__ei_module_${id}`;
  const preseedErrors: string[] = [];

  // EI WebAssembly deployments come in two distinct Emscripten flavors:
  //
  //   (A) MODULARIZE=1 — the script defines `var Module = (cfg) => Promise<runtime>`,
  //       a factory function we call ourselves. Used by the standard
  //       "WebAssembly (browser)" deployment.
  //
  //   (B) Non-MODULARIZE — the script *itself* mutates a `Module` object
  //       and asynchronously initializes the runtime, calling
  //       `Module.onRuntimeInitialized()` when ready. The
  //       "WebAssembly (Node.js, SIMD)" deployment uses this format; it
  //       works in browsers too as long as we pre-seed `globalThis.Module`
  //       with `locateFile` (so it can find the .wasm) before the script
  //       runs.
  //
  // We try (A) first — rewrite the top-level `Module` (or any custom-named)
  // factory binding so it lands on a known global. If that produces a
  // callable, great. Otherwise we set up (B) by pre-seeding the global
  // Module with our hooks, then injecting the unmodified script and
  // waiting for onRuntimeInitialized.
  const rewrite = rewriteToCaptureFactory(jsText, captureKey);
  let scriptUrl: string | null = null;
  let mod: any = null;

  // (A) Factory-style attempt
  if (rewrite.didRewrite) {
    const wrapped = `${rewrite.code}
//# sourceURL=ei-model-${id}.js
`;
    scriptUrl = URL.createObjectURL(
      new Blob([wrapped], { type: 'text/javascript' }),
    );
    await injectScript(scriptUrl);
    const captured = (globalThis as any)[captureKey];
    if (typeof captured === 'function') {
      try {
        mod = await captured({
          wasmBinary: wasmBytes,
          locateFile: (path: string) =>
            path.endsWith('.wasm') ? wasmUrl : path,
          print: () => {},
          printErr: (msg: string) => {
            if (msg && !msg.startsWith('Warning')) console.warn('[EI]', msg);
          },
        });
      } catch (e) {
        // Factory call itself failed — not a captured-but-wrong-shape
        // problem; surface it directly.
        if (scriptUrl) URL.revokeObjectURL(scriptUrl);
        URL.revokeObjectURL(wasmUrl);
        throw new Error(`EI module init failed: ${(e as Error).message}`);
      }
    }
  }

  // (B) Non-MODULARIZE attempt: pre-seed Module, inject the *unmodified*
  // script, wait for onRuntimeInitialized.
  if (!mod) {
    if (scriptUrl) {
      URL.revokeObjectURL(scriptUrl);
      scriptUrl = null;
    }
    const preseed = await loadEmscriptenViaPreseed(
      jsText,
      wasmUrl,
      wasmBytes,
      id,
    );
    mod = preseed.mod;
    if (preseed.err) preseedErrors.push(preseed.err);
  }

  // (C) ESM fallback: `export default Module` style outputs that classic
  // <script> can't parse.
  if (!mod) {
    try {
      const esmUrl = URL.createObjectURL(
        new Blob([jsText], { type: 'text/javascript' }),
      );
      const ns = await import(/* @vite-ignore */ esmUrl);
      URL.revokeObjectURL(esmUrl);
      const candidate = (ns as any)?.default ?? (ns as any)?.Module;
      if (typeof candidate === 'function') {
        mod = await candidate({
          locateFile: (path: string) =>
            path.endsWith('.wasm') ? wasmUrl : path,
          print: () => {},
          printErr: () => {},
        });
      }
    } catch {
      // Not an ES module, or init failed. Fall through.
    }
  }

  if (!mod) {
    if (scriptUrl) URL.revokeObjectURL(scriptUrl);
    URL.revokeObjectURL(wasmUrl);
    const head = jsText.slice(0, 240).replace(/\s+/g, ' ');
    throw new Error(
      `Could not initialize Edge Impulse module ${modelName ?? ''}. ` +
        (preseedErrors.length
          ? `onRuntimeInitialized path: ${preseedErrors.join(' || ')}. `
          : 'Tried MODULARIZE-factory + onRuntimeInitialized + ESM import. ') +
        `Source preview: ${head}…`,
    );
  }

  const classifier = new EdgeImpulseClassifier(mod);
  await classifier.init();

  const props = classifier.getProperties();
  const project = classifier.getProject();
  const info = buildModelInfo(props, project);

  return { classifier, info };
}

function buildModelInfo(
  props: Record<string, unknown>,
  project: Record<string, unknown>,
): EiModelInfo {
  // EI's emcc_classification_properties_t uses snake_case getters. Older
  // builds also expose camelCase aliases — fall back to those if needed.
  const w = num(
    props.image_input_width ?? props.imageInputWidth ?? 96,
    96,
  );
  const h = num(
    props.image_input_height ?? props.imageInputHeight ?? 96,
    96,
  );
  const frameSize = num(props.image_input_frames ?? props.imageInputFrames ?? 1, 1);
  // RGB models report image_channel_count = 3; grayscale = 1. Some builds
  // use input_features_count = w*h*channels, so derive from that as a fallback.
  let channels = num(
    props.image_channel_count ?? props.imageChannelCount ?? 0,
    0,
  );
  if (!channels) {
    const total = num(props.input_features_count ?? 0, 0);
    if (w > 0 && h > 0 && total > 0) {
      const ch = Math.round(total / (w * h * frameSize));
      channels = ch === 1 || ch === 3 ? ch : 3;
    } else {
      channels = 3;
    }
  }
  const modelType = String(props.model_type ?? props.modelType ?? '');
  const isObjectDetection =
    modelType === 'object_detection' ||
    modelType === 'constrained_object_detection';
  const hasAnomaly = !!(props.has_anomaly ?? props.hasAnomaly ?? false);
  const hasVisualAnomaly = !!(
    props.has_visual_anomaly_detection ?? props.hasVisualAnomalyDetection ?? false
  );

  // Labels can come from the project struct (`labels`, `label_names`) or
  // from the properties struct.
  let labels: string[] = [];
  const rawLabels =
    project.labels ?? project.label_names ?? props.labels ?? null;
  if (Array.isArray(rawLabels)) {
    labels = rawLabels.map((l) => String(l));
  } else if (typeof rawLabels === 'string') {
    labels = rawLabels
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return {
    inputWidth: w,
    inputHeight: h,
    isRgb: channels >= 3,
    isObjectDetection,
    hasAnomaly,
    hasVisualAnomaly,
    modelType,
    labels,
  };
}

async function blobText(b: File | Blob): Promise<string> {
  return await b.text();
}

/**
 * Returns true iff the first executable statement in `source` is a top-level
 * `require(...)` call — the unmistakable signature of a Node.js test harness
 * (e.g. EI's run-impulse.js: `const Module = require('./edge-impulse-standalone')`).
 *
 * Skips leading shebang, line comments, block comments, blank lines. Real
 * browser-targeted Emscripten output always starts with a comment header
 * followed by `var Module = typeof Module != 'undefined' ? Module : {};` —
 * never with a require() call — so this check has no false positives on
 * valid universal/browser builds.
 */
function firstStatementIsRequire(source: string): boolean {
  let i = 0;
  const n = source.length;
  // Skip shebang
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n');
    if (nl < 0) return false;
    i = nl + 1;
  }
  while (i < n) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    // Line comment
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      if (nl < 0) return false;
      i = nl + 1;
      continue;
    }
    // Block comment
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return false;
      i = end + 2;
      continue;
    }
    // First executable code starts here. Match a top-level
    //   const|let|var <Name> = require(...)
    // or a bare
    //   require(...);
    const rest = source.slice(i, i + 200);
    return /^(?:(?:const|let|var)\s+[\w$]+\s*=\s*)?require\s*\(/.test(rest);
  }
  return false;
}

/**
 * Run a non-MODULARIZE Emscripten script — the kind that mutates a
 * pre-existing `Module` object and asynchronously initializes the runtime.
 * EI's "WebAssembly (Node.js, SIMD)" build is shaped like this.
 *
 * Flow:
 *   1. Set `globalThis.Module` to an object with locateFile pointing at the
 *      blob-URL'd .wasm and onRuntimeInitialized resolving the promise.
 *   2. Inject the script verbatim — it sees the existing Module and
 *      attaches its runtime to it.
 *   3. Await onRuntimeInitialized. The Module object IS the runtime.
 *
 * Restores `globalThis.Module` to its previous value when done so back-to-
 * back loads of different models don't trample each other.
 */
async function loadEmscriptenViaPreseed(
  jsText: string,
  wasmUrl: string,
  wasmBytes: Uint8Array,
  id: number,
): Promise<{ mod: any; err: string | null }> {
  const TIMEOUT_MS = 15000;
  const hadModule = Object.prototype.hasOwnProperty.call(globalThis, 'Module');
  const prevModule = (globalThis as any).Module;
  const seedKey = `__ei_preseed_module_${id}`;
  let resolveInit!: (m: any) => void;
  let rejectInit!: (e: Error) => void;
  const initPromise = new Promise<any>((res, rej) => {
    resolveInit = res;
    rejectInit = rej;
  });

  // Capture errors thrown by the injected script. The classic <script> tag
  // doesn't surface synchronous errors via the load event, and some
  // Emscripten outputs throw via window.onerror or unhandled rejections —
  // we want to attach those to the user-facing diagnostic.
  const capturedErrors: string[] = [];
  const onWinError = (e: ErrorEvent) => {
    if (e.filename?.includes(`ei-preseed-${id}`)) capturedErrors.push(e.message);
  };
  const onUnhandled = (e: PromiseRejectionEvent) => {
    capturedErrors.push(`Unhandled rejection: ${String(e.reason)}`);
  };
  window.addEventListener('error', onWinError);
  window.addEventListener('unhandledrejection', onUnhandled);

  // Pre-supply the wasm bytes via Module.wasmBinary so Emscripten's
  // initialization doesn't need to do its own fetch on the blob URL — that
  // path can fail under COEP credentialless or when the runtime can't
  // resolve the locateFile result.
  const ModuleSeed: any = {
    wasmBinary: wasmBytes,
    locateFile: (path: string) =>
      path.endsWith('.wasm') ? wasmUrl : path,
    print: () => {},
    printErr: (msg: string) => {
      if (msg && !msg.startsWith('Warning')) capturedErrors.push(`[EI] ${msg}`);
    },
    onRuntimeInitialized() {
      // Some EI WebAssembly builds don't run their C++ static
      // initializers (the EMSCRIPTEN_BINDINGS blocks that register
      // `init`, `run_classifier`, `get_properties`, etc. on Module) as
      // part of the standard Emscripten run() flow. Their `addOnInit`
      // queues `__wasm_call_ctors` but it never seems to execute under
      // some hosting conditions — so we belt-and-braces invoke it
      // ourselves once the runtime says it's ready. Idempotent: a second
      // call to ctors after they've already run is a no-op (Embind's
      // `exposePublicSymbol` skips re-registration).
      try {
        const ctors = ModuleSeed.asm?.['__wasm_call_ctors'];
        if (typeof ctors === 'function' && !ModuleSeed.run_classifier) {
          ctors();
        }
      } catch (e) {
        capturedErrors.push(`call_ctors: ${(e as Error).message}`);
      }
      resolveInit(ModuleSeed);
    },
    onAbort(what: any) {
      rejectInit(new Error(`Module aborted: ${what}`));
    },
  };
  (globalThis as any).Module = ModuleSeed;
  (globalThis as any)[seedKey] = ModuleSeed;

  const scriptUrl = URL.createObjectURL(
    new Blob(
      [
        wrapNonModularEmscriptenScript(jsText, seedKey, `ei-preseed-${id}.js`),
      ],
      {
        type: 'text/javascript',
      },
    ),
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await injectScript(scriptUrl);
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(
        () =>
          rej(
            new Error(
              `onRuntimeInitialized never fired in ${TIMEOUT_MS}ms` +
                (capturedErrors.length
                  ? ` — captured: ${capturedErrors.join(' | ')}`
                  : ''),
            ),
          ),
        TIMEOUT_MS,
      );
    });
    const mod = await Promise.race([initPromise, timeout]);
    return { mod, err: null };
  } catch (e) {
    const detail = (e as Error).message;
    const merged = capturedErrors.length
      ? `${detail} — captured: ${capturedErrors.join(' | ')}`
      : detail;
    return { mod: null, err: merged };
  } finally {
    if (timer) clearTimeout(timer);
    URL.revokeObjectURL(scriptUrl);
    window.removeEventListener('error', onWinError);
    window.removeEventListener('unhandledrejection', onUnhandled);
    delete (globalThis as any)[seedKey];
    if (hadModule) {
      (globalThis as any).Module = prevModule;
    } else {
      delete (globalThis as any).Module;
    }
  }
}

function wrapNonModularEmscriptenScript(
  source: string,
  seedKey: string,
  sourceName: string,
): string {
  // Non-MODULARIZE Emscripten exports close over a variable literally named
  // `Module`. Passing the seed as an IIFE argument gives every generated
  // wrapper a stable reference, even after we restore window.Module.
  return `(function(Module) {\n${source}\n})(globalThis[${JSON.stringify(
    seedKey,
  )}]);\n//# sourceURL=${sourceName}\n`;
}

/**
 * Rewrite the first top-level `(var|let|const) <Name> = ...` so the assigned
 * value also lands on `globalThis[captureKey]`. Handles all three declarators
 * AND custom export names (Emscripten -s EXPORT_NAME=...). The rewritten
 * declaration still binds the original local name, so any subsequent
 * references inside the script still work.
 *
 * Returns `{ didRewrite: false }` when no match is found — caller decides
 * whether to fall back to ESM dynamic import.
 */
function rewriteToCaptureFactory(
  source: string,
  captureKey: string,
): { code: string; didRewrite: boolean; matchedName?: string } {
  // MODULARIZE output declares the factory near the top of the file —
  // typically in the first 200 lines after the comment header. We only
  // scan the head of the source to avoid false-positive matches on
  // unrelated `var foo = (...)` lines deep inside non-MODULARIZE output
  // (e.g. EI's standalone script has `var lang = ((typeof navigator...`
  // ~240KB into the file; matching that and rewriting would corrupt the
  // script).
  const head = source.slice(0, 4096);
  const re = /^(\s*)(var|let|const)(\s+)([A-Za-z_$][\w$]*)(\s*=\s*)(?=(?:\(\s*(?:function|\(|async\s+function)|function\s|async\s+function\s|class\s))/m;
  const match = re.exec(head);
  if (!match) return { code: source, didRewrite: false };
  const [whole, ws, kw, ws2, name, eq] = match;
  const replacement = `${ws}${kw}${ws2}${name}${eq}globalThis[${JSON.stringify(captureKey)}] = `;
  const code =
    source.slice(0, match.index) +
    replacement +
    source.slice(match.index + whole.length);
  return { code, didRewrite: true, matchedName: name };
}

function injectScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load EI script'));
    document.head.appendChild(s);
  });
}

// --- Image feature packing ------------------------------------------------

/**
 * Resize a source canvas to `targetW × targetH` and pack pixels into the
 * features array Edge Impulse expects.
 *
 * For RGB models: one feature per pixel, value = (R<<16)|(G<<8)|B
 * For grayscale: one feature per pixel, value = luma 0..255
 */
export function canvasToFeatures(
  source: HTMLCanvasElement,
  targetW: number,
  targetH: number,
  rgb: boolean,
): number[] {
  const c = document.createElement('canvas');
  c.width = targetW;
  c.height = targetH;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, targetW, targetH);
  const px = ctx.getImageData(0, 0, targetW, targetH).data;
  const features = new Array<number>(targetW * targetH);
  for (let i = 0, j = 0; j < features.length; i += 4, j++) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    if (rgb) {
      features[j] = (r << 16) | (g << 8) | b;
    } else {
      // ITU-R BT.601 luma
      features[j] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
    }
  }
  return features;
}
