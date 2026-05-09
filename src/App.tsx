import { useEffect, useRef, useState } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { CameraFeed } from './components/CameraFeed';
import { Hud } from './components/Hud';
import { InferenceOverlay } from './components/InferenceOverlay';
import { Scene } from './components/Scene';
import { Sidebar } from './components/Sidebar';
import { TouchResizeHandle } from './components/TouchResizeHandle';
import { useStore, type AppMode } from './store/useStore';
import { useRehydrateAssets } from './lib/rehydrateAssets';

/**
 * Map a `?mode=` query value to the canonical `AppMode`. Accepts a few
 * forgiving aliases (e.g. `robotics`, `objects`) so deep-link URLs read
 * naturally. Returns null when the value isn't recognized — the caller
 * leaves the persisted/default mode alone in that case.
 */
function parseModeQuery(raw: string | null): AppMode | null {
  if (!raw) return null;
  switch (raw.toLowerCase()) {
    case 'motion':
    case 'imu':
    case 'accel':
      return 'motion';
    case 'detection':
    case 'object':
    case 'objects':
    case 'object-detection':
      return 'detection';
    case 'anomaly':
    case 'visual-anomaly':
      return 'anomaly';
    case 'robot':
    case 'robotics':
    case 'rover':
    case 'arm':
      return 'robot';
    default:
      return null;
  }
}

const MAX_PREVIEW_DPR = 2;

function getPreviewPixelRatio(): number {
  if (typeof window === 'undefined') return 1;
  const ratio = window.devicePixelRatio || 1;
  return Math.max(1, Math.min(MAX_PREVIEW_DPR, ratio));
}

export default function App() {
  useRehydrateAssets();

  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const captureSettings = useStore((s) => s.capture);
  const handTrackingEnabled = useStore((s) => s.handTrackingEnabled);

  // One-time URL sync at startup: if the user landed via a deep link with
  // `?mode=robotics` (or any of its aliases) and that's a different mode
  // from the persisted one, switch over before first paint. Also extends
  // to a `robotKind` sub-mode (`?robot=arm` / `?robot=rover`) for robotics
  // links that need to land on a specific rig. We only consume the
  // params at mount; subsequent in-app mode toggles don't push to the
  // URL — keeps the back-button behaving the way users expect for a
  // single-page tool.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const wantedMode = parseModeQuery(params.get('mode'));
    if (wantedMode && wantedMode !== useStore.getState().mode) {
      setMode(wantedMode);
    }
    const wantedRobot = params.get('robot');
    if (wantedRobot === 'arm' || wantedRobot === 'rover') {
      const setRobot = useStore.getState().setRobot;
      setRobot({ kind: wantedRobot });
    }
    // Run once at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [previewCanvas, setPreviewCanvas] = useState<HTMLCanvasElement | null>(
    null,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  // User-resizable preview width. Height is derived from capture aspect so
  // the canvas content never distorts. CSS `resize: horizontal` on the
  // .cam-overlay drives this via a ResizeObserver.
  const [previewW, setPreviewW] = useState(240);
  const [previewDpr, setPreviewDpr] = useState(getPreviewPixelRatio);

  useEffect(() => {
    if (previewRef.current) setPreviewCanvas(previewRef.current);
  }, []);

  useEffect(() => {
    const updatePixelRatio = () => setPreviewDpr(getPreviewPixelRatio());
    updatePixelRatio();
    window.addEventListener('resize', updatePixelRatio);
    return () => window.removeEventListener('resize', updatePixelRatio);
  }, []);

  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const borderBox = Array.isArray(entry.borderBoxSize)
          ? entry.borderBoxSize[0]
          : entry.borderBoxSize;
        const w = Math.round(
          borderBox?.inlineSize ?? entry.target.getBoundingClientRect().width,
        );
        if (w > 0) setPreviewW((prev) => (prev === w ? prev : w));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);

  const aspect = captureSettings.width / captureSettings.height;
  const previewH = Math.round(previewW / aspect);
  const previewPixelW = Math.max(1, Math.round(previewW * previewDpr));
  const previewPixelH = Math.max(1, Math.round(previewH * previewDpr));

  return (
    <div className="app">
      <div className="scene">
        <Scene previewCanvas={previewCanvas} />
        <Hud />
        {mode === 'motion' && handTrackingEnabled && <CameraFeed />}
        {(mode === 'detection' || mode === 'anomaly') && (
          <div
            ref={overlayRef}
            className="cam-overlay resizable"
            style={{
              width: previewW,
              height: previewH,
              transform: 'none',
            }}
          >
            <span className="label">Virtual camera · drag ↗</span>
            <canvas
              ref={(el) => {
                previewRef.current = el;
                setPreviewCanvas(el);
              }}
              width={previewPixelW}
              height={previewPixelH}
              style={{ transform: 'none' }}
            />
            <InferenceOverlay
              width={previewW}
              height={previewH}
              pixelRatio={previewDpr}
            />
            <TouchResizeHandle />
          </div>
        )}
        {mode === 'robot' && (
          <div
            ref={overlayRef}
            className="cam-overlay resizable"
            style={{
              width: previewW,
              height: previewH,
              transform: 'none',
            }}
          >
            <span className="label">Robot POV · drag ↗</span>
            <canvas
              ref={(el) => {
                previewRef.current = el;
                setPreviewCanvas(el);
              }}
              width={previewPixelW}
              height={previewPixelH}
              style={{ transform: 'none' }}
            />
            <TouchResizeHandle />
          </div>
        )}
      </div>
      <button
        type="button"
        className="drawer-toggle"
        aria-label={drawerOpen ? 'Close controls' : 'Open controls'}
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen((v) => !v)}
      >
        {drawerOpen ? (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        )}
      </button>
      {drawerOpen && (
        <div
          className="drawer-backdrop"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <Sidebar drawerOpen={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <Analytics />
    </div>
  );
}
