import { useState } from 'react';
import {
  ALL_ROVER_EVENTS,
  ALL_ROVER_UPLOAD_MODALITIES,
  realismAverage,
  useStore,
  type AccelSample,
  type BoundingBox,
  type ImportedAsset,
  type LidarSample,
  type RealismConfig,
  type RobotKind,
  type RoverEvent,
  type RoverUploadModality,
  type SceneObject,
} from '../store/useStore';
import {
  ALL_ARM_TRAJECTORIES,
  type ArmTrajectory,
} from '../lib/armTrajectories';
import {
  buildArmPickupMetadata,
  type ArmPickupTargetMetadata,
} from '../lib/armPickupOutcome';
import { BRACCIO_LIMITS_RAD, BRACCIO_REST_RAD } from '../lib/braccio';
import { buildBoundingBoxLabelsFile, saveBlob } from '../lib/capture';
import { degToRad, radToDeg } from '../lib/math';
import {
  buildDataAcquisitionPayload,
  buildFileName,
  buildInfoLabelsEntry,
  buildInfoLabelsFile,
  buildLidarDataAcquisitionPayload,
  buildRoverDataAcquisitionPayload,
  getEiProjectDataKinds,
  listEiProjects,
  uploadImage,
  uploadLidarSample,
  uploadRoverSample,
  uploadSample,
  type EdgeImpulseInfoLabelsEntry,
} from '../lib/edgeImpulse';
import { awaitRobotCapture } from '../lib/robotCapture';
import { applyRealismToBlob, resetDiffusionBudget } from '../lib/realism';
import { buildArmRosJsonl, buildRoverRosJsonl } from '../lib/rosMessages';
import { useNumberInput } from '../lib/useNumberInput';
import { disposeUsdz } from '../lib/usdz';
import type { ZipEntry } from '../lib/zip';
import { buildZipOffThread } from '../lib/zipWorkerClient';
import { ChevronGlyph, CollapsibleCard } from './CollapsibleCard';
import { EiAuthCard } from './EiAuthCard';
import { EiInferenceCard } from './EiInferenceCard';
import { ImportedAssetsCard } from './ImportedAssetsCard';
import { ImuNoiseToggle } from './ImuNoiseToggle';
import { ToggleSwitch } from './ToggleSwitch';
import { RealismCard } from './RealismCard';
import { SceneObjectsCard } from './SceneObjectsCard';

const ROBOT_KINDS: { value: RobotKind; label: string; hint: string }[] = [
  { value: 'rover', label: 'Rover', hint: 'Chassis IMU + lidar / ToF ring' },
  {
    value: 'arm',
    label: 'Arm (Arduino Braccio)',
    hint: 'End-effector IMU, optional pick-and-place',
  },
];

function armAssetPlacement({
  assetIndex,
  maxDim,
}: {
  assetIndex: number;
  maxDim: number;
}) {
  const radius = 0.14;
  const angle = (assetIndex * 0.5 + 0.4) % (Math.PI * 2);
  return {
    position: [
      Math.sin(angle) * radius,
      0,
      Math.cos(angle) * radius,
    ] as [number, number, number],
    scale: 0.05 / Math.max(maxDim, 1e-6),
    physics: false,
  };
}

function roverAssetPlacement({
  assetIndex,
  maxDim,
}: {
  assetIndex: number;
  maxDim: number;
}) {
  const radius = 1.2;
  const angle = assetIndex * 1.15 + 0.7;
  let scale = 1;
  if (maxDim > 1.2) scale = 1.2 / maxDim;
  else if (maxDim < 0.2) scale = 0.3 / maxDim;
  return {
    position: [
      Math.sin(angle) * radius,
      0,
      Math.cos(angle) * radius,
    ] as [number, number, number],
    scale,
    physics: false,
  };
}

type ArmTargetState = {
  armTargetId: string | null;
  sceneObjects: SceneObject[];
  assets: ImportedAsset[];
};

function summarizeArmTarget(state: ArmTargetState): ArmPickupTargetMetadata {
  const id = state.armTargetId;
  if (!id) return { id: null, type: 'fallback' };
  const sceneTarget = state.sceneObjects.find(
    (o) => o.id === id && o.owner === 'arm',
  );
  if (sceneTarget) {
    return {
      id,
      type: 'primitive',
      kind: sceneTarget.kind,
      label: sceneTarget.label,
    };
  }
  const assetTarget = state.assets.find(
    (a) => a.id === id && a.owner === 'arm',
  );
  if (assetTarget) {
    return {
      id,
      type: 'asset',
      name: assetTarget.name,
      label: assetTarget.label,
    };
  }
  return { id, type: 'unknown' };
}

/** Flatten the realism config into the EI image-metadata envelope.
 * One field per knob so a downstream ablation can group / filter by
 * exact transform intensity, plus a `realism_intensity` average for
 * backward compatibility with datasets uploaded before the split. */
function realismMeta(
  r: RealismConfig,
): Record<string, number | string | boolean> {
  if (r.mode === 'off') {
    return { realism_mode: 'off', realism_intensity: 0 };
  }
  return {
    realism_mode: r.mode,
    realism_intensity: realismAverage(r),
    realism_grain: r.grain,
    realism_chromatic: r.chromatic,
    realism_vignette: r.vignette,
    realism_jitter: r.jitter,
    realism_jpeg: r.jpeg,
    realism_randomize: r.randomize,
  };
}

class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

/**
 * Routing decision for an object-detection-enabled run: which stream
 * gets uploaded to Edge Impulse, which gets downloaded locally.
 *
 * `imageDest === sensorDest === 'upload'` is allowed: an empty project
 * or one that already contains both kinds of data can accept both. The
 * conflict cases (image-only project, time-series-only project) split
 * the destinations.
 */
type ObjectDetectionRouting = {
  imageDest: 'upload' | 'download';
  sensorDest: 'upload' | 'download';
  /** Human-readable rationale shown in the status bar before the run
   * starts, so the user knows up-front where each stream will land. */
  rationale: string;
};

/**
 * Resolve the project ID to probe. Project-scoped API keys (the common
 * case) only ever expose one project — we use it implicitly. Multi-
 * project keys would need a Studio picker; for now we fall back to the
 * first project and surface a warning in the rationale, since the
 * RobotPanel doesn't yet host a project selector.
 */
async function resolveEiProjectId(
  apiKey: string,
): Promise<{ id: number; name: string } | null> {
  try {
    const projects = await listEiProjects(apiKey);
    if (projects.length === 0) return null;
    return { id: projects[0].id, name: projects[0].name };
  } catch {
    return null;
  }
}

/**
 * Probe the EI project and confirm with the user how the two streams
 * (image + sensor) should be routed. Mutually-exclusive project types
 * (image-only or time-series-only) trigger a confirm dialog explaining
 * which stream will be downloaded locally instead of uploaded.
 *
 * Returns `null` if the user cancels.
 */
