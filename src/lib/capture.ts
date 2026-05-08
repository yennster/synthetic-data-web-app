import * as THREE from 'three';
import type { BoundingBox, Capture } from '../store/useStore';

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
  const { renderer: r, canvas: cv } = getCaptureRenderer(width, height);

  // Update camera aspect to match capture resolution.
  const prevAspect = camera.aspect;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  r.render(scene, camera);

  // Compute bboxes BEFORE restoring aspect (uses the same matrices we just rendered with).
  const boxes = computeBoundingBoxes(scene, camera, width, height);

  const blob: Blob = await new Promise((resolve, reject) =>
    cv.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/png',
    ),
  );

  // Restore camera aspect — but DON'T dispose the renderer; we reuse it.
  camera.aspect = prevAspect;
  camera.updateProjectionMatrix();

  return { blob, boxes };
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
    minX = Math.max(0, Math.min(width, minX));
    minY = Math.max(0, Math.min(height, minY));
    maxX = Math.max(0, Math.min(width, maxX));
    maxY = Math.max(0, Math.min(height, maxY));
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
