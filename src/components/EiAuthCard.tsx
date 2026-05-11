import { useStore } from '../store/useStore';

/**
 * Shared Edge Impulse credentials card. Used by both motion and vision
 * panels so the user enters API key + category once, alongside the
 * upload/inference flows that consume them.
 *
 * The HMAC field is only relevant for time-series JSON acquisition
 * payloads: Edge Impulse's HMAC mechanism signs the protected envelope
 * around the sensor payload before it is uploaded as a `.json` file.
 * Image uploads don't use this acquisition envelope, so we hide the
 * field there to avoid implying it's used.
 */
export function EiAuthCard({ showHmac = false }: { showHmac?: boolean }) {
  const ei = useStore((s) => s.ei);
  const setEi = useStore((s) => s.setEi);
  return (
    <div className="card">
      <h3>Edge Impulse · auth</h3>
      <label className="field">
        API Key
        <input
          type="password"
          value={ei.apiKey}
          onChange={(e) => setEi({ apiKey: e.target.value })}
          placeholder="ei_..."
          autoComplete="off"
        />
      </label>
      {showHmac && (
        <label className="field">
          HMAC Key (optional)
          <input
            type="password"
            value={ei.hmacKey}
            onChange={(e) => setEi({ hmacKey: e.target.value })}
            placeholder="leave blank for unsigned"
            autoComplete="off"
          />
        </label>
      )}
      <label className="field">
        Category
        <select
          value={ei.category}
          onChange={(e) =>
            setEi({
              category: e.target.value as
                | 'training'
                | 'testing'
                | 'split',
            })
          }
        >
          <option value="training">Training</option>
          <option value="testing">Testing</option>
          <option value="split">Split 80:20 (training:testing)</option>
        </select>
      </label>
    </div>
  );
}
