import { useStore, type ObjectKind } from '../store/useStore';
import { buildFileName, uploadSample } from '../lib/edgeImpulse';

const OBJECTS: { value: ObjectKind; label: string }[] = [
  { value: 'cube', label: 'Cube' },
  { value: 'sphere', label: 'Sphere' },
  { value: 'phone', label: 'Phone slab' },
  { value: 'capsule', label: 'Capsule' },
];

export function Sidebar() {
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

  const durationSec = samples.length / sampleRateHz;

  return (
    <aside className="sidebar">
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
            <button className="danger" onClick={stopRecording}>
              ■ Stop
            </button>
          ) : (
            <button className="primary" onClick={startRecording}>
              ● Record
            </button>
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
        <h3>Edge Impulse</h3>
        <label className="field">
          API Key
          <input
            type="password"
            value={ei.apiKey}
            onChange={(e) => setEi({ apiKey: e.target.value })}
            placeholder="ei_..."
            autoComplete="off"
          />
        </label>
        <label className="field">
          HMAC Key (optional)
          <input
            type="password"
            value={ei.hmacKey}
            onChange={(e) => setEi({ hmacKey: e.target.value })}
            placeholder="leave blank for unsigned"
            autoComplete="off"
          />
        </label>
        <label className="field">
          Category
          <select
            value={ei.category}
            onChange={(e) =>
              setEi({ category: e.target.value as 'training' | 'testing' })
            }
          >
            <option value="training">Training</option>
            <option value="testing">Testing</option>
          </select>
        </label>
        <label className="field">
          Device name
          <input
            value={ei.device}
            onChange={(e) => setEi({ device: e.target.value })}
          />
        </label>

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
          ⤴ Upload to Edge Impulse
        </button>

        {status.msg && (
          <div className={`status ${status.kind}`}>{status.msg}</div>
        )}
      </div>

      <div className="card">
        <h3>How to use</h3>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
          <li>Allow camera access.</li>
          <li>Show your hand to the camera.</li>
          <li>Pinch (thumb + index) to grab the object.</li>
          <li>Move your hand to manipulate it in 3D.</li>
          <li>Release the pinch to drop / throw it.</li>
          <li>Hit Record before performing the gesture.</li>
        </ol>
      </div>
    </aside>
  );
}
