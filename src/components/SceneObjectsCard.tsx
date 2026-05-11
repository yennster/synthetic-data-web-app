import { useState, type ReactNode } from 'react';
import {
  useStore,
  type ObjectKind,
  type SceneObject,
  type SceneObjectOwner,
} from '../store/useStore';
import { NumberField } from '../lib/useNumberInput';
import { CollapsibleCard } from './CollapsibleCard';

/**
 * Shared "Objects" card used by detection / anomaly / robotics-arm
 * panels. Owns the same kind/label spawn row, color picker, size
 * slider, physics checkbox, and remove button across all of them so
 * the user gets one consistent object-editing surface no matter which
 * mode they're in.
 *
 * Robotics mode opted into this in v0.13 — previously it had a
 * stripped-down per-target editor that omitted kind/physics/etc.
 *
 * `addCustom` lets robotics-arm route through `addArmPickupTarget`
 * (which spawns an arm-scale object on the configured mount surface)
 * instead of the human-scale `addSceneObject` defaults. Pass null to
 * fall through to `addSceneObject`. The kind selector + label input
 * still flow into the chosen spawner.
 *
 * `sizeRange` lets each caller pick a sensible slider range for its
 * scene scale — vision modes default to 0.1..5 (the existing range);
 * arm mode wants 0.02..0.2 so 3 cm targets are reachable from the
 * minimum. Out-of-range objects clamp into the slider but stay valid.
 */
export function SceneObjectsCard({
  title = 'Objects',
  addCustom,
  sizeRange = { min: 0.1, max: 5, step: 0.05 },
  defaultLabel = '',
  helpText,
  hidden = false,
  disabled = false,
  ownerFilter,
  footer,
}: {
  title?: string;
  addCustom?: ((kind: ObjectKind, label?: string) => string) | null;
  sizeRange?: { min: number; max: number; step: number };
  defaultLabel?: string;
  helpText?: string;
  hidden?: boolean;
  disabled?: boolean;
  /** When set, the card only shows / clears objects with this owner.
   * `'vision'` matches the legacy untagged pool. Omit to operate on
   * the full list (the default detection-mode behavior). New objects
   * created through `addSceneObject` automatically inherit this owner
   * tag too — keeps the panel-side editor coherent with the
   * scene-side filter. */
  ownerFilter?: SceneObjectOwner | 'vision';
  /** Extra content to render at the bottom of the card, inside the
   * same `<div className="card">` wrapper. Used by robotics arm mode
   * to inline the "randomize pickup position" toggle so it sits next
   * to the objects it affects instead of in a separate floating card.
   */
  footer?: ReactNode;
}) {
  const sceneObjects = useStore((s) => s.sceneObjects);
  const addSceneObject = useStore((s) => s.addSceneObject);
  const updateSceneObject = useStore((s) => s.updateSceneObject);
  const removeSceneObject = useStore((s) => s.removeSceneObject);
  const clearSceneObjects = useStore((s) => s.clearSceneObjects);

  const [newKind, setNewKind] = useState<ObjectKind>('cube');
  const [newLabel, setNewLabel] = useState<string>(defaultLabel);

  if (hidden) return null;

  const filtered = ownerFilter
    ? sceneObjects.filter((o) =>
        ownerFilter === 'vision'
          ? o.owner == null
          : o.owner === ownerFilter,
      )
    : sceneObjects;

  const onAdd = () => {
    if (disabled) return;
    const lbl = newLabel || newKind;
    if (addCustom) {
      addCustom(newKind, lbl);
    } else {
      addSceneObject(
        newKind,
        lbl,
        ownerFilter === 'vision' || !ownerFilter ? undefined : ownerFilter,
      );
    }
  };

  const onClear = () => {
    if (disabled) return;
    if (!ownerFilter) {
      clearSceneObjects();
      return;
    }
    // Per-owner clear: drop just the matching subset; preserve the
    // user's other-mode setup.
    for (const o of filtered) removeSceneObject(o.id);
  };

  return (
    <CollapsibleCard
      heading={`${title} (${filtered.length})`}
      badge={filtered.length > 0 ? String(filtered.length) : undefined}
    >
      {helpText && (
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{helpText}</div>
      )}
      <div className="row">
        <select
          value={newKind}
          onChange={(e) => setNewKind(e.target.value as ObjectKind)}
          disabled={disabled}
        >
          {OBJECT_OPTIONS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="label"
          disabled={disabled}
        />
      </div>
      <div className="row">
        <button onClick={onAdd} disabled={disabled}>
          + Add
        </button>
        <button onClick={onClear} disabled={disabled || filtered.length === 0}>
          Clear all
        </button>
      </div>
      {filtered.length > 0 && (
        <div
          style={{
            maxHeight: 200,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            marginTop: 4,
          }}
        >
          {filtered.map((o) => (
            <SceneObjectRow
              key={o.id}
              obj={o}
              sizeRange={sizeRange}
              disabled={disabled}
              onUpdate={(patch) => updateSceneObject(o.id, patch)}
              onRemove={() => removeSceneObject(o.id)}
            />
          ))}
        </div>
      )}
      {footer}
    </CollapsibleCard>
  );
}

const OBJECT_OPTIONS: ObjectKind[] = [
  'cube',
  'sphere',
  'cylinder',
  'cone',
  'torus',
  'capsule',
  'phone',
  'soda_can',
];

function SceneObjectRow({
  obj,
  sizeRange,
  disabled,
  onUpdate,
  onRemove,
}: {
  obj: SceneObject;
  sizeRange: { min: number; max: number; step: number };
  disabled: boolean;
  onUpdate: (patch: Partial<SceneObject>) => void;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        fontSize: 12,
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 6,
      }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="color"
          value={obj.color}
          onChange={(e) => onUpdate({ color: e.target.value })}
          title={`Color: ${obj.color}`}
          disabled={disabled}
          style={{ flex: 'none', width: 28, height: 28, padding: 0 }}
        />
        <input
          value={obj.label}
          onChange={(e) => onUpdate({ label: e.target.value })}
          disabled={disabled}
          style={{ flex: 1, padding: '3px 6px' }}
        />
        <span style={{ color: 'var(--muted)' }}>{obj.kind}</span>
        <button onClick={onRemove} disabled={disabled} style={{ padding: '2px 6px' }}>
          ×
        </button>
      </div>
      <label className="field" style={{ gap: 2, fontSize: 10 }}>
        Size
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="range"
            min={sizeRange.min}
            max={sizeRange.max}
            step={sizeRange.step}
            value={obj.scale}
            onChange={(e) => onUpdate({ scale: Number(e.target.value) })}
            disabled={disabled}
            style={{ flex: 1 }}
          />
          <NumberField
            min={sizeRange.min}
            max={sizeRange.max}
            step={sizeRange.step}
            value={obj.scale}
            onChange={(n) => onUpdate({ scale: n })}
            disabled={disabled}
            style={{ width: 64, flex: 'none', padding: '3px 6px' }}
          />
        </div>
      </label>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: 'var(--muted)',
        }}
      >
        <input
          type="checkbox"
          checked={obj.physics}
          onChange={(e) => onUpdate({ physics: e.target.checked })}
          disabled={disabled}
          style={{ width: 'auto', flex: 'none' }}
        />
        <span>Physics (falls, collides)</span>
      </label>
    </div>
  );
}
