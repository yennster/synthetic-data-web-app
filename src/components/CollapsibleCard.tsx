import { type ReactNode, useState } from 'react';

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
 */
export function CollapsibleCard({
  heading,
  defaultOpen = false,
  badge,
  className = 'card',
  children,
}: {
  heading: ReactNode;
  defaultOpen?: boolean;
  badge?: ReactNode;
  /** Override for cards that need extra modifiers (e.g. `capture-card`). */
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((b) => !b)}
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
          ▸
        </span>
      </button>
      {open && children}
    </div>
  );
}
