import { useStore, type ObjectKind } from '../store/useStore';
import { buildFileName, uploadSample } from '../lib/edgeImpulse';
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
  } = useStore();

  const onUpload = async () => {
    setStatus('busy', 'Uploading…');
    try {
      const res = await uploadSample(
        ei,
        samples,
        sampleRateHz,
        buildFileName(ei.label),
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
   *     6. stop recording, snapshot samples, upload to EI.
   *
   * Hand tracking is auto-disabled for the duration so the CameraFeed
   * doesn't fight with our scripted pinchTarget writes.
   */
  const onRunDrops = async () => {
    if (!ei.apiKey) {
      setStatus('err', 'Set your API key first');
      return;
    }
    const wasHandTracking = handTrackingEnabled;
    setHandTrackingEnabled(false);
    setDropsRunning(true);
    let uploaded = 0;
    let failed = 0;
    try {
      // Allow a frame for CameraFeed to unmount and stop writing pinchTarget.
      await sleep(80);
      for (let i = 0; i < drops.count; i++) {
        setStatus('busy', `Drop ${i + 1}/${drops.count}: lifting…`);
        const x = (Math.random() - 0.5) * 1.2;
        const y =
          drops.heightMin + Math.random() * (drops.heightMax - drops.heightMin);
        const z = (Math.random() - 0.5) * 1.2;
        setPinchTarget([x, y, z]);
        setGrabbed(true);
        // Wait for the kinematic lerp to converge on the lift target. The
        // manipulator uses FOLLOW_LERP=0.35 per frame; 600ms is enough at
        // 60Hz to reach within ~2cm of any reachable point.
        await sleep(600);

        startRecording();
        // Brief beat so the first sample is captured before release —
        // otherwise the very first reading would be the kinematic body's
        // pre-release linvel, which is artificial.
        await sleep(40);

        setStatus('busy', `Drop ${i + 1}/${drops.count}: falling…`);
        setGrabbed(false);
        setPinchTarget(null);

        await sleep(drops.durationMs);

        stopRecording();
        const sampleSnapshot = useStore.getState().samples.slice();
        clearSamples();

        if (sampleSnapshot.length === 0) {
          failed += 1;
          continue;
        }
        try {
          const res = await uploadSample(
            ei,
            sampleSnapshot,
            sampleRateHz,
            buildFileName(`${ei.label || 'drop'}_${i + 1}`),
          );
          if (res.ok) uploaded += 1;
          else failed += 1;
        } catch {
          failed += 1;
        }
        setStatus(
          'busy',
          `Drops: ${uploaded} uploaded · ${failed} failed (of ${i + 1}/${drops.count})`,
        );
      }
      setStatus(
        failed === 0 ? 'ok' : 'err',
        `Procedural drops complete: ${uploaded} uploaded${
          failed ? ` · ${failed} failed` : ''
        }`,
      );
    } catch (e) {
      setStatus('err', `Drops error: ${(e as Error).message}`);
    } finally {
      setDropsRunning(false);
      setHandTrackingEnabled(wasHandTracking);
    }
  };

  const durationSec = samples.length / sampleRateHz;

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
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          <input
            type="checkbox"
            checked={handTrackingEnabled}
            onChange={(e) => setHandTrackingEnabled(e.target.checked)}
            style={{ width: 'auto', flex: 'none' }}
          />
          <span>Webcam hand tracking</span>
        </label>
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
        <h3>Procedural drops</h3>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          Generate N drops automatically — each lifts the object to a random
          height, releases it, records the IMU trace, and uploads as a
          separate sample. Webcam tracking is paused while running.
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
        <button
          className="primary"
          onClick={onRunDrops}
          disabled={dropsRunning || !ei.apiKey || isRecording}
          title={!ei.apiKey ? 'Set your API key first' : undefined}
        >
          {dropsRunning
            ? '… running'
            : `⚡ Generate & upload ${drops.count} drops`}
        </button>
      </div>

      <EiAuthCard showHmac />

      <div className="card">
        <h3>Upload to Edge Impulse</h3>
        {!ei.apiKey && (
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            Set your API key in the <strong>Edge Impulse · auth</strong>
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
      </div>
    </>
  );
}
