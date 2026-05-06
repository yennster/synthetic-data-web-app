import { useStore, type AppMode } from '../store/useStore';
import { MotionPanel } from './MotionPanel';
import { VisionPanel } from './VisionPanel';

const MODES: { value: AppMode; label: string; hint: string }[] = [
  { value: 'motion', label: 'Motion', hint: 'Accelerometer' },
  { value: 'detection', label: 'Object detection', hint: 'Images + bboxes' },
  { value: 'anomaly', label: 'Visual anomaly', hint: 'Images, batch label' },
];

export function Sidebar() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const status = useStore((s) => s.status);
  const ei = useStore((s) => s.ei);
  const setEi = useStore((s) => s.setEi);

  return (
    <aside className="sidebar">
      <div className="card">
        <h3>Mode</h3>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 4,
          }}
        >
          {MODES.map((m) => (
            <button
              key={m.value}
              className={mode === m.value ? 'primary' : ''}
              onClick={() => setMode(m.value)}
              title={m.hint}
              style={{ padding: '8px 4px', fontSize: 11 }}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {MODES.find((m) => m.value === mode)?.hint}
        </div>
      </div>

      {mode === 'motion' ? <MotionPanel /> : <VisionPanel />}

      {/* Common: HMAC + device + status (motion-only fields are duplicated; keep central status) */}
      {mode === 'motion' && (
        <div className="card">
          <h3>Edge Impulse · auth</h3>
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
        </div>
      )}

      {status.msg && (
        <div className={`status ${status.kind}`}>{status.msg}</div>
      )}
    </aside>
  );
}
