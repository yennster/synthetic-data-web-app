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

// --- Embind helpers -------------------------------------------------------

function readVector<T>(v: unknown): T[] {
  if (!v) return [];
  if (Array.isArray(v)) return v as T[];
  // Embind vector: has .size() and .get(i)
  // (some flag combos auto-convert to array; some don't)
  const obj = v as { size?: () => number; get?: (i: number) => T };
  if (typeof obj.size === 'function' && typeof obj.get === 'function') {
    const n = obj.size();
    const out = new Array<T>(n);
    for (let i = 0; i < n; i++) out[i] = obj.get(i);
    return out;
  }
  return [];
}

function num(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

// --- Classifier wrapper ---------------------------------------------------

class EdgeImpulseClassifier {
  private initialized = false;
  constructor(private mod: any) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    // The factory we awaited already resolves once runtime is initialized,
    // so the explicit init call below is the only thing needed in practice.
    if (typeof this.mod._run_classifier_init === 'function') {
      this.mod._run_classifier_init();
    }
    this.initialized = true;
  }

  getProperties(): Record<string, unknown> {
    if (typeof this.mod.get_properties === 'function') {
      const p = this.mod.get_properties();
      // Embind returns a struct; copy into a plain object so consumers can
      // iterate it freely (and so `delete()`-able handles aren't held).
      return shallowCopyEmbind(p);
    }
    return {};
  }

  getProject(): Record<string, unknown> {
    if (typeof this.mod.get_project === 'function') {
      try {
        const raw = this.mod.get_project();
        if (typeof raw === 'string') return JSON.parse(raw);
        return shallowCopyEmbind(raw);
      } catch {
        // fall through
      }
    }
    return {};
  }

  classify(features: number[]): EiResult {
    if (!this.initialized) throw new Error('Classifier not initialized');
    let res: any;
    try {
      // Modern EI exports accept a plain JS array; Embind auto-converts.
      res = this.mod.run_classifier(features, false);
    } catch (e) {
      // Older / stricter exports want a vector<float>. Build one explicitly.
      if (this.mod.VectorFloat) {
        const v = new this.mod.VectorFloat();
        try {
          for (let i = 0; i < features.length; i++) v.push_back(features[i]);
          res = this.mod.run_classifier(v, false);
        } finally {
          if (typeof v.delete === 'function') v.delete();
        }
      } else {
        throw e;
      }
    }
    return parseResult(res);
  }
}

function shallowCopyEmbind(obj: any): Record<string, unknown> {
  if (!obj) return {};
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    out[k] = obj[k];
  }
  return out;
}

function parseResult(r: any): EiResult {
  const boxes = readVector<any>(r?.bounding_boxes).map((b) => ({
    label: String(b.label ?? ''),
    value: num(b.value),
    x: num(b.x),
    y: num(b.y),
    width: num(b.width),
    height: num(b.height),
  }));
  const classification = readVector<any>(r?.classification).map((c) => ({
    label: String(c.label ?? ''),
    value: num(c.value),
  }));
  const cells = readVector<any>(r?.visual_ad_grid_cells).map((c) => ({
    label: String(c.label ?? ''),
    value: num(c.value),
    x: num(c.x),
    y: num(c.y),
    width: num(c.width),
    height: num(c.height),
  }));
  return {
    bounding_boxes: boxes,
    classification,
    anomaly: typeof r?.anomaly === 'number' ? r.anomaly : undefined,
    visual_ad_grid_cells: cells.length > 0 ? cells : undefined,
    visual_ad_max:
      typeof r?.visual_ad_max === 'number' ? r.visual_ad_max : undefined,
    visual_ad_mean:
      typeof r?.visual_ad_mean === 'number' ? r.visual_ad_mean : undefined,
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

  const pickPreferred = <T extends { name: string; data: Uint8Array }>(
    arr: T[],
  ): T => {
    const named = arr.find((e) =>
      e.name.toLowerCase().includes('edge-impulse-standalone'),
    );
    if (named) return named;
    // Fallback: largest by size
    return arr.reduce((a, b) => (a.data.length > b.data.length ? a : b));
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
  const wasmUrl = URL.createObjectURL(wasmFile);

  const id = ++_moduleCounter;
  const captureKey = `__ei_module_${id}`;

  // Make the EI script's `Module` (or `module.exports`) land on
  // globalThis[captureKey]. The shim is appended; the original code is
  // executed first and can set whatever globals it pleases.
  const wrapped = `${jsText}
;(function(){
  try {
    var m = (typeof module !== 'undefined' && module.exports) ? module.exports : (typeof Module !== 'undefined' ? Module : null);
    globalThis[${JSON.stringify(captureKey)}] = m;
  } catch (e) {
    globalThis[${JSON.stringify(captureKey)}] = null;
  }
})();
//# sourceURL=ei-model-${id}.js
`;
  const scriptUrl = URL.createObjectURL(
    new Blob([wrapped], { type: 'text/javascript' }),
  );

  await injectScript(scriptUrl);

  const factory = (globalThis as any)[captureKey];
  if (typeof factory !== 'function') {
    URL.revokeObjectURL(scriptUrl);
    URL.revokeObjectURL(wasmUrl);
    throw new Error(
      `Could not find Edge Impulse module factory in ${
        modelName ?? 'uploaded JS'
      }. Expected MODULARIZE-style Emscripten output.`,
    );
  }

  let mod: any;
  try {
    mod = await factory({
      locateFile: (path: string) =>
        path.endsWith('.wasm') ? wasmUrl : path,
      // Silence the default Emscripten console flood; surface as needed.
      print: () => {},
      printErr: (msg: string) => {
        if (msg && !msg.startsWith('Warning')) console.warn('[EI]', msg);
      },
    });
  } catch (e) {
    URL.revokeObjectURL(scriptUrl);
    URL.revokeObjectURL(wasmUrl);
    throw new Error(`EI module init failed: ${(e as Error).message}`);
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
  // EI uses a few different field names across versions; try them all.
  const w = num(
    props.imageInputWidth ??
      props.image_input_width ??
      props.inputWidth ??
      props.input_width ??
      96,
    96,
  );
  const h = num(
    props.imageInputHeight ??
      props.image_input_height ??
      props.inputHeight ??
      props.input_height ??
      96,
    96,
  );
  const channels = num(
    props.imageChannelCount ??
      props.image_channel_count ??
      props.imageInputChannels ??
      3,
    3,
  );
  const isObjectDetection = !!(
    props.isObjectDetection ??
    props.is_object_detection ??
    props.objectDetection ??
    false
  );
  const hasAnomaly = !!(props.hasAnomaly ?? props.has_anomaly ?? false);
  const hasVisualAnomaly = !!(
    props.hasVisualAnomalyDetection ??
    props.has_visual_anomaly_detection ??
    props.hasVisualAnomaly ??
    false
  );
  const modelType = String(
    props.modelType ?? props.model_type ?? project.modelType ?? '',
  );

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