async function decideObjectDetectionRouting(opts: {
  apiKey: string;
}): Promise<ObjectDetectionRouting | null> {
  const project = await resolveEiProjectId(opts.apiKey);
  if (!project) {
    // No project ID — either the key is invalid or the user has no
    // accessible projects. Fall back to upload-both; the actual EI
    // upload call will surface the credential error per-sample.
    return {
      imageDest: 'upload',
      sensorDest: 'upload',
      rationale: 'Could not resolve EI project — uploading both streams blindly.',
    };
  }
  let kinds: { hasImages: boolean; hasTimeSeries: boolean; totalChecked: number };
  try {
    kinds = await getEiProjectDataKinds(opts.apiKey, project.id);
  } catch (e) {
    return {
      imageDest: 'upload',
      sensorDest: 'upload',
      rationale: `Could not probe ${project.name}: ${(e as Error).message}. Uploading both.`,
    };
  }
  if (kinds.totalChecked === 0) {
    // Empty project — anything goes. Default to upload-both so the
    // user can pick a path in the Studio afterward.
    return {
      imageDest: 'upload',
      sensorDest: 'upload',
      rationale: `${project.name} is empty — uploading both streams.`,
    };
  }
  if (kinds.hasImages && !kinds.hasTimeSeries) {
    const ok = window.confirm(
      `Edge Impulse project "${project.name}" contains image data, not time-series.\n\n` +
        `• Images (with bounding boxes) will be uploaded to the project.\n` +
        `• Sensor data (IMU${'lidar'.length ? '/lidar' : ''}) will be saved as a local zip.\n\n` +
        `Continue?`,
    );
    if (!ok) return null;
    return {
      imageDest: 'upload',
      sensorDest: 'download',
      rationale: `${project.name} accepts images only — sensor data → local zip.`,
    };
  }
  if (kinds.hasTimeSeries && !kinds.hasImages) {
    const ok = window.confirm(
      `Edge Impulse project "${project.name}" contains time-series sensor data, not images.\n\n` +
        `• Sensor data will be uploaded to the project.\n` +
        `• Images (with bounding boxes) will be saved as a local zip.\n\n` +
        `Continue?`,
    );
    if (!ok) return null;
    return {
      imageDest: 'download',
      sensorDest: 'upload',
      rationale: `${project.name} accepts time-series only — images → local zip.`,
    };
  }
  // Project already mixes both kinds (rare but valid) — upload both.
  return {
    imageDest: 'upload',
    sensorDest: 'upload',
    rationale: `${project.name} contains both image and sensor data — uploading both.`,
  };
}

/**
 * Trigger the in-canvas POV-camera bridge to snap a frame and resolve
 * with the resulting blob + bounding boxes. Returns `null` if the bridge
 * isn't mounted or the capture failed.
 */
async function captureRobotFrame(): Promise<{
  blob: Blob;
  boxes: BoundingBox[];
  width: number;
  height: number;
} | null> {
  const promise = awaitRobotCapture();
  useStore.getState().triggerRobotCapture();
  // Bridge resolves within one or two animation frames. Cap the wait
  // so we don't hang the runner if the canvas isn't mounted.
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), 2000),
  );
  return Promise.race([promise, timeout]);
}

/** EI bounding-box filename suffix. Detection mode uses `.png`; we
 *  follow the same convention so the sidecar file resolves correctly. */
function imageFileName(stem: string, idx: number, suffix = ''): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const safe = (stem || 'capture').replace(/[^a-zA-Z0-9_-]/g, '_');
  const idxStr = String(idx).padStart(4, '0');
  return `${safe}${suffix ? `_${suffix}` : ''}.${ts}.${idxStr}.png`;
}

