import {
  ALL_MOTION_KINDS,
  useStore,
  type AccelSample,
  type MotionKind,
  type ObjectKind,
} from '../store/useStore';
import { saveBlob } from '../lib/capture';
import {
  buildDataAcquisitionPayload,
  buildFileName,
  listEiProjects,
  retrainEiModel,
  uploadSample,
  waitForEiJob,
} from '../lib/edgeImpulse';
import { buildZip, type ZipEntry } from '../lib/zip';
import { EiAuthCard } from './EiAuthCard';

const OBJECTS: { value: ObjectKind; label: string }[] = [
  { value: 'cube', label: 'Cube' },
  { value: 'sphere', label: 'Sphere' },
  { value: 'cylinder', label: 'Cylinder' },
  { value: 'cone', label: 'Cone' },
  { value: 'torus', label: 'Torus' },
  { value: 'capsule', label: 'Capsule' },
  { value: 'phone', label: 'Phone slab' },
  { value: 'soda_can', label: 'Soda can' },
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sentinel thrown by the cancellation-aware `sleepCancellable` when the
 * user clicks Stop. The runner catches it specifically so it can report
 * "cancelled" instead of "errored". */
class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

/**
 * Uniformly-random unit quaternion (Shoemake 1992). Returned as
 * [x, y, z, w] for direct use as a Rapier rotation.
 */
function randomQuaternion(): [number, number, number, number] {
  const u1 = Math.random();
  const u2 = Math.random();
  const u3 = Math.random();
  const s1 = Math.sqrt(1 - u1);
  const s2 = Math.sqrt(u1);
  return [
    s1 * Math.sin(2 * Math.PI * u2),
    s1 * Math.cos(2 * Math.PI * u2),
    s2 * Math.sin(2 * Math.PI * u3),
    s2 * Math.cos(2 * Math.PI * u3),
  ];
}

export function MotionPanel() {
  const {
    objectKind,
    setObjectKind,
    isRecording,
    startRecording,
    stopRecording,
    samples,
    clearSamples,
    sampleRateHz,
    setSampleRateHz,
    ei,
    setEi,
    status,
    setStatus,
    handTrackingEnabled,
    setHandTrackingEnabled,
    drops,
    setDrops,
    dropsRunning,
    setDropsRunning,
    setGrabbed,
    setPinchTarget,
    setPinchRotation,
    setDropsCancelRequested,
  } = useStore();

  const onUpload = async () => {
    setStatus('busy', 'Uploading…');
    try {
      const res = await uploadSample(
        ei,
        samples,
        sampleRateHz,
        buildFileName(ei.label),
        {
          mode: 'motion',
          shape: objectKind,
          sample_rate_hz: sampleRateHz,
          hand_tracking: handTrackingEnabled,
        },
      );
      if (res.ok) {
        setStatus('ok', `Uploaded ${samples.length} samples (${res.status}).`);
        clearSamples();
      } else {
        setStatus('err', `Upload failed (${res.status}): ${res.body}`);
      }
    } catch (e) {
      setStatus('err', `Upload error: ${(e as Error).message}`);
    }
  };

  const explainEiError = (e: unknown): string => {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Failed to fetch|NetworkError|Load failed/.test(msg)) {
      return `Network/CORS error contacting the Edge Impulse Studio API. Check your network and API key. Original: ${msg}`;
    }
    if (/401/.test(msg)) {
      return `${msg} — API key rejected. Double-check Dashboard → Keys in your project.`;
    }
    if (/403/.test(msg)) {
      return `${msg} — API key doesn't have access to this project.`;
    }
    return msg;
  };

  const onRetrainModel = async () => {
    const apiKey = ei.apiKey.trim();
    if (!apiKey) {
      setStatus('err', 'Enter your Edge Impulse API key first');
      return;
    }

    try {
      setStatus('busy', 'Finding Edge Impulse project…');
      const projects = await listEiProjects(apiKey);
      if (projects.length === 0) {
        setStatus('err', 'No projects accessible to this API key');
        return;
      }
      if (projects.length > 1) {
        setStatus(
          'err',
          'This API key can access multiple projects. Use a project API key to retrain from Motion mode.',
        );
        return;
      }

      const project = projects[0];
      setStatus('busy', `Starting retrain for ${project.name}…`);
      const { jobId } = await retrainEiModel(apiKey, project.id);
      await waitForEiJob(apiKey, project.id, jobId, {
        onProgress: (elapsed) => {
          setStatus(
            'busy',
            `Retrain job #${jobId} running (${Math.floor(elapsed / 1000)}s)…`,
          );
        },
      });
      setStatus('ok', `Retrained ${project.name}.`);
    } catch (e) {
      setStatus('err', `Retrain model: ${explainEiError(e)}`);
    }
  };

  /**
   * Procedurally generate N drops, each one a separate Edge Impulse sample:
   *
   *   for each drop i:
   *     1. lift the manipulated body to a random (x, y, z) inside a small
   *        spawn cylinder by setting pinchTarget + isGrabbed (the existing
   *        ManipulatedObject useFrame handles the kinematic lerp).
   *     2. wait long enough for the body to actually reach the lift target
   *        (FOLLOW_LERP makes this take a few hundred ms).
   *     3. start a fresh recording (clears previous samples).
   *     4. release: clear pinchTarget + isGrabbed → body returns to dynamic
   *        and falls under gravity. Velocity is near-zero because we held
   *        the lift target steady for the previous frames, so the drop is
   *        a clean free-fall + bounce, not a thrown trajectory.
   *     5. wait `durationMs` for the bounce/settle period.
   *     6. stop recording, snapshot samples, then either upload to EI or
   *        bundle the samples into a local zip when no API key is set.
   *
   * Hand tracking is auto-disabled for the duration so the CameraFeed
   * doesn't fight with our scripted pinchTarget writes.
   */
  /**
   * Sleep that checks the store's cancel flag at the end of each window.
   * Throws `CancelledError` if the user clicked Stop, so the runner unwinds
   * back to its cleanup block instead of finishing the iteration.
   */
  const sleepCancellable = async (ms: number): Promise<void> => {
    await new Promise<void>((r) => setTimeout(r, ms));
    if (useStore.getState().dropsCancelRequested) throw new CancelledError();
  };

  /**
   * Lift the body to a random pose using the kinematic manipulator. Returns
   * the lift target position. Caller is responsible for the eventual
   * release. `xyRange` controls the horizontal jitter; `yMin`/`yMax`
   * default to the user-configured drop height range.
   */
  const liftTo = async (
    xyRange: number,
    yMin: number,
    yMax: number,
    randomize: boolean,
  ): Promise<[number, number, number]> => {
    const x = (Math.random() - 0.5) * xyRange;
    const y = yMin + Math.random() * Math.max(0.001, yMax - yMin);
    const z = (Math.random() - 0.5) * xyRange;
    setPinchRotation(randomize ? randomQuaternion() : null);
    setPinchTarget([x, y, z]);
    setGrabbed(true);
    // Wait for the kinematic lerp to converge on the lift target. The
    // manipulator uses FOLLOW_LERP=0.35 per frame; 600ms is enough at 60 Hz
    // to reach within ~2 cm of any reachable point.
    await sleepCancellable(600);
    return [x, y, z];
  };

  const releaseBody = () => {
    setGrabbed(false);
    setPinchTarget(null);
    setPinchRotation(null);
  };

  /**
   * Drive the kinematic target along a velocity vector for a short window
   * before releasing. `Scene.tsx` derives the body's release linvel from
   * the per-frame kinematic delta, so this imparts roughly the requested
   * horizontal speed at release time. `start` is the current pose;
   * returns the final commanded target.
   */
  const accelerateAndRelease = async (
    start: [number, number, number],
    velocity: [number, number, number],
    steps: number,
  ): Promise<void> => {
    const STEP_MS = 16;
    let [cx, cy, cz] = start;
    for (let k = 0; k < steps; k++) {
      cx += velocity[0] * (STEP_MS / 1000);
      cy += velocity[1] * (STEP_MS / 1000);
      cz += velocity[2] * (STEP_MS / 1000);
      setPinchTarget([cx, cy, cz]);
      await sleepCancellable(STEP_MS);
    }
    releaseBody();
  };

  type RunCtx = { motion: MotionKind; index: number; total: number };
  const recordSnapshot = (): AccelSample[] => {
    stopRecording();
    const snap = useStore.getState().samples.slice();
    clearSamples();
    return snap;
  };

  const runDrop = async (ctx: RunCtx): Promise<AccelSample[]> => {
    setStatus('busy', `${ctx.index}/${ctx.total} drop: lifting…`);
    await liftTo(1.2, drops.heightMin, drops.heightMax, true);
    startRecording();
    // Brief beat so the first sample is captured before release —
    // otherwise the very first reading would be the kinematic body's
    // pre-release linvel, which is artificial.
    await sleepCancellable(40);
    setStatus('busy', `${ctx.index}/${ctx.total} drop: falling…`);
    releaseBody();
    await sleepCancellable(drops.durationMs);
    return recordSnapshot();
  };

  const runThrow = async (ctx: RunCtx): Promise<AccelSample[]> => {
    setStatus('busy', `${ctx.index}/${ctx.total} throw: winding up…`);
    const start = await liftTo(0.8, drops.heightMin, drops.heightMax, true);
    startRecording();
    await sleepCancellable(40);
    setStatus('busy', `${ctx.index}/${ctx.total} throw: releasing…`);
    const angle = Math.random() * 2 * Math.PI;
    const speed = 3 + Math.random() * 2; // 3–5 m/s horizontal
    const upKick = 0.4 + Math.random() * 0.8; // gentle upward arc
    await accelerateAndRelease(
      start,
      [Math.cos(angle) * speed, upKick, Math.sin(angle) * speed],
      8,
    );
    await sleepCancellable(drops.durationMs);
    return recordSnapshot();
  };

  const runPush = async (ctx: RunCtx): Promise<AccelSample[]> => {
    // Hold the body just above the ground and accelerate horizontally so
    // it slides on release. Skip the random orientation — pushes are
    // usually upright.
    setStatus('busy', `${ctx.index}/${ctx.total} push: positioning…`);
    const start = await liftTo(1.2, 0.12, 0.18, false);
    startRecording();
    await sleepCancellable(40);
    setStatus('busy', `${ctx.index}/${ctx.total} push: shoving…`);
    const angle = Math.random() * 2 * Math.PI;
    const speed = 2 + Math.random() * 2; // 2–4 m/s
    await accelerateAndRelease(
      start,
      [Math.cos(angle) * speed, 0, Math.sin(angle) * speed],
      8,
    );
    await sleepCancellable(drops.durationMs);
    return recordSnapshot();
  };

  const runShake = async (ctx: RunCtx): Promise<AccelSample[]> => {
    setStatus('busy', `${ctx.index}/${ctx.total} shake: winding up…`);
    const center = await liftTo(0.6, drops.heightMin, drops.heightMax, false);
    const axisAngle = Math.random() * 2 * Math.PI;
    const ax = Math.cos(axisAngle);
    const az = Math.sin(axisAngle);
    const freq = 3 + Math.random() * 3; // 3–6 Hz
    const amp = 0.12 + Math.random() * 0.15; // 12–27 cm peak displacement
    startRecording();
    setStatus('busy', `${ctx.index}/${ctx.total} shake: oscillating…`);
    const t0 = performance.now();
    while (performance.now() - t0 < drops.durationMs) {
      const t = (performance.now() - t0) / 1000;
      const off = Math.sin(2 * Math.PI * freq * t) * amp;
      setPinchTarget([center[0] + ax * off, center[1], center[2] + az * off]);
      await sleepCancellable(16);
    }
    releaseBody();
    return recordSnapshot();
  };

  const runMotion = async (ctx: RunCtx): Promise<AccelSample[]> => {
    switch (ctx.motion) {
      case 'drop':
        return await runDrop(ctx);
      case 'throw':
        return await runThrow(ctx);
      case 'push':
        return await runPush(ctx);
      case 'shake':
        return await runShake(ctx);
    }
  };

  const onRunDrops = async () => {
    const motion: MotionKind = drops.motion;
    const runEi = { ...ei, apiKey: ei.apiKey.trim() };
    const shouldUpload = runEi.apiKey.length > 0;
    const wasHandTracking = handTrackingEnabled;
    setHandTrackingEnabled(false);
    setDropsCancelRequested(false);
    setDropsRunning(true);
    let uploaded = 0;
    let captured = 0;
    let failed = 0;
    let cancelled = false;
    const zipEntries: ZipEntry[] = [];
    try {
      // Allow a frame for CameraFeed to unmount and stop writing pinchTarget.
      await sleepCancellable(80);
      for (let i = 0; i < drops.count; i++) {
        const ctx: RunCtx = {
          motion,
          index: i + 1,
          total: drops.count,
        };
        const sampleSnapshot = await runMotion(ctx);

        if (sampleSnapshot.length === 0) {
          failed += 1;
          continue;
        }
        const fileName = buildFileName(`${motion}_${i + 1}`);
        if (shouldUpload) {
          try {
            const res = await uploadSample(
              { ...runEi, label: motion },
              sampleSnapshot,
              sampleRateHz,
              fileName,
              {
                mode: 'motion',
                shape: objectKind,
                sample_rate_hz: sampleRateHz,
                generator: 'procedural',
                motion,
                motion_index: i + 1,
                motion_total: drops.count,
              },
            );
            if (res.ok) uploaded += 1;
            else failed += 1;
          } catch {
            failed += 1;
          }
        } else {
          const body = await buildDataAcquisitionPayload(
            runEi,
            sampleSnapshot,
            sampleRateHz,
          );
          zipEntries.push({
            name: fileName,
            data: JSON.stringify(body, null, 2),
          });
          captured += 1;
        }
        setStatus(
          'busy',
          shouldUpload
            ? `Motions: ${uploaded} uploaded · ${failed} failed (of ${i + 1}/${drops.count})`
            : `Motions: ${captured} captured · ${failed} failed (of ${i + 1}/${drops.count})`,
        );
      }
      const headline = cancelled ? 'Procedural motions stopped' : 'Procedural motions complete';
      if (shouldUpload) {
        setStatus(
          cancelled || failed > 0 ? 'err' : 'ok',
          `${headline}: ${uploaded} uploaded${
            failed ? ` · ${failed} failed` : ''
          }`,
        );
      } else if (zipEntries.length > 0) {
        setStatus('busy', `Packaging ${zipEntries.length} motion samples…`);
        const zipName = buildFileName(
          `motions_${zipEntries.length}`,
        ).replace(/\.json$/, '.zip');
        const zip = await buildZip(zipEntries);
        await saveBlob({ kind: 'download' }, zipName, zip);
        setStatus(
          cancelled || failed > 0 ? 'err' : 'ok',
          `${headline}: downloaded ${zipEntries.length} samples${
            failed ? ` · ${failed} failed` : ''
          }`,
        );
      } else {
        setStatus(
          'err',
          `${headline}: no samples captured`,
        );
      }
    } catch (e) {
      if (e instanceof CancelledError) {
        cancelled = true;
        // Drain whatever finished before the cancel checkpoint into a zip
        // so the user keeps partial work when not uploading directly.
        if (!shouldUpload && zipEntries.length > 0) {
          try {
            setStatus('busy', `Packaging ${zipEntries.length} motion samples…`);
            const zipName = buildFileName(
              `motions_${zipEntries.length}`,
            ).replace(/\.json$/, '.zip');
            const zip = await buildZip(zipEntries);
            await saveBlob({ kind: 'download' }, zipName, zip);
          } catch {
            /* ignore zip failure on cancel */
          }
        }
        setStatus(
          'err',
          shouldUpload
            ? `Procedural motions stopped: ${uploaded} uploaded${
                failed ? ` · ${failed} failed` : ''
              }`
            : `Procedural motions stopped: ${zipEntries.length} samples saved`,
        );
      } else {
        setStatus('err', `Motions error: ${(e as Error).message}`);
      }
    } finally {
      setDropsRunning(false);
      setHandTrackingEnabled(wasHandTracking);
      setDropsCancelRequested(false);
      // Defensive cleanup in case an error left the rotation override set.
      setPinchRotation(null);
      // And release the body if a cancel happened mid-grab.
      releaseBody();
    }
  };

  const durationSec = samples.length / sampleRateHz;
  const hasApiKey = ei.apiKey.trim().length > 0;

  return (
    <>
      <div className="card">
        <h3>Object</h3>
        <select
          value={objectKind}
          onChange={(e) => setObjectKind(e.target.value as ObjectKind)}
        >
          {OBJECTS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <div className="webcam-control">
          <div className="webcam-control-copy">
            <div className="webcam-control-heading">
              <span className="webcam-control-title">Webcam control</span>
              <span
                className={`webcam-control-state ${
                  handTrackingEnabled ? 'on' : 'off'
                }`}
              >
                {handTrackingEnabled ? 'On' : 'Off'}
              </span>
            </div>
            <div className="webcam-control-help">
              {handTrackingEnabled
                ? 'Use hand tracking to pinch, grab, and throw.'
                : 'Camera stays off; procedural drops still work.'}
            </div>
          </div>
          <button
            type="button"
            className={`webcam-switch ${handTrackingEnabled ? 'on' : ''}`}
            role="switch"
            aria-checked={handTrackingEnabled}
            aria-label={
              handTrackingEnabled
                ? 'Turn webcam control off'
                : 'Turn webcam control on'
            }
            onClick={() => setHandTrackingEnabled(!handTrackingEnabled)}
            disabled={dropsRunning}
          >
            <span className="webcam-switch-thumb" />
          </button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          IMU samples are 6-channel: accelerometer (m/s²) + gyroscope (rad/s).
        </div>
      </div>

      <div className="card">
        <h3>Recording</h3>
        <label className="field">
          Label
          <input
            value={ei.label}
            onChange={(e) => setEi({ label: e.target.value })}
            placeholder="e.g. shake, idle, drop"
          />
        </label>
        <label className="field">
          Sample rate (Hz)
          <input
            type="number"
            min={20}
            max={500}
            step={10}
            value={sampleRateHz}
            onChange={(e) =>
              setSampleRateHz(
                Math.max(20, Math.min(500, Number(e.target.value) || 100)),
              )
            }
            disabled={isRecording}
          />
        </label>
        <div className="row">
          {isRecording ? (
            <button className="danger" onClick={stopRecording}>■ Stop</button>
          ) : (
            <button className="primary" onClick={startRecording}>● Record</button>
          )}
          <button onClick={clearSamples} disabled={isRecording || samples.length === 0}>
            Clear
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          {samples.length} samples · {durationSec.toFixed(2)}s
        </div>
      </div>

      <div className="card">
        <h3>Procedural motions</h3>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          Generate N samples automatically. Pick which motion classes to
          include — the runner cycles through them and records one labelled
          IMU trace per iteration. Webcam tracking is paused while running.
        </div>
        <div className="motion-pills" role="radiogroup" aria-label="Motion class">
          {ALL_MOTION_KINDS.map((kind) => {
            const selected = drops.motion === kind;
            return (
              <label
                key={kind}
                className={`motion-pill ${selected ? 'on' : ''}`}
              >
                <input
                  type="radio"
                  name="procedural-motion"
                  value={kind}
                  checked={selected}
                  disabled={dropsRunning}
                  onChange={() => setDrops({ motion: kind })}
                />
                {kind}
              </label>
            );
          })}
        </div>
        <div className="row">
          <label className="field">
            Count
            <input
              type="number"
              min={1}
              max={500}
              step={1}
              value={drops.count}
              onChange={(e) =>
                setDrops({ count: Number(e.target.value) || 10 })
              }
              disabled={dropsRunning}
            />
          </label>
          <label className="field">
            Per-drop ms
            <input
              type="number"
              min={300}
              max={6000}
              step={100}
              value={drops.durationMs}
              onChange={(e) =>
                setDrops({ durationMs: Number(e.target.value) || 1500 })
              }
              disabled={dropsRunning}
            />
          </label>
        </div>
        <label className="field">
          Drop height min {drops.heightMin.toFixed(2)} m
          <input
            type="range"
            min={0.3}
            max={4}
            step={0.05}
            value={drops.heightMin}
            onChange={(e) =>
              setDrops({
                heightMin: Math.min(
                  drops.heightMax - 0.05,
                  Number(e.target.value),
                ),
              })
            }
            disabled={dropsRunning}
          />
        </label>
        <label className="field">
          Drop height max {drops.heightMax.toFixed(2)} m
          <input
            type="range"
            min={0.3}
            max={4}
            step={0.05}
            value={drops.heightMax}
            onChange={(e) =>
              setDrops({
                heightMax: Math.max(
                  drops.heightMin + 0.05,
                  Number(e.target.value),
                ),
              })
            }
            disabled={dropsRunning}
          />
        </label>
        {dropsRunning ? (
          <button
            className="danger"
            onClick={() => setDropsCancelRequested(true)}
          >
            ■ Stop
          </button>
        ) : (
          <button
            className="primary"
            onClick={onRunDrops}
            disabled={isRecording}
          >
            {`⚡ Generate & ${
              hasApiKey ? 'upload' : 'download'
            } ${drops.count} samples`}
          </button>
        )}
      </div>

      <EiAuthCard showHmac />

      <div className="card">
        <h3>Upload to Edge Impulse</h3>
        {!ei.apiKey && (
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            Set your API key in the <strong>Edge Impulse · auth</strong>{' '}
            card above.
          </div>
        )}
        <button
          className="primary"
          onClick={onUpload}
          disabled={
            isRecording ||
            samples.length === 0 ||
            !ei.apiKey ||
            status.kind === 'busy'
          }
        >
          ⤴ Upload {samples.length} samples
        </button>
        <button
          onClick={onRetrainModel}
          disabled={!ei.apiKey || status.kind === 'busy'}
          title={
            !ei.apiKey ? 'Set your API key in the auth card first' : undefined
          }
        >
          ↻ Retrain model
        </button>
      </div>
    </>
  );
}
