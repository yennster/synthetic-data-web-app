import { useEffect, useRef, useState } from 'react';
import { Analytics } from '@vercel/analytics/react';
import { CameraFeed } from './components/CameraFeed';
import { Hud } from './components/Hud';
import { Scene } from './components/Scene';
import { Sidebar } from './components/Sidebar';
import { useStore } from './store/useStore';

export default function App() {
  const mode = useStore((s) => s.mode);
  const captureSettings = useStore((s) => s.capture);

  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const [previewCanvas, setPreviewCanvas] = useState<HTMLCanvasElement | null>(
    null,
  );

  useEffect(() => {
    if (previewRef.current) setPreviewCanvas(previewRef.current);
  }, []);

  // Maintain preview canvas aspect to match capture aspect
  const aspect = captureSettings.width / captureSettings.height;
  const previewW = 240;
  const previewH = Math.round(previewW / aspect);

  return (
    <div className="app">
      <div className="scene">
        <Scene previewCanvas={previewCanvas} />
        <Hud />
        {mode === 'motion' && <CameraFeed />}
        {mode !== 'motion' && (
          <div
            className="cam-overlay"
            style={{
              width: previewW,
              height: previewH,
              transform: 'none',
            }}
          >
            <span className="label">Virtual camera · preview</span>
            <canvas
              ref={(el) => {
                previewRef.current = el;
                setPreviewCanvas(el);
              }}
              width={previewW}
              height={previewH}
              style={{ transform: 'none' }}
            />
          </div>
        )}
      </div>
      <Sidebar />
      <Analytics />
    </div>
  );
}
