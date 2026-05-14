import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { URL_FLAGS } from '../lib/urlParams';

export function Hud() {
  // `?embed=1` strips the HUD entirely for clean iframe embeds. Hook
  // placement keeps subsequent hooks unconditional (we just early-
  // return before subscribing).
  if (URL_FLAGS.embed) return null;
  return <HudPills />;
}

const TIP_STORAGE_KEY = 'sds-hud-tip-open';

/** Read the persisted tip-open preference, defaulting to open. The
 * preference survives reloads so a user who closed the tip once
 * doesn't get it back every time they open the app. */
function readTipOpen(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const v = window.localStorage.getItem(TIP_STORAGE_KEY);
    return v === null ? true : v !== '0';
  } catch {
    return true;
  }
}

function writeTipOpen(open: boolean): void {
  try {
    window.localStorage.setItem(TIP_STORAGE_KEY, open ? '1' : '0');
  } catch {
    // ignore — private mode / quota
  }
}

/** One shortcut row in the tip pill. */
type TipShortcut = { keys: string; label: string };

/** Tip card for vision / robotics modes. The pill is dismissable —
 * the user's preference persists across reloads so power users who
 * know the shortcuts stay out of their way after closing it once.
 * When closed, a tiny "?" button replaces the pill so the help is
 * always one click away. */
function TipPill({ shortcuts }: { shortcuts: TipShortcut[] }) {
  const [open, setOpen] = useState<boolean>(readTipOpen);
  useEffect(() => {
    writeTipOpen(open);
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        className="pill tip tip-toggle"
        aria-label="Show keyboard shortcut tips"
        title="Show keyboard shortcut tips"
        onClick={() => setOpen(true)}
      >
        ?
      </button>
    );
  }

  return (
    <div className="pill tip" role="region" aria-label="Keyboard shortcuts">
      <button
        type="button"
        className="tip-close"
        aria-label="Hide keyboard shortcut tips"
        title="Hide tips"
        onClick={() => setOpen(false)}
      >
        ×
      </button>
      <div className="tip-header">Shortcuts</div>
      <ul className="tip-list">
        {shortcuts.map((s) => (
          <li key={s.keys}>
            <span className="tip-keys">{s.keys}</span>
            <span className="tip-label">{s.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const VISION_SHORTCUTS: TipShortcut[] = [
  { keys: 'Click', label: 'select object' },
  { keys: 'Cmd/Ctrl-click', label: 'multi-select' },
  { keys: 'Esc', label: 'clear selection' },
  { keys: '[ / ]', label: 'rotate selection (or all)' },
  { keys: 'Q / E', label: 'rotate camera around target' },
  { keys: '← → ↑ ↓', label: 'pan the framed view' },
  { keys: 'Shift+drag', label: 'move object (Alt/Cmd = depth)' },
  { keys: 'Right-drag', label: 'pan camera (mouse)' },
];

function HudPills() {
  const mode = useStore((s) => s.mode);
  const handDetected = useStore((s) => s.handDetected);
  const pinchStrength = useStore((s) => s.pinchStrength);
  const isGrabbed = useStore((s) => s.isGrabbed);
  const isRecording = useStore((s) => s.isRecording);
  const samples = useStore((s) => s.samples);
  const captures = useStore((s) => s.captures);
  const robotCaptures = useStore((s) => s.robotCaptures);
  const sceneObjects = useStore((s) => s.sceneObjects);
  const assets = useStore((s) => s.assets);
  const restoring = useStore((s) => s.restoringAssets);

  if (mode === 'motion') {
    return (
      <div className="hud">
        <div className={`pill ${handDetected ? 'live' : ''}`}>
          Hand: {handDetected ? 'tracked' : '—'}
        </div>
        <div className="pill">Pinch: {(pinchStrength * 100).toFixed(0)}%</div>
        <div className={`pill ${isGrabbed ? 'live' : ''}`}>
          {isGrabbed ? 'Grabbed' : 'Released'}
        </div>
        {isRecording && <div className="pill rec">● REC · {samples.length}</div>}
        {restoring.phase === 'busy' && (
          <div className="pill" title="Re-importing USDZ assets saved from a previous session">
            ⟳ Restoring {restoring.done}/{restoring.total}…
          </div>
        )}
        {restoring.phase === 'success' && (
          <div className="pill live" title="USDZ assets restored from saved storage">
            ✓ Success!
          </div>
        )}
      </div>
    );
  }

  const modeLabel =
    mode === 'detection'
      ? 'object detection'
      : mode === 'anomaly'
        ? 'visual anomaly'
        : mode === 'robot'
          ? 'robotics'
          : mode;

  // Robotics mode produces rosbag / timeseries captures via RobotPanel
  // (no image-capture path), so the vision `captures` array stays empty.
  // Surface the robotics-run counter instead so the pill actually updates.
  const captureCount = mode === 'robot' ? robotCaptures : captures.length;

  return (
    <div className="hud">
      <div className="pill">Mode: {modeLabel}</div>
      <div className="pill">Objects: {sceneObjects.length + assets.length}</div>
      <div className={`pill ${captureCount > 0 ? 'live' : ''}`}>
        Captures: {captureCount}
      </div>
      <TipPill shortcuts={VISION_SHORTCUTS} />
      {restoring.phase === 'busy' && (
        <div className="pill" title="Re-importing USDZ assets saved from a previous session">
          ⟳ Restoring {restoring.done}/{restoring.total}…
        </div>
      )}
      {restoring.phase === 'success' && (
        <div className="pill live" title="USDZ assets restored from saved storage">
          ✓ Success!
        </div>
      )}
    </div>
  );
}
