import {
  useEffect,
  useState,
  type CSSProperties,
  type FocusEventHandler,
  type ChangeEventHandler,
} from 'react';

/**
 * Pure helpers driving the number-input hook below — extracted so they
 * can be unit-tested without mounting a React tree.
 */

export type NumberInputOpts = { min?: number; max?: number };

export function clampNumber(n: number, opts?: NumberInputOpts): number {
  let r = n;
  if (opts?.min !== undefined) r = Math.max(opts.min, r);
  if (opts?.max !== undefined) r = Math.min(opts.max, r);
  return r;
}

export type DraftDecision = {
  /** New draft string to display in the input. */
  draft: string;
  /** Numeric value to push upstream, or `null` to leave the upstream
   * value untouched (the user's mid-typing or invalid input shouldn't
   * commit). */
  commit: number | null;
};

/**
 * Decide what should happen when the user types `next` into a field whose
 * upstream value is currently `value`. Empty / lone-minus / unparseable
 * drafts are preserved without committing; finite numbers are clamped and
 * committed only when they differ from the current upstream value.
 */
export function decideOnChange(
  next: string,
  value: number,
  opts?: NumberInputOpts,
): DraftDecision {
  if (next === '' || next === '-') return { draft: next, commit: null };
  const n = Number(next);
  if (!Number.isFinite(n)) return { draft: next, commit: null };
  const c = clampNumber(n, opts);
  return { draft: next, commit: c === value ? null : c };
}

/**
 * Decide what should happen when the user blurs out of the field. Empty
 * / lone-minus / unparseable drafts snap back to the last committed
 * value; out-of-range finite numbers are clamped and committed.
 */
export function decideOnBlur(
  draft: string,
  value: number,
  opts?: NumberInputOpts,
): DraftDecision {
  if (draft === '' || draft === '-') {
    return { draft: String(value), commit: null };
  }
  const n = Number(draft);
  if (!Number.isFinite(n)) {
    return { draft: String(value), commit: null };
  }
  const c = clampNumber(n, opts);
  const draftOut = c === n ? draft : String(c);
  const commit = c === value ? null : c;
  return { draft: draftOut, commit };
}

/**
 * Controlled `<input type="number">` that tolerates a transiently empty
 * or otherwise invalid string while the user is typing.
 *
 * The naive pattern — `value={n}` + `onChange={e => set(Number(e.target.value) || fallback)}`
 * — re-renders the input back to its last-good-or-fallback number on
 * every keystroke, so a user who clears the field to type a new number
 * can never see it empty: clearing "10" snaps it straight back to "10"
 * before the next digit can be typed.
 *
 * This hook keeps a local `draft` string that mirrors what's actually in
 * the input. The numeric `value` only flows out to the caller when the
 * draft parses to a finite number; an empty / partially-typed draft is
 * preserved without committing. On blur, an unparseable or out-of-range
 * draft is replaced with the last committed value.
 *
 * Pass `min` / `max` to clamp committed values. The clamp runs on both
 * keystroke commits and blur; out-of-range typed values are committed at
 * the boundary (e.g. typing "9999" with `max: 500` commits 500).
 *
 * Spread the returned `inputProps` directly onto your `<input>`:
 *
 *     const count = useNumberInput(drops.count, (n) => setDrops({ count: n }), { min: 1, max: 500 });
 *     <input type="number" {...count.inputProps} />
 */
export function useNumberInput(
  value: number,
  onCommit: (n: number) => void,
  opts?: NumberInputOpts,
): {
  inputProps: {
    value: string;
    onChange: ChangeEventHandler<HTMLInputElement>;
    onBlur: FocusEventHandler<HTMLInputElement>;
  };
} {
  const [draft, setDraft] = useState<string>(() => String(value));

  // Pull external value changes (resets, programmatic updates) into the
  // draft. Skip when the draft already represents the same number — that
  // avoids stomping a user's in-flight typing when the commit they just
  // triggered echoes back through this effect.
  useEffect(() => {
    if (draft === '' || draft === '-') return;
    const n = Number(draft);
    if (Number.isFinite(n) && n === value) return;
    setDraft(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const onChange: ChangeEventHandler<HTMLInputElement> = (e) => {
    const decision = decideOnChange(e.target.value, value, opts);
    setDraft(decision.draft);
    if (decision.commit !== null) onCommit(decision.commit);
  };

  const onBlur: FocusEventHandler<HTMLInputElement> = () => {
    const decision = decideOnBlur(draft, value, opts);
    if (decision.draft !== draft) setDraft(decision.draft);
    if (decision.commit !== null) onCommit(decision.commit);
  };

  return {
    inputProps: { value: draft, onChange, onBlur },
  };
}

/**
 * Drop-in `<input type="number">` that uses `useNumberInput` under the
 * hood. Useful inside `.map()` loops where calling the hook directly per
 * row would violate rules of hooks. Caller controls min/max/step exactly
 * like a native number input — those are forwarded to the DOM element.
 */
export function NumberField(props: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  placeholder?: string;
  style?: CSSProperties;
  className?: string;
  title?: string;
  'aria-label'?: string;
}) {
  const { inputProps } = useNumberInput(props.value, props.onChange, {
    min: props.min,
    max: props.max,
  });
  return (
    <input
      type="number"
      min={props.min}
      max={props.max}
      step={props.step}
      disabled={props.disabled}
      placeholder={props.placeholder}
      style={props.style}
      className={props.className}
      title={props.title}
      aria-label={props['aria-label']}
      {...inputProps}
    />
  );
}
