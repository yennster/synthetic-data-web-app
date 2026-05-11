import { useState } from 'react';
import { useStore, type RealismMode } from '../store/useStore';

/**
 * Realism post-process picker — shared by detection / anomaly / robot
 * panels. Off (raw render), Random (CPU pixel transforms), Diffusion
 * (reserved for the future server endpoint, currently falls back to
 * random with a "coming soon" hint).
 *
 * Collapsible to keep the sidebar compact. Defaults to expanded when
 * realism is on so the intensity slider is one click away, collapsed
 * otherwise.
 */
const MODES: { value: RealismMode; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Raw synthetic render.' },
  {
    value: 'random',
    label: 'Random',
    hint:
      'Apply film grain, chromatic aberration, vignette, and color jitter to narrow the sim-to-real gap. Bounding boxes are preserved.',
  },
  {
    value: 'diffusion',
    label: 'Diffusion',
    hint:
      'Server-side img2img / ControlNet (coming soon). For now this falls back to the Random pass.',
  },
];

export function RealismCard() {
  const realism = useStore((s) => s.realism);
  const setRealism = useStore((s) => s.setRealism);
  // Open when the user has opted in (so the intensity slider is one
  // click away), collapsed when off (so it doesn't eat sidebar space).
  const [open, setOpen] = useState(realism.mode !== 'off');
  const active = realism.mode !== 'off';

  return (
    <div className="card">
      <button
        type="button"
        onClick={() => setOpen((b) => !b)}
        aria-expanded={open}
        className="card-heading-toggle"
      >
        <span>Realism</span>
        {active && !open && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 10,
              color: 'var(--accent)',
              fontWeight: 500,
              letterSpacing: '0.08em',
            }}
          >
            {realism.mode} · {(realism.intensity * 100).toFixed(0)}%
          </span>
        )}
        <span
          className="section-toggle-chevron"
          style={{
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            marginLeft: active && !open ? '0' : 'auto',
          }}
          aria-hidden
        >
          ▸
        </span>
      </button>
      {open && (
        <>
          <div
            className="motion-pills trajectory-pills"
            role="radiogroup"
            aria-label="Realism mode"
          >
            {MODES.map((m) => (
              <label
                key={m.value}
                className={`motion-pill ${realism.mode === m.value ? 'on' : ''}`}
                title={m.hint}
              >
                <input
                  type="radio"
                  name="realism-mode"
                  value={m.value}
                  checked={realism.mode === m.value}
                  onChange={() => setRealism({ mode: m.value })}
                />
                {m.label}
              </label>
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            {MODES.find((m) => m.value === realism.mode)?.hint}
          </div>
          {realism.mode !== 'off' && (
            <label className="field">
              Intensity {(realism.intensity * 100).toFixed(0)}%
              <input
                type="range"
                min={0.05}
                max={1}
                step={0.05}
                value={realism.intensity}
                onChange={(e) =>
                  setRealism({ intensity: Number(e.target.value) })
                }
              />
            </label>
          )}
        </>
      )}
    </div>
  );
}
