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

      // Outline — thick, high-contrast against any background. Black
      // halo underneath the colored stroke makes it visible on both
      // light and dark scene content.
      const color = colorFor(b.label);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeRect(x, y, w, h);
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.fillStyle = colorFor(b.label, 0.15);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);

      // Centroid dot — extra-prominent for FOMO
      const cx = x + w / 2;
      const cy = y + h / 2;
      ctx.fillStyle = color;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, isFomo ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Label pill above the box (or below if too close to top)
      const text = `${b.label} ${(b.value * 100).toFixed(0)}%`;
      ctx.font = 'bold 11px ui-monospace, monospace';
      const tw = ctx.measureText(text).width;
      const pillH = 14;
      const labelAbove = y - pillH >= 0;
      const labelY = labelAbove ? y - pillH : y;
      ctx.fillStyle = color;
      ctx.fillRect(x, labelY, tw + 8, pillH);
      ctx.fillStyle = '#0b0d10';
      ctx.fillText(text, x + 4, labelY + pillH - 3);
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
