import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useStore } from '../store/useStore';
import { captureFrame, makeFilename, saveBlob } from '../lib/capture';

/**
 * The virtual camera has two responsibilities:
 *   1. Render a small live preview into a corner overlay so the user can see
 *      what their captures will look like.
 *   2. Listen to capture / batch signals from the store, render to a high-res
 *      offscreen target, save the resulting PNG, and push the capture entry
 *      into the store.
 *
 * It also draws a frustum gizmo into the main scene so the user can see and
 * orbit around the capture viewpoint.
 *
 * Live preview implementation:
 *   - We render the scene from the virtual camera into a WebGLRenderTarget
 *     sized to match the preview canvas — this isolates the preview from
 *     the main canvas, which keeps the orbit view clean and avoids
 *     aspect-ratio / downscaling artifacts.
 *   - We hide the CameraHelper for that render pass, otherwise its frustum
 *     lines (rendered with depthTest off) emanate from the eye and produce
 *     a crisscross overlay on the preview.
 *   - We throttle to ~15 Hz; full 60 Hz preview costs extra GPU work and a
 *     readback per frame for no perceptible benefit.
 */
const PREVIEW_HZ = 15;
const PREVIEW_INTERVAL_MS = 1000 / PREVIEW_HZ;

export function VirtualCamera({
  previewCanvas,
}: {
  previewCanvas: HTMLCanvasElement | null;
}) {
  const { gl, scene } = useThree();
  const helperRef = useRef<THREE.CameraHelper | null>(null);

  const cameraSettings = useStore((s) => s.capture);
  const captureSignal = useStore((s) => s.captureSignal);
  const batchSignal = useStore((s) => s.batchSignal);
  const addCapture = useStore((s) => s.addCapture);
  const setStatus = useStore((s) => s.setStatus);
  const saveDirHandle = useStore((s) => s.saveDirHandle);
  const anomalyLabel = useStore((s) => s.anomalyLabel);
  const mode = useStore((s) => s.mode);

  // Camera + helper setup
  const camera = useMemo(() => {
    const c = new THREE.PerspectiveCamera(45, 4 / 3, 0.05, 100);
    return c;
  }, []);

  // Off-screen render target for the live preview. Size adapts when the
  // preview canvas size or capture aspect changes.
  const previewTarget = useMemo(() => {
    const t = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      colorSpace: THREE.SRGBColorSpace,
    });
    return t;
  }, []);
  // Pixel buffer for readback — reused across frames.
  const pixelBuf = useRef<Uint8Array | null>(null);
  const lastPreviewMs = useRef(0);

  useEffect(() => {
    return () => {
      previewTarget.dispose();
    };
  }, [previewTarget]);

  useEffect(() => {
    const helper = new THREE.CameraHelper(camera);
    const mats = Array.isArray(helper.material) ? helper.material : [helper.material];
    for (const m of mats) (m as THREE.Material).depthTest = false;
    helper.renderOrder = 1000;
    helperRef.current = helper;
    scene.add(helper);
    return () => {
      scene.remove(helper);
      helper.dispose();
    };
  }, [camera, scene]);

  // Per-frame: keep camera + helper synced to settings, and refresh the
  // preview at PREVIEW_HZ.
  useFrame(() => {
    const cam = camera;
    cam.position.set(...cameraSettings.camPos);
    cam.lookAt(...cameraSettings.camTarget);
    cam.fov = cameraSettings.fov;
    cam.aspect = cameraSettings.width / cameraSettings.height;
    cam.updateProjectionMatrix();
    helperRef.current?.update();

    if (!previewCanvas) return;
    const now = performance.now();
    if (now - lastPreviewMs.current < PREVIEW_INTERVAL_MS) return;
    lastPreviewMs.current = now;

    renderPreview();
  });

  function renderPreview() {
    if (!previewCanvas) return;
    const ctx = previewCanvas.getContext('2d');
    if (!ctx) return;

    // Match the render target's size to the preview canvas (in CSS pixels).
    const w = previewCanvas.width;
    const h = previewCanvas.height;
    if (previewTarget.width !== w || previewTarget.height !== h) {
      previewTarget.setSize(w, h);
      pixelBuf.current = null;
    }
    if (!pixelBuf.current || pixelBuf.current.length !== w * h * 4) {
      pixelBuf.current = new Uint8Array(w * h * 4);
    }

    // Render the scene with the helper hidden so its frustum lines don't
    // crisscross the preview.
    const helper = helperRef.current;
    const helperWasVisible = helper?.visible ?? true;
    if (helper) helper.visible = false;

    const prevTarget = gl.getRenderTarget();
    gl.setRenderTarget(previewTarget);
    gl.clear();
    gl.render(scene, camera);
    gl.setRenderTarget(prevTarget);

    if (helper) helper.visible = helperWasVisible;

    // Read back into a CPU buffer and blit to the 2D preview canvas.
    // WebGL textures are origin bottom-left, so we flip vertically when
    // putting into the canvas.
    const buf = pixelBuf.current;
    gl.readRenderTargetPixels(previewTarget, 0, 0, w, h, buf);

    const img = ctx.createImageData(w, h);
    // Flip rows: source row y → dest row (h-1-y)
    const rowBytes = w * 4;
    for (let y = 0; y < h; y++) {
      const srcStart = y * rowBytes;
      const dstStart = (h - 1 - y) * rowBytes;
      img.data.set(
        buf.subarray(srcStart, srcStart + rowBytes),
        dstStart,
      );
    }
    ctx.putImageData(img, 0, 0);
  }

  // Single-shot capture
  useEffect(() => {
    if (captureSignal === 0) return;
    void doCapture();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureSignal]);

  // Batch capture
  useEffect(() => {
    if (batchSignal === 0) return;
    void doBatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchSignal]);

  async function doCapture() {
    const cam = camera;
    setStatus('busy', 'Capturing…');
    try {
      const { width, height } = cameraSettings;
      // Hide helper for the capture too, so the frustum gizmo isn't burned
      // into the saved PNG.
      const helper = helperRef.current;
      const helperWasVisible = helper?.visible ?? true;
      if (helper) helper.visible = false;

      const { blob, boxes } = await captureFrame({
        renderer: gl as THREE.WebGLRenderer,
        scene,
        camera: cam,
        width,
        height,
      });

      if (helper) helper.visible = helperWasVisible;

      const idx = useStore.getState().captures.length;
      const labelPrefix =
        mode === 'anomaly' ? anomalyLabel || 'sample' : 'frame';
      const filename = makeFilename(labelPrefix, idx);

      // Save to FS if directory chosen, else fall back to download.
      try {
        await saveBlob(
          saveDirHandle ? { kind: 'fs', dir: saveDirHandle } : { kind: 'download' },
          filename,
          blob,
        );
      } catch (e) {
        setStatus('err', `Save failed: ${(e as Error).message}`);
      }

      addCapture({
        id: crypto.randomUUID(),
        filename,
        blob,
        boxes: mode === 'anomaly' ? [] : boxes,
        label: mode === 'anomaly' ? anomalyLabel : '',
        width,
        height,
        ts: Date.now(),
      });
      setStatus('ok', `Captured ${filename} (${boxes.length} boxes)`);
    } catch (e) {
      setStatus('err', `Capture error: ${(e as Error).message}`);
    }
  }

  async function doBatch() {
    const { capture: cs, sceneObjects } = useStore.getState();
    const total = cs.batchCount;

    // Snapshot the user's chosen camera/light origin to jitter around.
    const baseCam = [...cs.camPos] as [number, number, number];
    const baseTarget = [...cs.camTarget] as [number, number, number];
    const baseFov = cs.fov;
    const baseLight = cs.lightIntensity;
    const baseEnvRot = cs.envRotation;
    const baseObjPositions = sceneObjects.map(
      (o) => [...o.position] as [number, number, number],
    );

    setStatus('busy', `Batch 0/${total}`);
    try {
      for (let i = 0; i < total; i++) {
        // Randomize per the toggles
        const setCapture = useStore.getState().setCapture;
        if (cs.randomizeCamera) {
          const r = 0.6;
          setCapture({
            camPos: [
              baseCam[0] + (Math.random() - 0.5) * r * 2,
              Math.max(0.5, baseCam[1] + (Math.random() - 0.5) * r),
              baseCam[2] + (Math.random() - 0.5) * r * 2,
            ],
            camTarget: [
              baseTarget[0] + (Math.random() - 0.5) * 0.4,
              baseTarget[1] + (Math.random() - 0.5) * 0.2,
              baseTarget[2] + (Math.random() - 0.5) * 0.4,
            ],
            fov: baseFov + (Math.random() - 0.5) * 10,
          });
        }
        if (cs.randomizeLighting) {
          setCapture({
            lightIntensity: Math.max(
              0.2,
              baseLight + (Math.random() - 0.5) * 0.8,
            ),
            envRotation: baseEnvRot + Math.random() * Math.PI * 2,
          });
        }
        if (cs.randomizeObjects) {
          const updateSceneObject = useStore.getState().updateSceneObject;
          sceneObjects.forEach((o, idx) => {
            const base = baseObjPositions[idx] ?? [0, 0.5, 0];
            updateSceneObject(o.id, {
              position: [
                base[0] + (Math.random() - 0.5) * 0.6,
                Math.max(0.2, base[1] + (Math.random() - 0.5) * 0.2),
                base[2] + (Math.random() - 0.5) * 0.6,
              ],
              rotation: [
                Math.random() * Math.PI * 2,
                Math.random() * Math.PI * 2,
                Math.random() * Math.PI * 2,
              ],
            });
          });
        }

        // Allow one frame for state → matrices to update
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);

        await doCapture();
        setStatus('busy', `Batch ${i + 1}/${total}`);
      }
      // Restore base settings
      useStore.getState().setCapture({
        camPos: baseCam,
        camTarget: baseTarget,
        fov: baseFov,
        lightIntensity: baseLight,
        envRotation: baseEnvRot,
      });
      setStatus('ok', `Batch complete: ${total} images`);
    } catch (e) {
      setStatus('err', `Batch error: ${(e as Error).message}`);
    }
  }

  return null;
}
