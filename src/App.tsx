import { useEffect, useRef, useState } from 'react';
import { CameraFeed } from './components/CameraFeed';
import { Hud } from './components/Hud';
import { InferenceOverlay } from './components/InferenceOverlay';
import { Scene } from './components/Scene';
import { Sidebar } from './components/Sidebar';
import { useStore } from './store/useStore';

export default function App() {
  const mode = useStore((s) => s.mode);
  const captureSettings = useStore((s) => s.capture);

  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [previewCanvas, setPreviewCanvas] = useState<HTMLCanvasElement | null>(
    null,
  );
  // User-resizable preview width. Height is derived from capture aspect so
  // the canvas content never distorts. CSS `resize: horizontal` on the
  // .cam-overlay drives this via a ResizeObserver.
  const [previewW, setPreviewW] = useState(240);

  useEffect(() => {
    if (previewRef.current) setPreviewCanvas(previewRef.current);
  }, []);

  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.round(entry.contentRect.width);
        if (w > 0) setPreviewW(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);

  const aspect = captureSettings.width / captureSettings.height;
  const previewH = Math.round(previewW / aspect);

  return (
    <div className="app">
      <div className="scene">
        <Scene previewCanvas={previewCanvas} />
        <Hud />
        {mode === 'motion' && <CameraFeed />}
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
            <span className="label">Virtual camera · preview · drag ↘</span>
            <canvas
              ref={(el) => {
                previewRef.current = el;
                setPreviewCanvas(el);
              }}
              width={previewW}
              height={previewH}
              style={{ transform: 'none' }}
            />
            <InferenceOverlay width={previewW} height={previewH} />
          </div>
        )}
      </div>
      <Sidebar />
    </div>
  );
}
