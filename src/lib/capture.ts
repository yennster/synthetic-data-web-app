import * as THREE from 'three';
import type { BoundingBox, Capture } from '../store/useStore';
import { clamp } from './math';

// Singleton off-screen renderer reused across every captureFrame call. We
// used to spin up a fresh THREE.WebGLRenderer (and therefore a fresh WebGL
// context) per capture; Chromium caps simultaneously-alive contexts at ~16
// and force-kills the oldest when that's exceeded. After a couple of
// batch-capture runs, the oldest live context was the main R3F canvas,
// blanking the 3D view. Holding one reusable renderer for the lifetime of
// the page means we only ever consume one extra context, regardless of
// batch size or how many times the user clicks "Generate batch".
let captureRenderer: THREE.WebGLRenderer | null = null;
let captureCanvas: HTMLCanvasElement | null = null;

// Supersampling factor applied to every capture. We render at SSAA× the
// requested resolution and downsample with a high-quality bilinear filter
// before emitting the PNG — effectively free SSAA. 2× quadruples the
// fragment work *during a capture only* (the live R3F canvas is unaffected,
// which is what keeps weaker computers fast in editor / preview). 4 MB of
// extra render-target memory at 1280×960×SSAA=2 is trivial; pixel cost
// scales linearly with the user's chosen capture resolution.
const SSAA_FACTOR = 2;

function getCaptureRenderer(
  width: number,
  height: number,
): { renderer: THREE.WebGLRenderer; canvas: HTMLCanvasElement } {
  if (!captureRenderer || !captureCanvas) {
    const cv = document.createElement('canvas');
    cv.width = width;
    cv.height = height;
    const r = new THREE.WebGLRenderer({
      canvas: cv,
      antialias: true,
      preserveDrawingBuffer: true,
      alpha: false,
    });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.setPixelRatio(1);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    captureRenderer = r;
    captureCanvas = cv;
  }
  // Resize is cheap and idempotent — Three.js skips when dimensions match.
  captureRenderer.setSize(width, height, false);
  return { renderer: captureRenderer, canvas: captureCanvas };
}

/**
 * Render the given scene to an off-screen canvas at the requested resolution
 * using the supplied camera, and return the resulting blob plus 2D bounding
 * boxes for the labelled meshes (those with `userData.label` set).
 */
export async function captureFrame(opts: {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  width: number;
  height: number;
}): Promise<{ blob: Blob; boxes: BoundingBox[] }> {
  const { scene, camera, width, height } = opts;
  // Render at the supersampled size, then downsample on a 2D canvas so the
  // final PNG matches the user's requested resolution. Aspect ratio is
  // preserved; bounding boxes are computed against the user-facing pixel
  // grid so the SSAA factor is invisible to downstream consumers (EI
  // ingestion, info.labels, the live inference path).
  const ssWidth = width * SSAA_FACTOR;
  const ssHeight = height * SSAA_FACTOR;
  const { renderer: r, canvas: cv } = getCaptureRenderer(ssWidth, ssHeight);

  // Update camera aspect to match capture resolution.
  const prevAspect = camera.aspect;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  try {
    r.render(scene, camera);

    // Compute bboxes against the OUTPUT resolution (width × height), not the
    // supersampled internal buffer. The projection matrix is aspect-only, so
    // the math is identical; we just want pixel coordinates that match the
    // PNG the user gets.
    const boxes = computeBoundingBoxes(scene, camera, width, height);

    const blob = await downsampleToBlob(cv, width, height);
    return { blob, boxes };
  } finally {
    // Restore camera aspect — but DON'T dispose the renderer; we reuse it.
    camera.aspect = prevAspect;
    camera.updateProjectionMatrix();
  }
}

/**
 * Downsample the supersampled WebGL canvas to the final width × height
 * via a 2D canvas blit. `imageSmoothingQuality: 'high'` triggers the
 * browser's best-quality bilinear / lanczos path (Chromium uses Lanczos
 * at large downscale ratios), giving the effect of SSAA without
 * implementing a custom shader.
 */
async function downsampleToBlob(
  source: HTMLCanvasElement,
  width: number,
  height: number,
): Promise<Blob> {
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) {
    // Fallback: just emit the supersampled canvas as-is. Bboxes will still
    // line up because they were computed in OUTPUT-resolution space — the
    // PNG will simply be SSAA× too big.
    return new Promise((resolve, reject) =>
      source.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
        'image/png',
      ),
    );
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return new Promise((resolve, reject) =>
    out.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/png',
    ),
  );
}

