/**
 * Pointer-driven resize handle for the top-right corner of a
 * `.cam-overlay`. Replaces the native CSS `resize: horizontal` (which
 * is bottom-right only and ignores touch input) with a unified
 * Pointer Events implementation that works for both mouse and touch.
 *
 * Implementation notes:
 *  - On pointerdown we capture the pointer to this element so move
 *    events keep arriving even if the cursor/finger leaves the handle.
 *  - We listen on window for move/up so the gesture survives leaving
 *    the handle bounds without losing tracking.
 *  - The handle mutates `parent.style.width` directly. Callers that
 *    mirror that into React state (e.g. App.tsx's ResizeObserver →
 *    `previewW`) pick up the change automatically.
 *  - Drag right ⇒ grow, drag left ⇒ shrink. Same delta-x semantics
 *    work whether the handle is bottom-right or top-right.
 */
import { clamp } from '../lib/math';

const MIN_W = 120;
const MAX_VW_RATIO = 0.9;

export function TouchResizeHandle() {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const parent = e.currentTarget.parentElement as HTMLElement | null;
    if (!parent) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = parent.offsetWidth;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const maxW = window.innerWidth * MAX_VW_RATIO;
      const newW = clamp(startW + dx, MIN_W, maxW);
      parent.style.width = `${newW}px`;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  return (
    <div
      className="cam-resize-handle"
      role="separator"
      aria-label="Resize preview"
      onPointerDown={onPointerDown}
    />
  );
}
