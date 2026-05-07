import { useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';

/**
 * Draws Edge Impulse model output (bounding boxes for object detection,
 * centroid dots for FOMO, heatmap cells for visual anomaly) on top of the
 * virtual-camera preview canvas. Coordinates from the model are in INPUT
 * pixel space (e.g. 96×96), so we rescale to overlay-pixel space using the
 * loaded model's input dimensions.
 *
 * We draw to a sibling <canvas> sized to match the preview canvas, sitting
 * on top of it via absolute positioning. No SVG — staying in canvas keeps
 * us in the same reference frame as the preview, which simplifies scaling
 * and avoids subpixel mismatches.
 */
export function InferenceOverlay({
  width,
  height,
}: {
  width: number;
  height: number;
}) {
  const result = useStore((s) => s.eiResult);
  const info = useStore((s) => s.eiModelInfo);
  const threshold = useStore((s) => s.eiThreshold);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!result || !info) return;

    const sx = width / info.inputWidth;
    const sy = height / info.inputHeight;

    // FOMO models output 1×1 cells whose center is the centroid; draw both
    // the box (light) and a stronger center dot. Standard object detection
    // bbox sizes are larger so the same renderer Just Works.
    const visible = result.bounding_boxes.filter((b) => b.value >= threshold);
    for (const b of visible) {
      const x = b.x * sx;
      const y = b.y * sy;
      const w = b.width * sx;
      const h = b.height * sy;
      const isFomo = b.width <= info.inputWidth / 8 && b.height <= info.inputHeight / 8;

      // Outline
      ctx.lineWidth = 2;
      ctx.strokeStyle = colorFor(b.label);
      ctx.fillStyle = colorFor(b.label, 0.18);
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.fill();
      ctx.stroke();

      // Centroid dot — extra-prominent for FOMO
      const cx = x + w / 2;
      const cy = y + h / 2;
      ctx.fillStyle = colorFor(b.label);
      ctx.beginPath();
      ctx.arc(cx, cy, isFomo ? 5 : 3, 0, Math.PI * 2);
      ctx.fill();

      // Label
      const text = `${b.label} ${(b.value * 100).toFixed(0)}%`;
      ctx.font = '10px ui-monospace, monospace';
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(x, Math.max(0, y - 12), tw + 6, 12);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, x + 3, Math.max(9, y - 3));
    }

    // Visual anomaly heatmap (if present) — translucent red overlay
    // proportional to value.
    if (result.visual_ad_grid_cells && result.visual_ad_grid_cells.length > 0) {
      for (const c of result.visual_ad_grid_cells) {
        if (c.value < threshold) continue;
        ctx.fillStyle = `rgba(248,113,113,${Math.min(0.7, c.value)})`;
        ctx.fillRect(c.x * sx, c.y * sy, c.width * sx, c.height * sy);
      }
    }
  }, [result, info, threshold, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        transform: 'none',
        zIndex: 3,
      }}
    />
  );
}

// Stable label-to-color so the same class always draws the same hue.
function colorFor(label: string, alpha = 1): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) {
    h = (h * 31 + label.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return alpha === 1 ? `hsl(${hue} 80% 60%)` : `hsla(${hue} 80% 60% / ${alpha})`;
}