/**
 * Find every labelled object in the scene and emit one tight 2D bounding box
 * per labelled subtree. A "labelled subtree" is rooted at any Object3D with
 * `userData.label` set; its descendant meshes contribute their AABB corners.
 *
 * This means: a single labelled `<mesh>` produces one box, and an imported
 * USDZ Group with many child meshes labelled at the root also produces one
 * box (not one per child).
 *
 * Per-mesh labelling (the original case) is preserved by tagging only the
 * specific mesh; the projector picks the deepest non-overlapping labelled
 * ancestor.
 */
function computeBoundingBoxes(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
): BoundingBox[] {
  const boxes: BoundingBox[] = [];
  const tmp = new THREE.Vector3();
  const corners: THREE.Vector3[] = Array.from({ length: 8 }, () => new THREE.Vector3());

  // Find the topmost labelled ancestor for each labelled object — any descendants
  // that are also labelled with the same value are absorbed into the parent's box.
  const labelRoots: THREE.Object3D[] = [];
  scene.traverse((obj) => {
    const label = obj.userData?.label as string | undefined;
    if (!label) return;
    // Skip if any ancestor already has the same label — we'll be processed as part of that root.
    let p = obj.parent;
    while (p) {
      if (p.userData?.label === label) return;
      p = p.parent;
    }
    labelRoots.push(obj);
  });

  for (const root of labelRoots) {
    const label = root.userData.label as string;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    let anyInFront = false;

    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (!mesh.geometry.boundingBox) return;
      const { min, max } = mesh.geometry.boundingBox;
      corners[0].set(min.x, min.y, min.z);
      corners[1].set(min.x, min.y, max.z);
      corners[2].set(min.x, max.y, min.z);
      corners[3].set(min.x, max.y, max.z);
      corners[4].set(max.x, min.y, min.z);
      corners[5].set(max.x, min.y, max.z);
      corners[6].set(max.x, max.y, min.z);
      corners[7].set(max.x, max.y, max.z);

      for (const c of corners) {
        tmp.copy(c).applyMatrix4(mesh.matrixWorld).project(camera);
        if (tmp.z > 1) continue; // behind camera
        anyInFront = true;
        const sx = (tmp.x * 0.5 + 0.5) * width;
        const sy = (1 - (tmp.y * 0.5 + 0.5)) * height;
        if (sx < minX) minX = sx;
        if (sy < minY) minY = sy;
        if (sx > maxX) maxX = sx;
        if (sy > maxY) maxY = sy;
      }
    });

    if (!anyInFront) continue;
    minX = clamp(minX, 0, width);
    minY = clamp(minY, 0, height);
    maxX = clamp(maxX, 0, width);
    maxY = clamp(maxY, 0, height);
    const w = Math.round(maxX - minX);
    const h = Math.round(maxY - minY);
    if (w < 4 || h < 4) continue;
    boxes.push({
      label,
      x: Math.round(minX),
      y: Math.round(minY),
      width: w,
      height: h,
    });
  }

  return boxes;
}

// ---------- File saving ----------
//
// We always go through the browser's Downloads folder. The File System
// Access API was previously plumbed through here so the user could pick a
// directory once and have every capture write into it, but Chrome's picker
// blocks "system folders" (Desktop/Downloads/home/iCloud root) with a
// confusing dialog and the extra UI added more friction than it removed.
// A simple anchor click hits the same Downloads folder a normal browser
// download would, with no permission prompt.

export async function saveBlob(filename: string, blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Edge Impulse `bounding_boxes.labels` sidecar format. Used by the Studio
 * during data acquisition / upload.
 * https://docs.edgeimpulse.com/docs/edge-impulse-studio/data-acquisition/uploader#bounding-boxes
 */
export function buildBoundingBoxLabelsFile(
  captures: Capture[],
): string {
  const boundingBoxes: Record<string, { label: string; x: number; y: number; width: number; height: number }[]> = {};
  for (const c of captures) {
    if (c.boxes.length === 0) continue;
    boundingBoxes[c.filename] = c.boxes.map((b) => ({ ...b }));
  }
  return JSON.stringify(
    {
      version: 1,
      type: 'bounding-box-labels',
      boundingBoxes,
    },
    null,
    2,
  );
}

export function makeFilename(prefix: string, idx: number, ext = 'png'): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const safe = (prefix || 'capture').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safe}.${ts}.${String(idx).padStart(4, '0')}.${ext}`;
}
