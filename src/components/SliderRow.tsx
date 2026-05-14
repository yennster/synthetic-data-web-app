/**
 * Reusable `<label className="field">{label} {value} <input type="range" /></label>`
 * row used by every panel that exposes a numeric scrubber. Centralizes:
 *
 *   - the value-readout format (the panels were split between `.toFixed(0)°`,
 *     `(v * 100).toFixed(0)%`, and raw number rendering — pass `formatValue`
 *     to pick one and the row carries it),
 *   - the `disabled` plumbing,
 *   - the `title` tooltip (used by the realism card for per-effect hints).
 */
export function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  formatValue,
  hint,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
  /** How to render the value next to the label. Defaults to `value.toFixed(2)`. */
  formatValue?: (v: number) => string;
  /** Native `title` tooltip on the row. */
  hint?: string;
  disabled?: boolean;
}) {
  const fmt = formatValue ?? ((v: number) => v.toFixed(2));
  return (
    <label className="field" title={hint}>
      {label} {fmt(value)}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
      />
    </label>
  );
}
