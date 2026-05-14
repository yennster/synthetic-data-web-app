import { CollapsibleCard } from './CollapsibleCard';
import { useStore, type RealismMode } from '../store/useStore';

/**
 * Realism post-process picker — shared by detection / anomaly / robot
 * panels. Currently surfaces two modes:
 *   - Off (raw render)
 *   - Random (CPU pixel transforms: grain, radial CA, vignette,
 *     color jitter, JPEG round-trip)
 *
 * Diffusion (`'diffusion'`) is intentionally hidden from the picker
 * until the server-side img2img endpoint is wired up properly. The
 * supporting code in `lib/realism.ts` + `api/realism-diffusion.ts` is
 * left intact so re-enabling is just a matter of adding the entry
 * back to MODES below. Users whose persisted state still has
 * `mode: 'diffusion'` keep getting the Random-pass output the
 * applyRealismToBlob fallback already produces — no migration needed.
 */
const MODES: { value: RealismMode; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Raw synthetic render.' },
  {
    value: 'random',
    label: 'Random',
    hint:
      'Apply film grain, radial chromatic aberration, vignette, color jitter, and a JPEG round-trip to narrow the sim-to-real gap. Bounding boxes are preserved.',
  },
];

export function RealismCard() {
  const realism = useStore((s) => s.realism);
  const setRealism = useStore((s) => s.setRealism);
  const active = realism.mode !== 'off';

  return (
    <CollapsibleCard
      heading="Realism"
      badge={active ? `${realism.mode} · ${(realism.intensity * 100).toFixed(0)}%` : undefined}
    >
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
    </CollapsibleCard>
  );
}
