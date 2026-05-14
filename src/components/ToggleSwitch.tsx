/**
 * Reusable on/off toggle row with title + help text + accessible
 * switch button. Replaces 15+ open-coded `webcam-control` blocks
 * across MotionPanel / VisionPanel / RobotPanel / RealismCard so they
 * share one a11y-correct implementation.
 *
 * Visual: identical to the original hand-rolled blocks
 * (`webcam-control` / `webcam-switch` CSS). Behavior:
 *  - `role="switch"` + `aria-checked` for screen readers.
 *  - `aria-label` falls back to "Turn {title} on/off" so each instance
 *    is uniquely identifiable in the a11y tree even when the title is
 *    purely visual.
 */
export function ToggleSwitch({
  title,
  titleAs = 'span',
  help,
  on,
  onChange,
  disabled,
  stateLabels,
}: {
  title: string;
  /** Element used to render the title — defaults to a span styled with
   * `webcam-control-title`. Pass `'h3'` for section-header weight (used
   * by the Object-detection / Conveyor section toggles). */
  titleAs?: 'span' | 'h3';
  help?: string;
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Override the default "On" / "Off" pill text. */
  stateLabels?: { on: string; off: string };
}) {
  const labels = stateLabels ?? { on: 'On', off: 'Off' };
  const Title = titleAs;
  const titleProps =
    titleAs === 'h3'
      ? { style: { margin: 0 } }
      : { className: 'webcam-control-title' };
  return (
    <div className="webcam-control">
      <div className="webcam-control-copy">
        <div className="webcam-control-heading">
          <Title {...titleProps}>{title}</Title>
          <span className={`webcam-control-state ${on ? 'on' : 'off'}`}>
            {on ? labels.on : labels.off}
          </span>
        </div>
        {help ? <div className="webcam-control-help">{help}</div> : null}
      </div>
      <button
        type="button"
        className={`webcam-switch ${on ? 'on' : ''}`}
        role="switch"
        aria-checked={on}
        aria-label={on ? `Turn ${title} off` : `Turn ${title} on`}
        disabled={disabled}
        onClick={() => onChange(!on)}
      >
        <span className="webcam-switch-thumb" />
      </button>
    </div>
  );
}
