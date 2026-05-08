/**
 * Touch-only resize handle for the bottom-right corner of a `.cam-overlay`
 * (or any horizontally-resizable container). Mobile browsers don't honour
 * the CSS `resize: horizontal` property for touch input, so on phones the
 * native handle is dead — we layer this real interactive element on top
 * of the existing ::after corner indicator and drive width changes from
 * touch events directly. Desktop mouse users keep the native handle; this
 * one is hidden via CSS at >768px.
 *
 * Implementation notes:
 *  - We use window-level touchmove/touchend listeners (added on touchstart)
 *    so the gesture continues even when the finger leaves the small handle
 *    region.
 *  - touchmove gets `preventDefault()` so the browser doesn't treat the
 *    drag as a page scroll. That requires `{passive: false}`.
 *  - We mutate `parent.style.width` directly. Callers that mirror the
 *    width into React state (e.g. App.tsx's ResizeObserver-driven
 *    `previewW`) pick the change up automatically.
 */
const MIN_W = 120;
const MAX_VW_RATIO = 0.9;

export function TouchResizeHandle() {
  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    const parent = e.currentTarget.parentElement as HTMLElement | null;
    if (!parent) return;
    e.stopPropagation();
    const startX = e.touches[0].clientX;
    const startW = parent.offsetWidth;

    const onMove = (ev: TouchEvent) => {
      if (ev.touches.length === 0) return;
      ev.preventDefault();
      const dx = ev.touches[0].clientX - startX;
      const maxW = window.innerWidth * MAX_VW_RATIO;
      const newW = Math.max(MIN_W, Math.min(maxW, startW + dx));
      parent.style.width = `${newW}px`;
    };
    const onEnd = () => {
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
  };

  return (
    <div
      className="touch-resize-handle"
      role="separator"
      aria-label="Resize preview"
      onTouchStart={onTouchStart}
    />
  );
}
