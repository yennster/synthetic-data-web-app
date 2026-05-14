import { type ReactNode, useState } from 'react';
import { useStore } from '../store/useStore';

/**
 * Sidebar card with a chevron toggle in the heading — same visual
 * language as Arm home pose and Realism. Used by every panel so the
 * user can collapse cards they don't need to keep the sidebar
 * compact. The top card in each mode/sub-mode passes `defaultOpen` so
 * the user lands on something useful instead of a stack of headers.
 *
 * `badge` is shown next to the heading when collapsed (e.g. the
 * realism card's "random · 60%") so the active state is visible
 * without expanding.
 *
 * Open/closed state persists across reloads via the Zustand store
 * (`state.cardOpen`). The key is, in priority order:
 *   1. The explicit `storageKey` prop — required for cards whose
 *      heading text changes at runtime (e.g. "Objects (3)"), since
 *      using the heading directly would lose persistence the moment
 *      the count updates.
 *   2. The heading text, if it's a stable string.
 *   3. Empty → fall back to local component state (no persistence,
 *      same behavior as before this change).
 */
export function CollapsibleCard({
  heading,
  defaultOpen = false,
  badge,
  className = 'card',
  storageKey,
  children,
}: {
  heading: ReactNode;
  defaultOpen?: boolean;
  badge?: ReactNode;
  /** Override for cards that need extra modifiers (e.g. `capture-card`). */
  className?: string;
  /** Stable key under which the open/closed state is persisted. Pass
   * this when the heading text isn't stable (e.g. "Objects (N)"). */
  storageKey?: string;
  children: ReactNode;
}) {
  const key =
    storageKey ?? (typeof heading === 'string' ? heading : '');
  const persistedOpen = useStore((s) =>
    key ? s.cardOpen[key] : undefined,
  );
  const setCardOpen = useStore((s) => s.setCardOpen);
  // Local fallback for the unkeyed case (no stable storage key); also
  // seeded with `defaultOpen` so first-render behavior is unchanged
  // before the user has ever toggled the card.
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const open = key ? (persistedOpen ?? defaultOpen) : localOpen;
  const setOpen = (next: boolean) => {
    if (key) setCardOpen(key, next);
    else setLocalOpen(next);
  };
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="card-heading-toggle"
      >
        <span>{heading}</span>
        {badge && !open && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 10,
              color: 'var(--accent)',
              fontWeight: 500,
              letterSpacing: '0.08em',
            }}
          >
            {badge}
          </span>
        )}
        <span
          className="section-toggle-chevron"
          style={{
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            marginLeft: badge && !open ? '0' : 'auto',
          }}
          aria-hidden
        >
          <ChevronGlyph />
        </span>
      </button>
      {open && children}
    </div>
  );
}

/**
 * Centered chevron glyph for collapsible card toggles. SVG (not a font
 * character) because a filled-triangle glyph like `▸` has its visual
 * mass offset within the character box — rotating it 90° leaves the
 * triangle visibly off-center inside the chevron button. The stroke
 * path here is geometrically symmetric around viewBox center, so the
 * rotation animation pivots in place. Exported so the other two call
 * sites (`RobotPanel` arm-home-pose card, `VisionPanel` custom-textures
 * card) can render the same glyph without duplicating the SVG markup.
 */
export function ChevronGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden
      focusable="false"
    >
      <path
        d="M3.5 1.5 L7 5 L3.5 8.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
