import { useState } from 'react';
import {
  ALL_ROVER_EVENTS,
  ALL_ROVER_UPLOAD_MODALITIES,
  useStore,
  type AccelSample,
  type ImportedAsset,
  type LidarSample,
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
import { saveBlob } from '../lib/capture';
import {
  buildDataAcquisitionPayload,
  buildFileName,
  buildInfoLabelsEntry,
  buildInfoLabelsFile,
  buildLidarDataAcquisitionPayload,
  buildRoverDataAcquisitionPayload,
  uploadLidarSample,
  uploadRoverSample,
  uploadSample,
  type EdgeImpulseInfoLabelsEntry,
} from '../lib/edgeImpulse';
import { buildArmRosJsonl, buildRoverRosJsonl } from '../lib/rosMessages';
import { useNumberInput } from '../lib/useNumberInput';
import { disposeUsdz } from '../lib/usdz';
import { buildZip, type ZipEntry } from '../lib/zip';
import { EiAuthCard } from './EiAuthCard';
import { ImportedAssetsCard } from './ImportedAssetsCard';
import { ImuNoiseToggle } from './ImuNoiseToggle';
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

class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export function RobotPanel() {
  const robot = useStore((s) => s.robot);
  const setRobot = useStore((s) => s.setRobot);
  const robotRunning = useStore((s) => s.robotRunning);
  const setRobotRunning = useStore((s) => s.setRobotRunning);
  const setRobotCancelRequested = useStore((s) => s.setRobotCancelRequested);
  const bumpRoverEpoch = useStore((s) => s.bumpRoverEpoch);
  const bumpArmEpoch = useStore((s) => s.bumpArmEpoch);
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
    setRobotCancelRequested(false);
    setRobotRunning(true);
    let uploaded = 0;
    let captured = 0;
    let failed = 0;
    let cancelled = false;
    const zipEntries: ZipEntry[] = [];
    const infoLabelsEntries: EdgeImpulseInfoLabelsEntry[] = [];

    try {
      await sleepCancellable(60);
      for (let i = 0; i < robot.count; i++) {
        setStatus(
          'busy',
          `${i + 1}/${robot.count} ${event}: building path…`,
        );
        clearLidarSamples();
        clearRobotImuSamples();
        bumpRoverEpoch();
        await sleepCancellable(robot.durationMs);
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
        if (shouldUpload) {
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
            if (res.ok) uploaded += 1;
            else failed += 1;
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
          shouldUpload
            ? `Rover: ${uploaded} uploaded · ${failed} failed (of ${i + 1}/${robot.count})`
            : `Rover: ${captured} captured · ${failed} failed (of ${i + 1}/${robot.count})`,
        );
      }
      const headline = cancelled ? 'Rover run stopped' : 'Rover run complete';
      if (shouldUpload) {
        // ROS export still needs to land somewhere even when EI
        // uploads succeed — there's no ROS ingestion endpoint, so
        // we always zip the JSONL files locally if rosExport is on.
        if (zipEntries.length > 0) {
          const zipName = buildFileName(
            `rover_${event}_rosbag`,
          ).replace(/\.json$/, '.zip');
          const zip = await buildZip(zipEntries);
          await saveBlob(zipName, zip);
        }
        setStatus(
          cancelled || failed > 0 ? 'err' : 'ok',
          `${headline}: ${uploaded} uploaded${failed ? ` · ${failed} failed` : ''}${
            zipEntries.length > 0 ? ` · ROS bundle saved` : ''
          }`,
        );
      } else if (zipEntries.length > 0) {
        const entries =
          infoLabelsEntries.length > 0
            ? [
                ...zipEntries,
                {
                  name: 'info.labels',
                  data: buildInfoLabelsFile(infoLabelsEntries),
                },
              ]
            : zipEntries;
        setStatus('busy', `Packaging ${entries.length} files…`);
        const zipName = buildFileName(
          `rover_${event}_${infoLabelsEntries.length || zipEntries.length}`,
        ).replace(/\.json$/, '.zip');
        const zip = await buildZip(entries);
        await saveBlob(zipName, zip);
        setStatus(
          cancelled || failed > 0 ? 'err' : 'ok',
          `${headline}: downloaded ${entries.length} files${failed ? ` · ${failed} failed` : ''}`,
        );
      } else {
        setStatus('err', `${headline}: no samples captured`);
      }
    } catch (e) {
      if (e instanceof CancelledError) {
        cancelled = true;
        setStatus(
          'err',
          shouldUpload
            ? `Rover run stopped: ${uploaded} uploaded${failed ? ` · ${failed} failed` : ''}`
            : `Rover run stopped: ${zipEntries.length} samples saved`,
        );
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
    setRobotCancelRequested(false);
    setRobotRunning(true);
    let uploaded = 0;
    let captured = 0;
    let failed = 0;
    let cancelled = false;
    const zipEntries: ZipEntry[] = [];
    const infoLabelsEntries: EdgeImpulseInfoLabelsEntry[] = [];
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
        clearRobotImuSamples();
        useStore.getState().clearArmJointSamples();
        bumpArmEpoch();
        await sleepCancellable(robot.durationMs);
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
        if (shouldUpload) {
          try {
            const res = await uploadSample(
              { ...runEi, label: trajectory },
              imu,
              20,
              fileName,
              meta,
            );
            if (res.ok) uploaded += 1;
            else failed += 1;
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
          shouldUpload
            ? `Arm: ${uploaded} uploaded · ${failed} failed (of ${i + 1}/${robot.count})`
            : `Arm: ${captured} captured · ${failed} failed (of ${i + 1}/${robot.count})`,
        );
      }
      const headline = cancelled ? 'Arm run stopped' : 'Arm run complete';
      if (shouldUpload) {
        // ROS JSONL has no upload endpoint, so even when EI uploads
        // succeed we still zip the JSONL files locally if rosExport
        // is on. Mirrors the rover path's behavior.
        if (zipEntries.length > 0) {
          const zipName = buildFileName(`arm_${trajectory}_rosbag`).replace(
            /\.json$/,
            '.zip',
          );
          const zip = await buildZip(zipEntries);
          await saveBlob(zipName, zip);
        }
        setStatus(
          cancelled || failed > 0 ? 'err' : 'ok',
          `${headline}: ${uploaded} uploaded${failed ? ` · ${failed} failed` : ''}`,
        );
      } else if (zipEntries.length > 0) {
        const entries =
          infoLabelsEntries.length > 0
            ? [
                ...zipEntries,
                {
                  name: 'info.labels',
                  data: buildInfoLabelsFile(infoLabelsEntries),
                },
              ]
            : zipEntries;
        setStatus('busy', `Packaging ${entries.length} files…`);
        const zipName = buildFileName(
          `arm_${trajectory}_${infoLabelsEntries.length || zipEntries.length}`,
        ).replace(/\.json$/, '.zip');
        const zip = await buildZip(entries);
        await saveBlob(zipName, zip);
        setStatus(
          cancelled || failed > 0 ? 'err' : 'ok',
          `${headline}: downloaded ${entries.length} files${failed ? ` · ${failed} failed` : ''}`,
        );
      } else {
        setStatus('err', `${headline}: no samples captured`);
      }
    } catch (e) {
      if (e instanceof CancelledError) {
        cancelled = true;
        setStatus(
          'err',
          shouldUpload
            ? `Arm run stopped: ${uploaded} uploaded${failed ? ` · ${failed} failed` : ''}`
            : `Arm run stopped: ${zipEntries.length} samples saved`,
        );
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
      <div className="card">
        <h3>Robot</h3>
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
      </div>

      {robot.kind === 'rover' ? (
        <div className="card">
          <h3>Event</h3>
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
        </div>
      ) : (
        <div className="card">
          <h3>Trajectory</h3>
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
        </div>
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
          ownerFilter="arm"
          footer={
            robot.armTrajectory === 'pick_place' ? (
              // Lives inside the pickup-objects card so the toggle that
              // *acts on* those objects sits next to the list, not as a
              // floating card below.
              <div className="webcam-control" style={{ marginTop: 8 }}>
                <div className="webcam-control-copy">
                  <div className="webcam-control-heading">
                    <span className="webcam-control-title">
                      Randomize pickup position
                    </span>
                    <span
                      className={`webcam-control-state ${
                        robot.armRandomizeTarget ? 'on' : 'off'
                      }`}
                    >
                      {robot.armRandomizeTarget ? 'On' : 'Off'}
                    </span>
                  </div>
                  <div className="webcam-control-help">
                    Re-sample each pickup object to a fresh random
                    position inside the Braccio's reach at the start of
                    every iteration. Generates varied IMU traces without
                    dragging the cube around by hand.
                  </div>
                </div>
                <button
                  type="button"
                  className={`webcam-switch ${
                    robot.armRandomizeTarget ? 'on' : ''
                  }`}
                  role="switch"
                  aria-checked={robot.armRandomizeTarget}
                  aria-label={
                    robot.armRandomizeTarget
                      ? 'Turn pickup randomization off'
                      : 'Turn pickup randomization on'
                  }
                  onClick={() => {
                    const next = !robot.armRandomizeTarget;
                    setRobot({ armRandomizeTarget: next });
                    // Flipping the switch on should give immediate
                    // visual feedback — randomize once now so the user
                    // can see the pickups hop to fresh positions
                    // before the next run bumps the armEpoch.
                    if (next) {
                      useStore.getState().randomizeArmPickupPositions();
                    }
                  }}
                  disabled={robotRunning}
                >
                  <span className="webcam-switch-thumb" />
                </button>
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

      <div className="card">
        <h3>Recording</h3>
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
      </div>

      {robot.kind === 'rover' && (
        <SceneObjectsCard
          title="Scene obstacles"
          sizeRange={{ min: 0.05, max: 1.5, step: 0.05 }}
          defaultLabel="obstacle"
          helpText="Add obstacles the rover can bump into. The lidar fan and contact detector see them all."
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
          <div className="card">
            <h3>Lidar / ToF ring</h3>
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
          </div>
          <div className="card">
            <h3>Sensor modality</h3>
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
          </div>
        </>
      )}

      <div className="card">
        <div className="webcam-control">
          <div className="webcam-control-copy">
            <div className="webcam-control-heading">
              <span className="webcam-control-title">ROS 2 export</span>
              <span
                className={`webcam-control-state ${
                  robot.rosExport ? 'on' : 'off'
                }`}
              >
                {robot.rosExport ? 'On' : 'Off'}
              </span>
            </div>
            <div className="webcam-control-help">
              {robot.kind === 'rover'
                ? 'Also write each window as ROS 2 sensor-message JSONL (sensor_msgs/Imu + LaserScan). Bundles into the download zip alongside the EI payload.'
                : 'Also write each window as ROS 2 sensor-message JSONL — end-effector sensor_msgs/Imu + per-tick sensor_msgs/JointState. Bundles into the download zip alongside the EI payload.'}
            </div>
          </div>
          <button
            type="button"
            className={`webcam-switch ${robot.rosExport ? 'on' : ''}`}
            role="switch"
            aria-checked={robot.rosExport}
            aria-label={
              robot.rosExport ? 'Turn ROS export off' : 'Turn ROS export on'
            }
            onClick={() => setRobot({ rosExport: !robot.rosExport })}
            disabled={robotRunning}
          >
            <span className="webcam-switch-thumb" />
          </button>
        </div>
      </div>

      <EiAuthCard showHmac />

      <div className="card">
        <h3>Generate</h3>
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
        </div>
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
      </div>
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

  const RAD_TO_DEG = 180 / Math.PI;
  const DEG_TO_RAD = Math.PI / 180;
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
          ▸
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
        const valDeg = robot.armHomePose[i] * RAD_TO_DEG;
        return (
          <label key={i} className="field">
            {label} {valDeg.toFixed(0)}°{' '}
            <span style={{ color: 'var(--muted)', fontSize: 10 }}>
              ({(loRad * RAD_TO_DEG).toFixed(0)}–{(hiRad * RAD_TO_DEG).toFixed(0)}°)
            </span>
            <input
              type="range"
              min={loRad * RAD_TO_DEG}
              max={hiRad * RAD_TO_DEG}
              step={1}
              value={valDeg}
              onChange={(e) =>
                setJoint(i, Number(e.target.value) * DEG_TO_RAD)
              }
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
    <div className="card">
      <h3>POV camera mount</h3>
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
    </div>
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