export function RobotPanel() {
  const robot = useStore((s) => s.robot);
  const setRobot = useStore((s) => s.setRobot);
  const robotRunning = useStore((s) => s.robotRunning);
  const setRobotRunning = useStore((s) => s.setRobotRunning);
  const setRobotCancelRequested = useStore((s) => s.setRobotCancelRequested);
  const bumpRoverEpoch = useStore((s) => s.bumpRoverEpoch);
  const bumpArmEpoch = useStore((s) => s.bumpArmEpoch);
  const bumpRobotCaptures = useStore((s) => s.bumpRobotCaptures);
  const resetRobotCaptures = useStore((s) => s.resetRobotCaptures);
  const clearLidarSamples = useStore((s) => s.clearLidarSamples);
  const clearRobotImuSamples = useStore((s) => s.clearRobotImuSamples);
  const setRoverPose = useStore((s) => s.setRoverPose);
  const setArmJoints = useStore((s) => s.setArmJoints);
  const setArmTargetId = useStore((s) => s.setArmTargetId);
  const resetRobotScene = useStore((s) => s.resetRobotScene);
  const assets = useStore((s) => s.assets);
  const removeAsset = useStore((s) => s.removeAsset);
  const ei = useStore((s) => s.ei);
  const status = useStore((s) => s.status);
  const setStatus = useStore((s) => s.setStatus);
  const lidarSampleCount = useStore((s) => s.lidarSamples.length);
  const imuSampleCount = useStore((s) => s.robotImuSamples.length);

  const countInput = useNumberInput(
    robot.count,
    (n) => setRobot({ count: n }),
    { min: 1, max: 200 },
  );
  const durationInput = useNumberInput(
    robot.durationMs,
    (n) => setRobot({ durationMs: n }),
    { min: 500, max: 15000 },
  );

  /** Sleep that polls the cancel flag at ~50 ms so the Stop button
   * unwinds the runner mid-iteration instead of waiting out a full
   * `durationMs` window. Throws `CancelledError` immediately on the
   * next poll after the user clicks Stop. */
  const sleepCancellable = async (ms: number): Promise<void> => {
    const deadline = performance.now() + ms;
    while (true) {
      if (useStore.getState().robotCancelRequested) throw new CancelledError();
      const remaining = deadline - performance.now();
      if (remaining <= 0) return;
      await new Promise<void>((r) =>
        setTimeout(r, Math.min(50, remaining)),
      );
    }
  };

  const onRunRover = async () => {
    const runEi = { ...ei, apiKey: ei.apiKey.trim() };
    const shouldUpload = runEi.apiKey.length > 0;
    const event: RoverEvent = robot.roverEvent;
    const objectDetection = robot.objectDetection;
    const captureAtRest = robot.captureAtRest;
    setRobotCancelRequested(false);
    // Probe the EI project up-front so the user confirms the routing
    // before the procedural run kicks off (and before any capture work
    // hits the canvas). When not uploading or not in object-detection
    // mode, both streams default to the same destination.
    let routing: ObjectDetectionRouting = {
      imageDest: shouldUpload ? 'upload' : 'download',
      sensorDest: shouldUpload ? 'upload' : 'download',
      rationale: '',
    };
    if (objectDetection && shouldUpload) {
      setStatus('busy', 'Checking Edge Impulse project data type…');
      const decided = await decideObjectDetectionRouting({
        apiKey: runEi.apiKey,
      });
      if (!decided) {
        setStatus('idle', 'Run cancelled');
        return;
      }
      routing = decided;
      setStatus('busy', routing.rationale);
    }
    setRobotRunning(true);
    resetRobotCaptures();
    resetDiffusionBudget();
    let uploaded = 0;
    let captured = 0;
    let failed = 0;
    let cancelled = false;
    let imagesUploaded = 0;
    let imagesDownloaded = 0;
    const zipEntries: ZipEntry[] = [];
    const infoLabelsEntries: EdgeImpulseInfoLabelsEntry[] = [];
    // Local-only image collection — fed into the zip when imageDest === 'download'.
    const imageCaptures: {
      filename: string;
      blob: Blob;
      boxes: BoundingBox[];
      width: number;
      height: number;
    }[] = [];
    const finalizeRoverRun = async (headline: string) => {
      // Assemble one zip containing everything that needs to land on
      // disk: sensor data (when sensorDest === 'download'), info.labels,
      // ROS JSONL (always, since no upload endpoint), and image PNGs +
      // their bounding-box sidecar (when imageDest === 'download').
      const entries: ZipEntry[] = [...zipEntries];
      if (infoLabelsEntries.length > 0) {
        entries.push({
          name: 'info.labels',
          data: buildInfoLabelsFile(infoLabelsEntries),
        });
      }
      for (const c of imageCaptures) {
        entries.push({ name: c.filename, data: c.blob });
      }
      if (imageCaptures.length > 0) {
        entries.push({
          name: 'bounding_boxes.labels',
          data: buildBoundingBoxLabelsFile(
            imageCaptures.map((c) => ({
              id: c.filename,
              filename: c.filename,
              blob: c.blob,
              boxes: c.boxes,
              label: '',
              width: c.width,
              height: c.height,
              ts: Date.now(),
            })),
          ),
        });
      }
      const parts: string[] = [];
      if (uploaded > 0) parts.push(`${uploaded} sensor uploaded`);
      if (captured > 0) parts.push(`${captured} sensor zipped`);
      if (imagesUploaded > 0) parts.push(`${imagesUploaded} images uploaded`);
      if (imagesDownloaded > 0) parts.push(`${imagesDownloaded} images zipped`);
      if (failed > 0) parts.push(`${failed} failed`);
      if (entries.length > 0) {
        setStatus('busy', `Packaging ${entries.length} files…`);
        const zipName = buildFileName(
          `rover_${event}_${entries.length}`,
        ).replace(/\.json$/, '.zip');
        const zip = await buildZipOffThread(entries);
        await saveBlob(zipName, zip);
        parts.push('zip saved');
      }
      if (parts.length === 0) {
        setStatus('err', `${headline}: no samples captured`);
      } else {
        setStatus(
          cancelled || failed > 0 ? 'err' : 'ok',
          `${headline}: ${parts.join(' · ')}`,
        );
      }
    };

    /** Capture one frame via the in-canvas POV-camera bridge and route
     * it according to `routing.imageDest`. Filename suffix differentiates
     * the at-rest vs in-motion shot. */
    const captureAndRouteImage = async (
      iterIdx: number,
      phase: 'rest' | 'motion',
    ): Promise<void> => {
      const cap = await captureRobotFrame();
      if (!cap) {
        failed += 1;
        return;
      }
      // Apply the realism post-process pass (no-op when mode === 'off').
      // Pixel-level transforms preserve geometry, so cap.boxes are
      // still valid against the processed blob.
      const realism = useStore.getState().realism;
      const blob = await applyRealismToBlob(cap.blob, {
        mode: realism.mode,
        intensities: realism,
        randomize: realism.randomize,
      });
      const filename = imageFileName(
        `rover_${event}`,
        iterIdx + 1,
        phase,
      );
      const imageMeta = {
        mode: 'robot',
        robot_kind: 'rover',
        event,
        event_index: iterIdx + 1,
        event_total: robot.count,
        capture_phase: phase,
        capture_width: cap.width,
        capture_height: cap.height,
        ...realismMeta(realism),
      };
      if (routing.imageDest === 'upload') {
        try {
          const res = await uploadImage(
            { ...runEi, label: event },
            blob,
            filename,
            event,
            cap.boxes,
            imageMeta,
          );
          if (res.ok) {
            imagesUploaded += 1;
            bumpRobotCaptures();
          } else failed += 1;
        } catch {
          failed += 1;
        }
      } else {
        imageCaptures.push({
          filename,
          blob,
          boxes: cap.boxes,
          width: cap.width,
          height: cap.height,
        });
        imagesDownloaded += 1;
        bumpRobotCaptures();
      }
    };

    try {
      await sleepCancellable(60);
      for (let i = 0; i < robot.count; i++) {
        setStatus(
          'busy',
          `${i + 1}/${robot.count} ${event}: building path…`,
        );
        // Object-detection capture: at rest the rover is stationary, so
        // multiple shots would be near-identical — pin to 1. In motion
        // the rover's pose changes, so we honor `imagesPerIteration`
        // and space the shots evenly across the recording window.
        const imagesPerIteration = objectDetection
          ? captureAtRest
            ? 1
            : Math.max(1, robot.objectDetectionImagesPerIteration)
          : 0;
        if (objectDetection && captureAtRest) {
          await captureAndRouteImage(i, 'rest');
        }
        clearLidarSamples();
        clearRobotImuSamples();
        bumpRoverEpoch();
        if (objectDetection && !captureAtRest) {
          // Slice the window into `imagesPerIteration + 1` segments
          // and fire one capture between each segment, so no shot
          // lands at t=0 or t=duration (both of which look static).
          const segments = imagesPerIteration + 1;
          const slice = Math.max(1, Math.floor(robot.durationMs / segments));
          let consumed = 0;
          for (let k = 0; k < imagesPerIteration; k++) {
            await sleepCancellable(slice);
            consumed += slice;
            await captureAndRouteImage(i, 'motion');
          }
          await sleepCancellable(Math.max(0, robot.durationMs - consumed));
        } else {
          await sleepCancellable(robot.durationMs);
        }
        const lidar: LidarSample[] = useStore
          .getState()
          .lidarSamples.slice();
        const imu: AccelSample[] = useStore
          .getState()
          .robotImuSamples.slice();
        clearLidarSamples();
        clearRobotImuSamples();
        if (imu.length === 0 && lidar.length === 0) {
          failed += 1;
          continue;
        }
        const modality: RoverUploadModality = robot.uploadModality;
        // For modality === 'imu', we still want enough IMU rows to be
        // a usable sample; same for 'lidar'. The fused builder pairs
        // them by index and trims to the shorter array, but the
        // single-modality builders reject when their array is empty.
        if (modality === 'fused' && (imu.length === 0 || lidar.length === 0)) {
          failed += 1;
          continue;
        }
        if (modality === 'imu' && imu.length === 0) {
          failed += 1;
          continue;
        }
        if (modality === 'lidar' && lidar.length === 0) {
          failed += 1;
          continue;
        }
        const fileName = buildFileName(`${event}_${modality}_${i + 1}`);
        const sampleRateHz = 20;
        const meta = {
          mode: 'robot',
          robot_kind: 'rover',
          event,
          event_index: i + 1,
          event_total: robot.count,
          modality,
          lidar_bins: robot.lidarBins,
          lidar_max_range_m: robot.lidarMaxRange,
          duration_ms: robot.durationMs,
        };
        if (routing.sensorDest === 'upload') {
          try {
            let res;
            if (modality === 'fused') {
              res = await uploadRoverSample(
                { ...runEi, label: event },
                imu,
                lidar,
                sampleRateHz,
                robot.lidarMaxRange,
                fileName,
                meta,
              );
            } else if (modality === 'imu') {
              res = await uploadSample(
                { ...runEi, label: event },
                imu,
                sampleRateHz,
                fileName,
                meta,
              );
            } else {
              res = await uploadLidarSample(
                { ...runEi, label: event },
                lidar,
                sampleRateHz,
                robot.lidarMaxRange,
                fileName,
                meta,
              );
            }
            if (res.ok) {
              uploaded += 1;
              bumpRobotCaptures();
            } else failed += 1;
          } catch {
            failed += 1;
          }
        } else {
          let body: unknown;
          if (modality === 'fused') {
            body = await buildRoverDataAcquisitionPayload(
              runEi,
              imu,
              lidar,
              sampleRateHz,
              robot.lidarMaxRange,
            );
          } else if (modality === 'imu') {
            body = await buildDataAcquisitionPayload(runEi, imu, sampleRateHz);
          } else {
            body = await buildLidarDataAcquisitionPayload(
              runEi,
              lidar,
              sampleRateHz,
              robot.lidarMaxRange,
            );
          }
          zipEntries.push({
            name: fileName,
            data: JSON.stringify(body, null, 2),
          });
          infoLabelsEntries.push(
            buildInfoLabelsEntry({
              path: fileName,
              category: runEi.category,
              label: event,
              metadataExtras: meta,
            }),
          );
          captured += 1;
          bumpRobotCaptures();
        }
        if (robot.rosExport) {
          // Each iteration becomes one rosbag.jsonl. The runner
          // doesn't have direct access to the per-frame pose
          // history, so odometry is omitted; downstream consumers
          // can dead-reckon from the IMU. (Adding a pose log
          // would mean a new sample stream — left for a follow-up.)
          const jsonl = buildRoverRosJsonl({
            imu,
            lidar,
            lidarMaxRange: robot.lidarMaxRange,
          });
          const rosName = fileName.replace(/\.json$/, '.rosbag.jsonl');
          if (shouldUpload) {
            // No ROS endpoint to upload to — write the JSONL into
            // a parallel zip alongside the EI uploads.
            zipEntries.push({ name: rosName, data: jsonl });
          } else {
            zipEntries.push({ name: rosName, data: jsonl });
          }
        }
        setStatus(
          'busy',
          `Rover ${i + 1}/${robot.count}: ` +
            [
              uploaded > 0 && `${uploaded} sensor up`,
              captured > 0 && `${captured} sensor zip`,
              imagesUploaded > 0 && `${imagesUploaded} img up`,
              imagesDownloaded > 0 && `${imagesDownloaded} img zip`,
              failed > 0 && `${failed} failed`,
            ]
              .filter(Boolean)
              .join(' · '),
        );
      }
      await finalizeRoverRun('Rover run complete');
    } catch (e) {
      if (e instanceof CancelledError) {
        cancelled = true;
        try {
          await finalizeRoverRun('Rover run stopped');
        } catch (saveError) {
          setStatus(
            'err',
            `Rover run stopped, but saving partial data failed: ${(saveError as Error).message}`,
          );
        }
      } else {
        setStatus('err', `Rover error: ${(e as Error).message}`);
      }
    } finally {
      setRobotRunning(false);
      setRobotCancelRequested(false);
      setRoverPose(null);
    }
  };

  const onRunArm = async () => {
    const runEi = { ...ei, apiKey: ei.apiKey.trim() };
    const shouldUpload = runEi.apiKey.length > 0;
    const trajectory: ArmTrajectory = robot.armTrajectory;
    const objectDetection = robot.objectDetection;
    const captureAtRest = robot.captureAtRest;
    setRobotCancelRequested(false);
    let routing: ObjectDetectionRouting = {
      imageDest: shouldUpload ? 'upload' : 'download',
      sensorDest: shouldUpload ? 'upload' : 'download',
      rationale: '',
    };
    if (objectDetection && shouldUpload) {
      setStatus('busy', 'Checking Edge Impulse project data type…');
      const decided = await decideObjectDetectionRouting({
        apiKey: runEi.apiKey,
      });
      if (!decided) {
        setStatus('idle', 'Run cancelled');
        return;
      }
      routing = decided;
      setStatus('busy', routing.rationale);
    }
    setRobotRunning(true);
    resetRobotCaptures();
    resetDiffusionBudget();
    let uploaded = 0;
    let captured = 0;
    let failed = 0;
    let cancelled = false;
    let imagesUploaded = 0;
    let imagesDownloaded = 0;
    const zipEntries: ZipEntry[] = [];
    const infoLabelsEntries: EdgeImpulseInfoLabelsEntry[] = [];
    const imageCaptures: {
      filename: string;
      blob: Blob;
      boxes: BoundingBox[];
      width: number;
      height: number;
    }[] = [];
    const finalizeArmRun = async (headline: string) => {
      const entries: ZipEntry[] = [...zipEntries];
      if (infoLabelsEntries.length > 0) {
        entries.push({
          name: 'info.labels',
          data: buildInfoLabelsFile(infoLabelsEntries),
        });
      }
      for (const c of imageCaptures) {
        entries.push({ name: c.filename, data: c.blob });
      }
      if (imageCaptures.length > 0) {
        entries.push({
          name: 'bounding_boxes.labels',
          data: buildBoundingBoxLabelsFile(
            imageCaptures.map((c) => ({
              id: c.filename,
              filename: c.filename,
              blob: c.blob,
              boxes: c.boxes,
              label: '',
              width: c.width,
              height: c.height,
              ts: Date.now(),
            })),
          ),
        });
      }
      const parts: string[] = [];
      if (uploaded > 0) parts.push(`${uploaded} sensor uploaded`);
      if (captured > 0) parts.push(`${captured} sensor zipped`);
      if (imagesUploaded > 0) parts.push(`${imagesUploaded} images uploaded`);
      if (imagesDownloaded > 0) parts.push(`${imagesDownloaded} images zipped`);
      if (failed > 0) parts.push(`${failed} failed`);
      if (entries.length > 0) {
        setStatus('busy', `Packaging ${entries.length} files…`);
        const zipName = buildFileName(
          `arm_${trajectory}_${entries.length}`,
        ).replace(/\.json$/, '.zip');
        const zip = await buildZipOffThread(entries);
        await saveBlob(zipName, zip);
        parts.push('zip saved');
      }
      if (parts.length === 0) {
        setStatus('err', `${headline}: no samples captured`);
      } else {
        setStatus(
          cancelled || failed > 0 ? 'err' : 'ok',
          `${headline}: ${parts.join(' · ')}`,
        );
      }
    };
    const captureAndRouteImage = async (
      iterIdx: number,
      phase: 'rest' | 'motion',
    ): Promise<void> => {
      const cap = await captureRobotFrame();
      if (!cap) {
        failed += 1;
        return;
      }
      const realism = useStore.getState().realism;
      const blob = await applyRealismToBlob(cap.blob, {
        mode: realism.mode,
        intensities: realism,
        randomize: realism.randomize,
      });
      const filename = imageFileName(
        `arm_${trajectory}`,
        iterIdx + 1,
        phase,
      );
      const imageMeta = {
        mode: 'robot',
        robot_kind: 'arm',
        trajectory,
        trajectory_index: iterIdx + 1,
        trajectory_total: robot.count,
        capture_phase: phase,
        capture_width: cap.width,
        capture_height: cap.height,
        ...realismMeta(realism),
      };
      if (routing.imageDest === 'upload') {
        try {
          const res = await uploadImage(
            { ...runEi, label: trajectory },
            blob,
            filename,
            trajectory,
            cap.boxes,
            imageMeta,
          );
          if (res.ok) {
            imagesUploaded += 1;
            bumpRobotCaptures();
          } else failed += 1;
        } catch {
          failed += 1;
        }
      } else {
        imageCaptures.push({
          filename,
          blob,
          boxes: cap.boxes,
          width: cap.width,
          height: cap.height,
        });
        imagesDownloaded += 1;
        bumpRobotCaptures();
      }
    };
    try {
      await sleepCancellable(60);
      for (let i = 0; i < robot.count; i++) {
        // For pick_place, pick a random scene object as the pickup
        // target so the IK keyframes anchor on something visible. Both
        // primitive scene objects and imported USDZ assets participate.
        // If there are no arm-owned objects, the controller falls back
        // to a stock placeholder pickup point.
        if (trajectory === 'pick_place') {
          const state = useStore.getState();
          const candidates = [
            ...state.sceneObjects.filter((o) => o.owner === 'arm'),
            ...state.assets.filter((a) => a.owner === 'arm'),
          ];
          if (candidates.length > 0) {
            const pick =
              candidates[Math.floor(Math.random() * candidates.length)];
            setArmTargetId(pick.id);
          } else {
            setArmTargetId(null);
          }
        }
        const selectedTargetId = useStore.getState().armTargetId;
        useStore
          .getState()
          .resetArmPickupObservation(
            trajectory === 'pick_place' ? selectedTargetId : null,
          );
        setStatus(
          'busy',
          `${i + 1}/${robot.count} ${trajectory}: building trajectory…`,
        );
        // At rest the arm is stationary — pin to one image. In motion
        // mode we honor the user's count and space shots evenly across
        // the recording window.
        const imagesPerIteration = objectDetection
          ? captureAtRest
            ? 1
            : Math.max(1, robot.objectDetectionImagesPerIteration)
          : 0;
        if (objectDetection && captureAtRest) {
          await captureAndRouteImage(i, 'rest');
        }
        clearRobotImuSamples();
        useStore.getState().clearArmJointSamples();
        bumpArmEpoch();
        if (objectDetection && !captureAtRest) {
          const segments = imagesPerIteration + 1;
          const slice = Math.max(1, Math.floor(robot.durationMs / segments));
          let consumed = 0;
          for (let k = 0; k < imagesPerIteration; k++) {
            await sleepCancellable(slice);
            consumed += slice;
            await captureAndRouteImage(i, 'motion');
          }
          await sleepCancellable(Math.max(0, robot.durationMs - consumed));
        } else {
          await sleepCancellable(robot.durationMs);
        }
        const stateAfterRun = useStore.getState();
        const imu: AccelSample[] = stateAfterRun.robotImuSamples.slice();
        const armJoints = stateAfterRun.armJointSamples.slice();
        const armTarget = summarizeArmTarget(stateAfterRun);
        const pickupObservation = stateAfterRun.armPickupObservation;
        clearRobotImuSamples();
        useStore.getState().clearArmJointSamples();
        if (imu.length === 0) {
          failed += 1;
          continue;
        }
        const fileName = buildFileName(`${trajectory}_${i + 1}`);
        const meta = {
          mode: 'robot',
          robot_kind: 'arm',
          trajectory,
          trajectory_index: i + 1,
          trajectory_total: robot.count,
          duration_ms: robot.durationMs,
          arm_target_id: armTarget.id ?? '',
          ...buildArmPickupMetadata(
            trajectory,
            armTarget,
            pickupObservation,
          ),
        };
        if (routing.sensorDest === 'upload') {
          try {
            const res = await uploadSample(
              { ...runEi, label: trajectory },
              imu,
              20,
              fileName,
              meta,
            );
            if (res.ok) {
              uploaded += 1;
              bumpRobotCaptures();
            } else failed += 1;
          } catch {
            failed += 1;
          }
        } else {
          const body = await buildDataAcquisitionPayload(runEi, imu, 20);
          zipEntries.push({
            name: fileName,
            data: JSON.stringify(body, null, 2),
          });
          infoLabelsEntries.push(
            buildInfoLabelsEntry({
              path: fileName,
              category: runEi.category,
              label: trajectory,
              metadataExtras: meta,
            }),
          );
          captured += 1;
          bumpRobotCaptures();
        }
        if (robot.rosExport) {
          // Bundle end-effector IMU + joint-state stream into a ROS 2
          // JSONL. Same per-iteration filename pattern the rover path
          // uses so downstream replayers can treat both robots
          // uniformly.
          const jsonl = buildArmRosJsonl({ imu, joints: armJoints });
          const rosName = fileName.replace(/\.json$/, '.rosbag.jsonl');
          zipEntries.push({ name: rosName, data: jsonl });
        }
        setStatus(
          'busy',
          `Arm ${i + 1}/${robot.count}: ` +
            [
              uploaded > 0 && `${uploaded} sensor up`,
              captured > 0 && `${captured} sensor zip`,
              imagesUploaded > 0 && `${imagesUploaded} img up`,
              imagesDownloaded > 0 && `${imagesDownloaded} img zip`,
              failed > 0 && `${failed} failed`,
            ]
              .filter(Boolean)
              .join(' · '),
        );
      }
      await finalizeArmRun('Arm run complete');
    } catch (e) {
      if (e instanceof CancelledError) {
        cancelled = true;
        try {
          await finalizeArmRun('Arm run stopped');
        } catch (saveError) {
          setStatus(
            'err',
            `Arm run stopped, but saving partial data failed: ${(saveError as Error).message}`,
          );
        }
      } else {
        setStatus('err', `Arm error: ${(e as Error).message}`);
      }
    } finally {
      setRobotRunning(false);
      setRobotCancelRequested(false);
      setArmJoints(null);
      setArmTargetId(null);
      useStore.getState().resetArmPickupObservation(null);
    }
  };

  const onRun = () => {
    if (robot.kind === 'rover') void onRunRover();
    else void onRunArm();
  };

  const onResetRobotScene = () => {
    for (const asset of assets.filter((a) => a.owner === robot.kind)) {
      disposeUsdz(asset.object, asset.handle ?? undefined);
      removeAsset(asset.id);
    }
    resetRobotScene();
  };

  const hasApiKey = ei.apiKey.trim().length > 0;

  return (
    <>
      <CollapsibleCard heading="Robot" defaultOpen>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 4,
          }}
        >
          {ROBOT_KINDS.map((k) => (
            <button
              key={k.value}
              className={robot.kind === k.value ? 'primary' : ''}
              onClick={() => setRobot({ kind: k.value })}
              title={k.hint}
              disabled={robotRunning}
              style={{ padding: '8px 4px', fontSize: 11 }}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {ROBOT_KINDS.find((k) => k.value === robot.kind)?.hint}
        </div>
        <div className="row">
          <button
            type="button"
            onClick={onResetRobotScene}
            disabled={robotRunning}
            title="Regenerate the obstacle field, clear the rover pose and any in-flight recording."
          >
            ↺ Reset scene
          </button>
        </div>
      </CollapsibleCard>

      {robot.kind === 'rover' ? (
        <CollapsibleCard heading="Event" defaultOpen>
          <div
            className="motion-pills trajectory-pills"
            role="radiogroup"
            aria-label="Rover event"
          >
            {ALL_ROVER_EVENTS.map((kind) => (
              <label
                key={kind}
                className={`motion-pill ${robot.roverEvent === kind ? 'on' : ''}`}
              >
                <input
                  type="radio"
                  name="rover-event"
                  value={kind}
                  checked={robot.roverEvent === kind}
                  disabled={robotRunning}
                  onChange={() => setRobot({ roverEvent: kind })}
                />
                {kind.replace(/_/g, ' ')}
              </label>
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            {robot.roverEvent === 'cruise' &&
              'Drive cleanly through the obstacle field, no contact.'}
            {robot.roverEvent === 'collision' &&
              'Aim straight at an obstacle; bumper-style impact mid-window.'}
            {robot.roverEvent === 'stuck' &&
              'Pin a wheel against an obstacle; vibrate without translation.'}
          </div>
        </CollapsibleCard>
      ) : (
        <CollapsibleCard heading="Trajectory" defaultOpen>
          <ArmTrajectoryPicker
            value={robot.armTrajectory}
            onChange={(t) => setRobot({ armTrajectory: t })}
            disabled={robotRunning}
          />
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            {robot.armTrajectory === 'pick_place' &&
              'Approach a scene object, grasp, lift, place at a destination.'}
            {robot.armTrajectory === 'sweep' &&
              'Base servo sweeps left/right at a fixed shoulder/elbow.'}
            {robot.armTrajectory === 'wave' &&
              'Wrist-pitch oscillation; clean gyro signature.'}
            {robot.armTrajectory === 'random_pose' &&
              'Interpolate between two random reachable joint vectors.'}
            {robot.armTrajectory === 'draw_circle' &&
              'End-effector traces a horizontal circle via planar IK.'}
          </div>
        </CollapsibleCard>
      )}

      {robot.kind === 'arm' && (
        <ArmHomePoseCard disabled={robotRunning} />
      )}

      {robot.kind === 'arm' && (
        <ArmCameraMountCard disabled={robotRunning} />
      )}

      {robot.kind === 'arm' && (
        <SceneObjectsCard
          title={
            robot.armTrajectory === 'pick_place' ? 'Pickup objects' : 'Scene props'
          }
          addCustom={(kind, label) =>
            useStore.getState().addArmPickupTarget(kind, label)
          }
          sizeRange={{ min: 0.02, max: 0.2, step: 0.005 }}
          defaultLabel={robot.armTrajectory === 'pick_place' ? 'pickup' : 'prop'}
          helpText={
            robot.armTrajectory === 'pick_place'
              ? 'The runner picks one as the IK anchor each iteration. Drag to retarget; toggle physics to let the gripper actually push the object around.'
              : 'Scenery for the POV camera; only pick_place actually interacts with them.'
          }
          disabled={robotRunning}
          ownerFilter="arm"
          footer={
            robot.armTrajectory === 'pick_place' ? (
              // Lives inside the pickup-objects card so the toggle that
              // *acts on* those objects sits next to the list, not as a
              // floating card below.
              <div style={{ marginTop: 8 }}>
                <ToggleSwitch
                  title="Randomize pickup position"
                  help="Re-sample each pickup object to a fresh random position inside the Braccio's reach at the start of every iteration. Generates varied IMU traces without dragging the cube around by hand."
                  on={robot.armRandomizeTarget}
                  disabled={robotRunning}
                  onChange={(next) => {
                    setRobot({ armRandomizeTarget: next });
                    // Flipping the switch on should give immediate
                    // visual feedback — randomize once now so the user
                    // can see the pickups hop to fresh positions
                    // before the next run bumps the armEpoch.
                    if (next) {
                      useStore.getState().randomizeArmPickupPositions();
                    }
                  }}
                />
              </div>
            ) : undefined
          }
        />
      )}

      {robot.kind === 'arm' && (
        <ImportedAssetsCard
          ownerFilter="arm"
          title={
            robot.armTrajectory === 'pick_place'
              ? 'Imported pickups'
              : 'Imported props'
          }
          defaultLabel={robot.armTrajectory === 'pick_place' ? 'pickup' : 'prop'}
          sizeRange={{ min: 0.005, max: 0.2, step: 0.005 }}
          showPhysics={false}
          disabled={robotRunning}
          initialPlacement={armAssetPlacement}
          helpText={
            robot.armTrajectory === 'pick_place'
              ? 'Imported USDZ assets are scaled to small Braccio targets, placed inside reach, and can be chosen as pick-and-place anchors.'
              : 'Imported USDZ scenery appears only in the arm scene and POV camera.'
          }
        />
      )}

      <CollapsibleCard heading="Recording">
        <div className="row">
          <label className="field">
            Count
            <input
              type="number"
              min={1}
              max={200}
              step={1}
              {...countInput.inputProps}
              disabled={robotRunning}
            />
          </label>
          <label className="field">
            Per-iteration ms
            <input
              type="number"
              min={500}
              max={15000}
              step={100}
              {...durationInput.inputProps}
              disabled={robotRunning}
            />
          </label>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {robotRunning
            ? robot.kind === 'rover'
              ? `Capturing… ${imuSampleCount} IMU · ${lidarSampleCount} lidar this window`
              : `Capturing… ${imuSampleCount} IMU samples this window`
            : robot.kind === 'rover'
              ? '6-channel IMU + N-channel lidar per sample.'
              : '6-channel end-effector IMU per sample.'}
        </div>
        <ImuNoiseToggle />
      </CollapsibleCard>

      {robot.kind === 'rover' && (
        <SceneObjectsCard
          title="Scene obstacles"
          sizeRange={{ min: 0.05, max: 1.5, step: 0.05 }}
          defaultLabel="obstacle"
          helpText="Add obstacles the rover can bump into. The lidar fan and contact detector see them all."
          disabled={robotRunning}
          ownerFilter="rover"
        />
      )}

      {robot.kind === 'rover' && (
        <ImportedAssetsCard
          ownerFilter="rover"
          title="Imported obstacles"
          defaultLabel="obstacle"
          sizeRange={{ min: 0.02, max: 3, step: 0.01 }}
          showPhysics={false}
          disabled={robotRunning}
          initialPlacement={roverAssetPlacement}
          helpText="Imported USDZ assets render in the rover scene, appear in lidar rays, and are approximated as MuJoCo collision obstacles."
        />
      )}

      {robot.kind === 'rover' && (
        <>
          <CollapsibleCard heading="Lidar / ToF ring">
            <label className="field">
              Beams {robot.lidarBins}
              <input
                type="range"
                min={4}
                max={64}
                step={1}
                value={robot.lidarBins}
                onChange={(e) => setRobot({ lidarBins: Number(e.target.value) })}
                disabled={robotRunning}
              />
            </label>
            <label className="field">
              Max range {robot.lidarMaxRange.toFixed(1)} m
              <input
                type="range"
                min={1}
                max={20}
                step={0.5}
                value={robot.lidarMaxRange}
                onChange={(e) =>
                  setRobot({ lidarMaxRange: Number(e.target.value) })
                }
                disabled={robotRunning}
              />
            </label>
          </CollapsibleCard>
          <CollapsibleCard heading="Sensor modality">
            <div
              className="motion-pills trajectory-pills"
              role="radiogroup"
              aria-label="Upload modality"
            >
              {ALL_ROVER_UPLOAD_MODALITIES.map((m) => (
                <label
                  key={m}
                  className={`motion-pill ${robot.uploadModality === m ? 'on' : ''}`}
                >
                  <input
                    type="radio"
                    name="rover-modality"
                    value={m}
                    checked={robot.uploadModality === m}
                    disabled={robotRunning}
                    onChange={() => setRobot({ uploadModality: m })}
                  />
                  {m === 'fused'
                    ? 'Fused (IMU+lidar)'
                    : m === 'imu'
                      ? 'IMU only'
                      : 'Lidar only'}
                </label>
              ))}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {robot.uploadModality === 'fused' &&
                'One sample, 6 IMU + N lidar channels. Best for sensor-fusion classifiers.'}
              {robot.uploadModality === 'imu' &&
                'Chassis IMU only. Useful for collision detection without lidar.'}
              {robot.uploadModality === 'lidar' &&
                'Lidar only. Useful for environment-classification models.'}
            </div>
          </CollapsibleCard>
        </>
      )}

      <div className="card">
        {/* When OFF the card collapses to "Object detection · OFF" +
            the toggle so the sidebar stays compact for users who only
            want sensor data. Flipping it on expands the help text +
            sub-controls (capture phase, count, output size). */}
        <ToggleSwitch
          title="Object detection"
          titleAs="h3"
          help={
            robot.objectDetection
              ? `Snap ${
                  robot.captureAtRest
                    ? 1
                    : robot.objectDetectionImagesPerIteration
                } POV-camera image${
                  (robot.captureAtRest
                    ? 1
                    : robot.objectDetectionImagesPerIteration) === 1
                    ? ''
                    : 's'
                } per iteration with 2D bounding boxes. EI accepts only one data type per project — the runner probes the project and routes the other to a local zip.`
              : undefined
          }
          on={robot.objectDetection}
          disabled={robotRunning}
          onChange={(next) => setRobot({ objectDetection: next })}
        />
        {robot.objectDetection && (
          <>
            <div style={{ marginTop: 8 }}>
              <ToggleSwitch
                title="Capture at rest"
                help="Snap before motion begins instead of mid-motion. Same one image per iteration."
                on={robot.captureAtRest}
                disabled={robotRunning}
                onChange={(next) => setRobot({ captureAtRest: next })}
              />
            </div>
            {!robot.captureAtRest && (
              // At-rest captures fire while nothing's moving, so N back-
              // to-back shots would produce N near-identical PNGs — wasted
              // bandwidth. Hide the count and pin to 1 in the runner.
              <label className="field" style={{ marginTop: 8 }}>
                Images per iteration
                <input
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  value={robot.objectDetectionImagesPerIteration}
                  onChange={(e) =>
                    setRobot({
                      objectDetectionImagesPerIteration: Math.max(
                        1,
                        Math.min(20, Number(e.target.value) || 1),
                      ),
                    })
                  }
                  disabled={robotRunning}
                />
              </label>
            )}
            <div className="row" style={{ marginTop: 8 }}>
              <label className="field">
                Image width
                <input
                  type="number"
                  min={128}
                  max={1920}
                  step={32}
                  value={robot.objectDetectionWidth}
                  onChange={(e) =>
                    setRobot({
                      objectDetectionWidth: Math.max(
                        128,
                        Math.min(1920, Number(e.target.value) || 640),
                      ),
                    })
                  }
                  disabled={robotRunning}
                />
              </label>
              <label className="field">
                Image height
                <input
                  type="number"
                  min={128}
                  max={1920}
                  step={32}
                  value={robot.objectDetectionHeight}
                  onChange={(e) =>
                    setRobot({
                      objectDetectionHeight: Math.max(
                        128,
                        Math.min(1920, Number(e.target.value) || 480),
                      ),
                    })
                  }
                  disabled={robotRunning}
                />
              </label>
            </div>
          </>
        )}
      </div>

      {/* Realism only modifies image captures, so gate on
          objectDetection — sensor-only runs (IMU / lidar) don't
          produce images for the pass to touch. */}
      {robot.objectDetection && <RealismCard />}

      <EiAuthCard showHmac />

      {/* Mount the EI inference card whenever object detection is on
          so the user can load a model and see live detections drawn
          over the POV preview as they generate. Hidden otherwise to
          keep the sensor-only sidebar uncluttered. */}
      {robot.objectDetection && (
        <EiInferenceCard previewSource="robot-pov" />
      )}

      <CollapsibleCard heading="Generate">
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {robot.kind === 'rover' ? (
            <>
              Each iteration drives the rover through one{' '}
              <strong>{robot.roverEvent}</strong> event and records the IMU +
              lidar window.
            </>
          ) : (
            <>
              Each iteration runs one <strong>{robot.armTrajectory.replace(/_/g, ' ')}</strong>{' '}
              motion and records the end-effector IMU.
            </>
          )}
          {robot.objectDetection && (
            <>
              {' '}Plus{' '}
              <strong>
                {robot.captureAtRest
                  ? 1
                  : robot.objectDetectionImagesPerIteration}
              </strong>{' '}
              POV image
              {(robot.captureAtRest
                ? 1
                : robot.objectDetectionImagesPerIteration) === 1
                ? ''
                : 's'}{' '}
              per iteration ({robot.captureAtRest ? 'at rest' : 'mid-motion'})
              with 2D bounding boxes.
            </>
          )}
        </div>
        <ToggleSwitch
          title="ROS 2 export"
          help={
            robot.kind === 'rover'
              ? 'Also write each window as ROS 2 sensor-message JSONL (sensor_msgs/Imu + LaserScan). Bundles into the download zip alongside the EI payload.'
              : 'Also write each window as ROS 2 sensor-message JSONL — end-effector sensor_msgs/Imu + per-tick sensor_msgs/JointState. Bundles into the download zip alongside the EI payload.'
          }
          on={robot.rosExport}
          disabled={robotRunning}
          onChange={(next) => setRobot({ rosExport: next })}
        />
        {robotRunning ? (
          <button
            className="danger"
            onClick={() => setRobotCancelRequested(true)}
          >
            ■ Stop
          </button>
        ) : (
          <button
            className="primary"
            onClick={onRun}
            disabled={status.kind === 'busy'}
          >
            {`⚡ Generate & ${hasApiKey ? 'upload' : 'download'} ${robot.count} samples`}
          </button>
        )}
      </CollapsibleCard>
    </>
  );
}

/**
 * Per-joint home-pose editor for the Braccio. Each slider is clamped
 * to the matching servo's published range in `BRACCIO_LIMITS_RAD` so
 * the user can't ask the physical arm to overextend (M2 stops at 15°
 * and 165°, etc.). Joints 0–4 read in degrees for legibility — that's
 * how Braccio Arduino sketches express servo angles too. The gripper
 * (M6) is shown as a normalized 0..1 aperture since the published
 * 10°–73° servo range maps onto a small, awkward number band that
 * doesn't read as cleanly.
 */
function ArmHomePoseCard({ disabled }: { disabled: boolean }) {
  const robot = useStore((s) => s.robot);
  const setRobot = useStore((s) => s.setRobot);
  // Collapsed by default — six sliders eat a lot of sidebar space
  // and most users will adjust home pose once and forget. Same
  // collapsible pattern as the "Custom textures" card on the
  // detection panel.
  const [open, setOpen] = useState(false);

  const setJoint = (idx: number, valueRad: number) => {
    const next = [...robot.armHomePose] as typeof robot.armHomePose;
    next[idx] = valueRad;
    setRobot({ armHomePose: next });
  };

  const labels = [
    'M1 base',
    'M2 shoulder',
    'M3 elbow',
    'M4 wrist pitch',
    'M5 wrist roll',
  ];
  // True when any joint differs from the spec-default rest pose, so
  // the collapsed header can flag "you have a custom home pose".
  const isCustom = robot.armHomePose.some(
    (v, i) => Math.abs(v - BRACCIO_REST_RAD[i]) > 0.01,
  );

  return (
    <div className="card">
      <button
        type="button"
        onClick={() => setOpen((b) => !b)}
        aria-expanded={open}
        className="card-heading-toggle"
      >
        <span>Arm home pose</span>
        {isCustom && !open && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 10,
              color: 'var(--accent)',
              fontWeight: 500,
              letterSpacing: '0.08em',
            }}
          >
            custom
          </span>
        )}
        <span
          className="section-toggle-chevron"
          style={{
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            marginLeft: isCustom && !open ? '0' : 'auto',
          }}
          aria-hidden
        >
          <ChevronGlyph />
        </span>
      </button>
      {!open ? null : (
        <>
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
        Servo angles the arm holds at idle and starts every trajectory
        from. Each slider is clamped to the published Braccio limit.
      </div>
      {labels.map((label, i) => {
        const [loRad, hiRad] = BRACCIO_LIMITS_RAD[i];
        const valDeg = radToDeg(robot.armHomePose[i]);
        return (
          <label key={i} className="field">
            {label} {valDeg.toFixed(0)}°{' '}
            <span style={{ color: 'var(--muted)', fontSize: 10 }}>
              ({radToDeg(loRad).toFixed(0)}–{radToDeg(hiRad).toFixed(0)}°)
            </span>
            <input
              type="range"
              min={radToDeg(loRad)}
              max={radToDeg(hiRad)}
              step={1}
              value={valDeg}
              onChange={(e) => setJoint(i, degToRad(Number(e.target.value)))}
              disabled={disabled}
            />
          </label>
        );
      })}
      <label className="field">
        M6 gripper {(robot.armHomePose[5] * 100).toFixed(0)} %{' '}
        <span style={{ color: 'var(--muted)', fontSize: 10 }}>
          (0 = closed, 100 = open)
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={robot.armHomePose[5]}
          onChange={(e) => setJoint(5, Number(e.target.value))}
          disabled={disabled}
        />
      </label>
      <button
        type="button"
        onClick={() =>
          setRobot({
            armHomePose: [...BRACCIO_REST_RAD] as typeof robot.armHomePose,
          })
        }
        disabled={disabled}
        title="Reset every joint to the default Braccio home pose."
      >
        ↺ Reset to home
      </button>
        </>
      )}
    </div>
  );
}

/** Camera-mount selector — picks which point on the arm the
 * wrist-mounted POV camera is actually attached to. Each option
 * corresponds to a `arm-pov-${name}` group + `arm-pov-${name}-look`
 * anchor inside `BraccioArm.tsx`; the POV component does
 * `scene.getObjectByName` on those each frame. */
function ArmCameraMountCard({ disabled }: { disabled: boolean }) {
  const mount = useStore((s) => s.robot.armCameraMount);
  const setRobot = useStore((s) => s.setRobot);
  const OPTIONS: {
    value: typeof mount;
    label: string;
    hint: string;
  }[] = [
    { value: 'base', label: 'Base', hint: 'Top of the base column, looking up the arm.' },
    { value: 'shoulder', label: 'Shoulder', hint: 'Eye on the shoulder joint, looking forward.' },
    { value: 'elbow', label: 'Elbow', hint: 'Eye on the elbow joint, looking down the forearm.' },
    { value: 'wrist', label: 'Wrist', hint: 'Wrist roll, looking past the gripper carrier.' },
    { value: 'gripper', label: 'Gripper', hint: 'Between the fingers, looking at the grasp point.' },
  ];
  return (
    <CollapsibleCard heading="POV camera mount">
      <div
        className="motion-pills trajectory-pills"
        role="radiogroup"
        aria-label="Arm camera mount"
      >
        {OPTIONS.map((o) => (
          <label
            key={o.value}
            className={`motion-pill ${mount === o.value ? 'on' : ''}`}
            title={o.hint}
          >
            <input
              type="radio"
              name="arm-camera-mount"
              value={o.value}
              checked={mount === o.value}
              disabled={disabled}
              onChange={() => setRobot({ armCameraMount: o.value })}
            />
            {o.label}
          </label>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
        {OPTIONS.find((o) => o.value === mount)?.hint}
      </div>
    </CollapsibleCard>
  );
}

function ArmTrajectoryPicker({
  value,
  onChange,
  disabled,
}: {
  value: ArmTrajectory;
  onChange: (t: ArmTrajectory) => void;
  disabled: boolean;
}) {
  return (
    <div
      className="motion-pills trajectory-pills"
      role="radiogroup"
      aria-label="Arm trajectory"
    >
      {ALL_ARM_TRAJECTORIES.map((kind) => (
        <label
          key={kind}
          className={`motion-pill ${value === kind ? 'on' : ''}`}
        >
          <input
            type="radio"
            name="arm-trajectory"
            value={kind}
            checked={value === kind}
            disabled={disabled}
            onChange={() => onChange(kind)}
          />
          {kind.replace(/_/g, ' ')}
        </label>
      ))}
    </div>
  );
}
