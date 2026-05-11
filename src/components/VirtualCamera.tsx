import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useStore, type Capture } from '../store/useStore';
import {
  buildBoundingBoxLabelsFile,
  captureFrame,
  makeFilename,
  saveBlob,
} from '../lib/capture';
import { BELT_TRANSPORTABLES, isOnBelt } from '../lib/beltDynamics';
import { applyRealismToBlob } from '../lib/realism';
import {
  createReadbackBlitState,
  ensureReadbackBlitState,
  putFlippedReadback,
} from '../lib/readbackBlit';
import { buildZipOffThread } from '../lib/zipWorkerClient';
import { canvasToFeatures } from '../lib/eiModel';

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
const INFERENCE_HZ = 5;
const INFERENCE_INTERVAL_MS = 1000 / INFERENCE_HZ;

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
  // Pixel + ImageData buffers for readback — reused across frames.
  const readback = useRef(createReadbackBlitState());
  const previewCtx = useRef<CanvasRenderingContext2D | null>(null);
  const previewCtxCanvas = useRef<HTMLCanvasElement | null>(null);
  const lastPreviewMs = useRef(0);
  const lastInferenceMs = useRef(0);
  const inferenceSignal = useStore((s) => s.inferenceSignal);
  const inferenceSignalRef = useRef(0);

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

    // Run live inference on the freshly-painted preview if requested. We
    // gate this both on the eiLive toggle (continuous) and on the
    // inferenceSignal (one-shot). Throttled separately from preview so a
    // chunky model doesn't drag the preview HZ down.
    const { eiLive, eiModel, eiModelInfo } = useStore.getState();
    const oneShot = inferenceSignal !== inferenceSignalRef.current;
    inferenceSignalRef.current = inferenceSignal;
    if (eiModel && eiModelInfo && (oneShot || eiLive)) {
      if (oneShot || now - lastInferenceMs.current >= INFERENCE_INTERVAL_MS) {
        lastInferenceMs.current = now;
        runInference();
      }
    }
  });

  function runInference() {
    if (!previewCanvas) return;
    const { eiModel, eiModelInfo, setEiResult, setStatus } = useStore.getState();
    if (!eiModel || !eiModelInfo) return;
    try {
      const features = canvasToFeatures(
        previewCanvas,
        eiModelInfo.inputWidth,
        eiModelInfo.inputHeight,
        eiModelInfo.isRgb,
      );
      const res = eiModel.classifier.classify(features);
      setEiResult(res);
    } catch (e) {
      setStatus('err', `Inference: ${(e as Error).message}`);
    }
  }

  function renderPreview() {
    if (!previewCanvas) return;
    if (previewCtxCanvas.current !== previewCanvas) {
      previewCtxCanvas.current = previewCanvas;
      previewCtx.current = previewCanvas.getContext('2d');
    }
    const ctx = previewCtx.current;
    if (!ctx) return;

    // Match the render target's size to the preview canvas (in CSS pixels).
    const w = previewCanvas.width;
    const h = previewCanvas.height;
    if (previewTarget.width !== w || previewTarget.height !== h) {
      previewTarget.setSize(w, h);
    }
    const pixels = ensureReadbackBlitState(readback.current, ctx, w, h);

    // Render the scene with the helper hidden so its frustum lines don't
    // crisscross the preview.
    const helper = helperRef.current;
    const helperWasVisible = helper?.visible ?? true;
    if (helper) helper.visible = false;

    const prevTarget = gl.getRenderTarget();
    try {
      gl.setRenderTarget(previewTarget);
      gl.clear();
      gl.render(scene, camera);
    } finally {
      gl.setRenderTarget(prevTarget);
      if (helper) helper.visible = helperWasVisible;
    }

    // Read back into a CPU buffer and blit to the 2D preview canvas.
    // WebGL textures are origin bottom-left, so we flip vertically when
    // putting into the canvas.
    gl.readRenderTargetPixels(previewTarget, 0, 0, w, h, pixels);
    putFlippedReadback(ctx, readback.current);
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

  async function doCapture(
    opts: { skipSave?: boolean } = {},
  ): Promise<Capture | null> {
    const cam = camera;
    if (!opts.skipSave) setStatus('busy', 'Capturing…');
    const helper = helperRef.current;
    const helperWasVisible = helper?.visible ?? true;
    try {
      const { width, height } = cameraSettings;
      // Hide helper for the capture too, so the frustum gizmo isn't burned
      // into the saved PNG.
      if (helper) helper.visible = false;

      const { blob: rawBlob, boxes } = await captureFrame({
        renderer: gl as THREE.WebGLRenderer,
        scene,
        camera: cam,
        width,
        height,
      });

      // Realism post-process — film grain + chromatic aberration +
      // vignette + color jitter to narrow the sim-to-real gap. Pure
      // pixel ops so bounding boxes stay valid against the result.
      // Falls through unchanged when mode is off (the common case).
      const realism = useStore.getState().realism;
      const blob = await applyRealismToBlob(rawBlob, realism);

      const idx = useStore.getState().captures.length;
      const labelPrefix =
        mode === 'anomaly' ? anomalyLabel || 'sample' : 'frame';
      const filename = makeFilename(labelPrefix, idx);

      const snapshot = useStore.getState();
      const sceneKinds = Array.from(
        new Set(
          snapshot.sceneObjects
            .filter((o) => o.owner == null)
            .map((o) => o.kind),
        ),
      );
      const assetSnapshot = snapshot.assets
        .filter((a) => a.owner == null)
        .map((a) => ({
          name: a.name,
          label: a.label,
        }));
      const captureRecord: Capture = {
        id: crypto.randomUUID(),
        filename,
        blob,
        boxes: mode === 'anomaly' ? [] : boxes,
        label: mode === 'anomaly' ? anomalyLabel : '',
        width,
        height,
        ts: Date.now(),
        shapes: sceneKinds,
        assetSnapshot,
      };
      addCapture(captureRecord);

      // Single-shot save: detection mode bundles the PNG with its
      // `bounding_boxes.labels` sidecar in a zip so the labels travel with
      // the image (Edge Impulse's uploader expects the sidecar adjacent to
      // the image). Anomaly mode has no boxes, so the bare PNG is enough —
      // the per-frame label is sent as metadata via the upload path.
      // Batch saves are zipped separately by `doBatch`.
      if (!opts.skipSave) {
        try {
          if (mode === 'detection') {
            const labelsBlob = new Blob(
              [buildBoundingBoxLabelsFile([captureRecord])],
              { type: 'application/json' },
            );
            const zipBlob = await buildZipOffThread([
              { name: filename, data: blob },
              { name: 'bounding_boxes.labels', data: labelsBlob },
            ]);
            const zipName = filename.replace(/\.png$/, '.zip');
            await saveBlob(zipName, zipBlob);
            setStatus('ok', `Captured ${zipName} (${boxes.length} boxes)`);
          } else {
            await saveBlob(filename, blob);
            setStatus('ok', `Captured ${filename}`);
          }
        } catch (e) {
          setStatus('err', `Save failed: ${(e as Error).message}`);
          return null;
        }
      }
      return captureRecord;
    } catch (e) {
      setStatus('err', `Capture error: ${(e as Error).message}`);
      return null;
    } finally {
      if (helper) helper.visible = helperWasVisible;
    }
  }

  async function doBatch() {
    const { capture: cs, sceneObjects, showConveyor } = useStore.getState();
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

    // Index from which the captures emitted by this batch begin — used to
    // slice them out of the store at the end and bundle into a single zip.
    const startIdx = useStore.getState().captures.length;
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
          // When the conveyor is on, drop the objects from above the belt
          // so we can wait for them to settle ON the belt before capturing.
          // Otherwise, jitter within a small radius of their original spots.
          if (showConveyor) {
            sceneObjects.forEach((o) => {
              updateSceneObject(o.id, {
                position: [
                  (Math.random() - 0.5) * 1.2, // belt is ~1.6m wide
                  1.6 + Math.random() * 0.4, // above belt top
                  (Math.random() - 0.5) * 6, // belt is 8m long
                ],
                rotation: [
                  Math.random() * Math.PI * 2,
                  Math.random() * Math.PI * 2,
                  Math.random() * Math.PI * 2,
                ],
              });
            });
          } else {
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
        }

        // Allow one frame for state → matrices to update
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);

        // When dropping randomized objects onto the conveyor, wait until
        // they've actually landed (and slowed) before capturing. Otherwise
        // the bounding boxes label objects mid-air, which isn't what the
        // user is trying to generate training data for.
        if (cs.randomizeObjects && showConveyor) {
          await waitForObjectsToSettle();
        }

        const capture = await doCapture({ skipSave: true });
        if (!capture) {
          throw new Error(`capture ${i + 1}/${total} failed`);
        }
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

      // Bundle the captures from this batch into a single zip and either
      // write it to the chosen save directory or download it.
      const allCaptures = useStore.getState().captures;
      const batchCaptures = allCaptures.slice(startIdx);
      if (batchCaptures.length > 0) {
        setStatus('busy', `Packaging zip (${batchCaptures.length})…`);
        const zipName = makeFilename(
          mode === 'anomaly' ? anomalyLabel || 'batch' : 'batch',
          startIdx,
          'zip',
        );
        const entries = batchCaptures.map((c) => ({
          name: c.filename,
          data: c.blob,
        }));
        // Detection mode includes the EI sidecar so the user can drop the
        // zip straight into the Studio uploader.
        if (mode === 'detection') {
          entries.push({
            name: 'bounding_boxes.labels',
            data: new Blob([buildBoundingBoxLabelsFile(batchCaptures)], {
              type: 'application/json',
            }),
          });
        }
        const zipBlob = await buildZipOffThread(entries);
        try {
          await saveBlob(zipName, zipBlob);
        } catch (e) {
          setStatus('err', `Save zip failed: ${(e as Error).message}`);
          return;
        }
        setStatus(
          'ok',
          `Batch complete: ${batchCaptures.length} images → ${zipName}`,
        );
      } else {
        setStatus('ok', `Batch complete: 0 images`);
      }
    } catch (e) {
      setStatus('err', `Batch error: ${(e as Error).message}`);
    }
  }

  /**
   * Block until all conveyor-tracked rigid bodies have either landed on the
   * belt or come to rest, or a timeout fires (2.5s). Polls per animation
   * frame so the renderer & physics solver keep ticking.
   *
   * "Settled" = on belt AND linear speed below threshold. We don't require
   * every body to satisfy this — falling into the gap or off the side is
   * legitimate state — so we declare the scene settled when no body is
   * still moving fast OR we hit the timeout.
   */
  async function waitForObjectsToSettle(): Promise<void> {
    const TIMEOUT_MS = 2500;
    const SPEED_THRESHOLD = 0.15; // m/s
    const start = performance.now();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise(requestAnimationFrame);
      let allRest = true;
      for (const body of BELT_TRANSPORTABLES) {
        const lv = body.linvel();
        const speed = Math.hypot(lv.x, lv.y, lv.z);
        if (speed > SPEED_THRESHOLD) {
          allRest = false;
          break;
        }
        const t = body.translation();
        // Bodies that fell off the edge are below belt level — count as
        // "settled" for the purposes of this wait.
        if (!isOnBelt(t) && t.y > 0.4) {
          allRest = false;
          break;
        }
      }
      if (allRest) return;
      if (performance.now() - start > TIMEOUT_MS) return;
    }
  }

  return null;
}
