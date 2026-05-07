import { useStore } from '../store/useStore';

/**
 * Shared Edge Impulse credentials card. Used by both motion and vision
 * panels so the user enters API key + category once, alongside the
 * upload/inference flows that consume them.
 *
 * The HMAC field is only relevant in motion mode: Edge Impulse's HMAC
 * mechanism is part of the JSON "data acquisition format" used by the
 * `/api/<category>/data` endpoint (time-series sensor data), where the
 * signature is embedded in the protected envelope around the payload.
 * Image and file uploads go through `/api/<category>/files` instead, which
 * authenticates only via the API key — there's no HMAC header on that
 * endpoint, so we hide the field to avoid implying it's used.
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
            setEi({ category: e.target.value as 'training' | 'testing' })
          }
        >
          <option value="training">Training</option>
          <option value="testing">Testing</option>
        </select>
      </label>
    </div>
  );
}
