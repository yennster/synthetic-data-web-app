import { useEffect, useRef, useState } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { CameraFeed } from './components/CameraFeed';
import { Hud } from './components/Hud';
import { InferenceOverlay } from './components/InferenceOverlay';
import { Scene } from './components/Scene';
import { Sidebar } from './components/Sidebar';
import { TouchResizeHandle } from './components/TouchResizeHandle';
import { useStore } from './store/useStore';
import { useRehydrateAssets } from './lib/rehydrateAssets';

const MAX_PREVIEW_DPR = 2;

function getPreviewPixelRatio(): number {
  if (typeof window === 'undefined') return 1;
  const ratio = window.devicePixelRatio || 1;
  return Math.max(1, Math.min(MAX_PREVIEW_DPR, ratio));
}

export default function App() {
  useRehydrateAssets();

  const mode = useStore((s) => s.mode);
  const captureSettings = useStore((s) => s.capture);
  const handTrackingEnabled = useStore((s) => s.handTrackingEnabled);

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
        {mode !== 'motion' && (
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
      </div>
      <button
        type="button"
        className="drawer-toggle"
        aria-label={drawerOpen ? 'Close controls' : 'Open controls'}
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen((v) => !v)}
      >
        {drawerOpen ? '✕' : '☰'}
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
