import { useStore, type AppMode } from '../store/useStore';
import { MotionPanel } from './MotionPanel';
import { VisionPanel } from './VisionPanel';

/* The Edge Impulse · auth card used to live between Mode and the panels.
 * It moved into MotionPanel and VisionPanel so it sits next to the
 * upload/inference actions that consume it (after Capture in vision,
 * before Upload in motion). */

const MODES: { value: AppMode; label: string; hint: string }[] = [
  { value: 'motion', label: 'Motion', hint: 'Accelerometer' },
  { value: 'detection', label: 'Object detection', hint: 'Images + bboxes' },
  { value: 'anomaly', label: 'Visual anomaly', hint: 'Images, batch label' },
];

export function Sidebar() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const status = useStore((s) => s.status);

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

      {status.msg && (
        <div className={`status ${status.kind}`}>{status.msg}</div>
      )}
    </aside>
  );
}
