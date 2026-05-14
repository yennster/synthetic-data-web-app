import { CollapsibleCard } from './CollapsibleCard';
import { SliderRow } from './SliderRow';
import { ToggleSwitch } from './ToggleSwitch';
import {
  useStore,
  type RealismConfig,
  type RealismMode,
} from '../store/useStore';

/**
 * Realism post-process picker — shared by detection / anomaly / robot
 * panels. Currently surfaces two modes:
 *   - Off (raw render)
 *   - Random (CPU pixel transforms: grain, radial CA, vignette,
 *     color jitter, JPEG round-trip)
 *
 * Each effect has its own slider (0..100%) so users can dial them in
 * independently — e.g., heavy grain with no vignette, or strong JPEG
 * artifacts with subtle CA. A 0 on a slider skips that effect.
 *
 * Diffusion (`'diffusion'`) is intentionally hidden from the picker
 * until the server-side img2img endpoint is wired up properly. The
 * supporting code in `lib/realism.ts` + `api/realism-diffusion.ts` is
 * left intact so re-enabling is just a matter of adding the entry
 * back to MODES below.
 */
// The internal mode value stays `'random'` for persistence + EI
// `realism_mode` metadata compatibility — only the user-facing label
// changes. "Photo FX" reads as the family of effects the pass actually
// applies (camera grain, lens CA, vignette, exposure jitter, JPEG
// compression) instead of "Random", which only described how each
// capture varied from the next.
const MODES: { value: RealismMode; label: string; hint: string }[] = [
  { value: 'off', label: 'Off', hint: 'Raw synthetic render.' },
  {
    value: 'random',
    label: 'Photo FX',
    hint:
      'Each capture is run through the per-effect transforms below — ' +
      'film grain, radial chromatic aberration, vignette, color jitter, ' +
      'and a JPEG round-trip. Bounding boxes are preserved (geometry ' +
      'never moves; only pixel values change).',
  },
];

/** UI metadata for each per-effect slider — kept declarative so the
 * card iterates one list instead of repeating five slider blocks. */
const EFFECTS: {
  key: 'grain' | 'chromatic' | 'vignette' | 'jitter' | 'jpeg';
  label: string;
  hint: string;
}[] = [
  {
    key: 'grain',
    label: 'Film grain',
    hint: 'Gaussian noise per RGB channel — mimics sensor noise.',
  },
  {
    key: 'chromatic',
    label: 'Chromatic aberration',
    hint:
      'Radial RGB split — zero at the image center, max at the corners. ' +
      'How real lenses actually fail.',
  },
  {
    key: 'vignette',
    label: 'Vignette',
    hint: 'Smooth radial darkening from center to corners.',
  },
  {
    key: 'jitter',
    label: 'Color jitter',
    hint:
      'Per-channel gain + brightness offset — simulates white-balance ' +
      'drift and exposure variation between captures.',
  },
  {
    key: 'jpeg',
    label: 'JPEG artifacts',
    hint:
      'Round-trip the image through JPEG to introduce real 8×8 DCT ' +
      'compression blocks and mild color banding. 0% skips the round-trip.',
  },
];

export function RealismCard() {
  const realism = useStore((s) => s.realism);
  const setRealism = useStore((s) => s.setRealism);
  const active = realism.mode !== 'off';

  return (
    <CollapsibleCard
      heading="Realism"
      // Show the "random" badge only when the per-capture Randomize
      // toggle is on. Deterministic Photo FX (sliders fixed across
      // the batch) doesn't need to surface its state at-a-glance —
      // the chevron's expanded-color is enough.
      badge={active && realism.randomize ? 'random' : undefined}
    >
      <div
        className="motion-pills"
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
        <>
          {EFFECTS.map((e) => (
            <SliderRow
              key={e.key}
              label={e.label}
              hint={e.hint}
              value={realism[e.key]}
              min={0}
              max={1}
              step={0.05}
              formatValue={(v) => `${(v * 100).toFixed(0)}%`}
              onChange={(next) =>
                setRealism({ [e.key]: next } as Partial<RealismConfig>)
              }
            />
          ))}
          <ToggleSwitch
            title="Randomize per capture"
            help="On: each capture re-samples its effective intensity for every effect in [0, slider value], so a batch sees varied realism instead of identical settings on every PNG. The sliders above become the upper bound. Off: each capture uses the slider values verbatim."
            on={realism.randomize}
            onChange={(next) => setRealism({ randomize: next })}
          />
        </>
      )}
    </CollapsibleCard>
  );
}
