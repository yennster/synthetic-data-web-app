import {
  lazy,
  Suspense,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useStore, type AppMode } from '../store/useStore';
import { URL_PRESETS } from '../lib/urlParams';
import { ThemeToggle } from './ThemeToggle';

const MotionPanel = lazy(() =>
  import('./MotionPanel').then((mod) => ({ default: mod.MotionPanel })),
);
const RobotPanel = lazy(() =>
  import('./RobotPanel').then((mod) => ({ default: mod.RobotPanel })),
);
const VisionPanel = lazy(() =>
  import('./VisionPanel').then((mod) => ({ default: mod.VisionPanel })),
);

/* The Edge Impulse · auth card used to live between Mode and the panels.
 * It moved into MotionPanel and VisionPanel so it sits next to the
 * upload/inference actions that consume it (after Capture in vision,
 * before Upload in motion). */

const ALL_MODES: { value: AppMode; label: string; hint: string }[] = [
  { value: 'motion', label: 'Motion', hint: 'Accelerometer' },
  { value: 'detection', label: 'Object detection', hint: 'Images + bboxes' },
  { value: 'anomaly', label: 'Visual anomaly', hint: 'Images, batch label' },
  { value: 'robot', label: 'Robotics', hint: 'Rover & Arm telemetry' },
];

/** `?onlyMode=` filters this list down. When unset, all modes are
 * shown. When set to a single mode, the Mode card collapses to a
 * single button (still useful as a label/affordance). */
const MODES = (() => {
  const only = URL_PRESETS.onlyMode;
  if (!only || only.length === 0) return ALL_MODES;
  const keep = new Set(only);
  return ALL_MODES.filter((m) => keep.has(m.value));
})();

const STATUS_LABELS = {
  idle: 'Status',
  busy: 'Working',
  ok: 'Done',
  err: 'Issue',
} as const;

/* Right-edge drawer dismiss thresholds. The drawer slides in from the
 * right, so dragging *right* (positive dx) moves it back off-screen.
 * Either crossing 30% of width, or a fast flick (>0.5 px/ms), commits
 * the close — anything less snaps back. */
const SWIPE_DISTANCE_RATIO = 0.3;
const SWIPE_VELOCITY_PX_PER_MS = 0.5;

export function Sidebar({
  drawerOpen = false,
  onClose,
}: {
  drawerOpen?: boolean;
  onClose?: () => void;
} = {}) {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const status = useStore((s) => s.status);

  const asideRef = useRef<HTMLElement | null>(null);
  // Track the in-flight swipe in a ref so onTouchMove doesn't churn
  // re-renders for every pointer sample. `axisLocked` lets us decide
  // once per gesture whether the user is swiping horizontally (drag the
  // drawer) or vertically (let the sidebar scroll naturally).
  const gesture = useRef<{
    startX: number;
    startY: number;
    startTime: number;
    axisLocked: 'horizontal' | 'vertical' | null;
  } | null>(null);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);

  const onTouchStart = (e: React.TouchEvent) => {
    if (!drawerOpen || !onClose) return;
    const t = e.touches[0];
    gesture.current = {
      startX: t.clientX,
      startY: t.clientY,
      startTime: Date.now(),
      axisLocked: null,
    };
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const g = gesture.current;
    if (!g) return;
    const t = e.touches[0];
    const dx = t.clientX - g.startX;
    const dy = t.clientY - g.startY;
    // First meaningful movement decides axis. ~10px deadzone keeps
    // small jitter from accidentally starting a horizontal drag while
    // the user is just tapping/scrolling.
    if (g.axisLocked === null) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      g.axisLocked = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
    }
    if (g.axisLocked !== 'horizontal') return;
    // Only react to right-swipes (closing direction). Leftward drag
    // would push the drawer past its open position; ignore.
    if (dx <= 0) {
      setDragX(0);
      setDragging(false);
      return;
    }
    setDragging(true);
    setDragX(dx);
  };

  const onTouchEnd = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.axisLocked !== 'horizontal') {
      setDragX(0);
      setDragging(false);
      return;
    }
    const elapsed = Math.max(1, Date.now() - g.startTime);
    const velocity = dragX / elapsed;
    const width = asideRef.current?.offsetWidth ?? 320;
    const shouldClose =
      dragX > width * SWIPE_DISTANCE_RATIO ||
      velocity > SWIPE_VELOCITY_PX_PER_MS;
    setDragging(false);
    setDragX(0);
    if (shouldClose) onClose?.();
  };

  // While the finger is down we override the CSS transform with the live
  // drag offset and disable the slide transition so the drawer follows
  // the finger 1:1. On release we drop the inline style and let CSS
  // animate either back to 0 (snap) or to translateX(100%) (close).
  const dragStyle: CSSProperties | undefined = dragging
    ? {
        transform: `translateX(${dragX}px)`,
        transition: 'none',
      }
    : undefined;

  return (
    <aside
      ref={asideRef}
      className={`sidebar${drawerOpen ? ' open' : ''}`}
      style={dragStyle}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div className="sidebar-scroll">
        <div className="card">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <h3>Mode</h3>
            <ThemeToggle />
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
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

        <Suspense
          fallback={
            <div className="card panel-loading">Loading controls...</div>
          }
        >
          {mode === 'motion' ? (
            <MotionPanel />
          ) : mode === 'robot' ? (
            <RobotPanel />
          ) : (
            <VisionPanel />
          )}
        </Suspense>
      </div>

      {status.msg && (
        <div
          className={`status ${status.kind}`}
          role="status"
          aria-live={status.kind === 'err' ? 'assertive' : 'polite'}
        >
          <span className="status-kind">{STATUS_LABELS[status.kind]}</span>
          <span className="status-msg" title={status.msg}>
            {status.msg}
          </span>
        </div>
      )}
    </aside>
  );
}
