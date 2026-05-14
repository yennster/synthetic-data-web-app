import { useEffect, useRef, useState } from 'react';
import { NumberField } from '../lib/useNumberInput';
import { disposeUsdz, loadUsdz, prewarmUsdz } from '../lib/usdz';
import { putAssetBlob } from '../lib/assetStore';
import {
  boundsFromBox,
  type ImportedAssetBounds,
} from '../lib/importedAssetBounds';
import {
  useStore,
  type ImportedAsset,
  type SceneObjectOwner,
} from '../store/useStore';
import { CollapsibleCard } from './CollapsibleCard';

type OwnerFilter = SceneObjectOwner | 'vision';

type InitialPlacement = {
  position: [number, number, number];
  scale: number;
  physics?: boolean;
};

function assetMatchesOwner(asset: ImportedAsset, ownerFilter: OwnerFilter) {
  return ownerFilter === 'vision'
    ? asset.owner == null
    : asset.owner === ownerFilter;
}

function defaultPlacement({
  assetIndex,
  maxDim,
}: {
  assetIndex: number;
  maxDim: number;
}): InitialPlacement {
  let scale = 1;
  if (maxDim > 3) scale = 3 / maxDim;
  else if (maxDim < 0.05) scale = 0.1 / maxDim;
  return {
    position: [assetIndex * 1.0 - 1.5, 0, 0],
    scale,
    physics: false,
  };
}

export function ImportedAssetsCard({
  ownerFilter,
  title = 'Import (.usdz)',
  defaultLabel = '',
  helpText,
  sizeRange = { min: 0.001, max: 5, step: 0.01 },
  showPhysics = true,
  disabled = false,
  initialPlacement = defaultPlacement,
}: {
  ownerFilter: OwnerFilter;
  title?: string;
  defaultLabel?: string;
  helpText?: string;
  sizeRange?: { min: number; max: number; step: number };
  showPhysics?: boolean;
  disabled?: boolean;
  initialPlacement?: (ctx: {
    assetIndex: number;
    fileIndex: number;
    maxDim: number;
    bounds: ImportedAssetBounds;
  }) => InitialPlacement;
}) {
  const assets = useStore((s) => s.assets);
  const addAsset = useStore((s) => s.addAsset);
  const removeAsset = useStore((s) => s.removeAsset);
  const updateAsset = useStore((s) => s.updateAsset);
  const setStatus = useStore((s) => s.setStatus);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importLabel, setImportLabel] = useState(defaultLabel);

  const filtered = assets.filter((a) => assetMatchesOwner(a, ownerFilter));
  const owner = ownerFilter === 'vision' ? undefined : ownerFilter;

  useEffect(() => {
    prewarmUsdz();
  }, []);

  const onImportFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (disabled) return;
    setStatus('busy', `Importing ${files.length} asset(s)...`);
    let count = 0;
    let failed = 0;
    let lastError = '';
    for (const file of Array.from(files)) {
      if (!file.name.toLowerCase().endsWith('.usdz')) {
        failed += 1;
        lastError = `${file.name}: only .usdz files are supported (see README for .usd conversion).`;
        setStatus('err', lastError);
        continue;
      }
      try {
        const {
          object,
          handle,
          isAnimated,
          localBox,
          maxDim,
          meshCount,
          triangleCount,
          defaultMaterialMeshes,
        } = await loadUsdz(file);
        const bounds = boundsFromBox(localBox);

        const placeholderRatio =
          meshCount > 0 ? defaultMaterialMeshes / meshCount : 0;
        const autoOverride = placeholderRatio > 0.5;

        const id = crypto.randomUUID();
        const baseName = file.name.replace(/\.usdz$/i, '');
        void putAssetBlob(id, file).catch((err) => {
          console.warn(`[persist] failed to store ${baseName}.usdz:`, err);
        });

        const placement = initialPlacement({
          assetIndex: filtered.length + count,
          fileIndex: count,
          maxDim,
          bounds,
        });

        addAsset({
          id,
          name: baseName,
          label: importLabel.trim() || baseName,
          object,
          position: placement.position,
          rotation: [0, 0, 0],
          scale: placement.scale,
          bounds,
          physics: placement.physics ?? false,
          overrideMaterial: autoOverride,
          overrideColor: '#a78bfa',
          overrideRoughness: 0.5,
          overrideMetalness: 0.1,
          handle,
          isAnimated,
          animationPlaying: isAnimated,
          owner,
        });

        const summary = `${meshCount} meshes · ${triangleCount.toLocaleString()} tris · ${maxDim.toFixed(2)}m max`;
        const matNote =
          defaultMaterialMeshes === 0
            ? ''
            : ` · ${defaultMaterialMeshes}/${meshCount} default-material${autoOverride ? ' (override auto-enabled)' : ''}`;
        const animNote = isAnimated ? ' · animated' : '';
        setStatus(
          'ok',
          `Imported ${baseName}.usdz: ${summary}${matNote}${animNote}`,
        );
        count += 1;
      } catch (e) {
        failed += 1;
        lastError = `${file.name}: ${(e as Error).message}`;
        setStatus('err', lastError);
      }
    }
    if (failed === 0) {
      setStatus('ok', `Imported ${count} asset(s)`);
    } else if (count > 0) {
      setStatus(
        'err',
        `Imported ${count} asset(s), ${failed} failed: ${lastError}`,
      );
    } else {
      setStatus('err', lastError || 'No assets imported');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onRemoveAsset = (asset: ImportedAsset) => {
    disposeUsdz(asset.object, asset.handle ?? undefined);
    removeAsset(asset.id);
  };

  const onClearAssets = () => {
    for (const asset of filtered) {
      disposeUsdz(asset.object, asset.handle ?? undefined);
      removeAsset(asset.id);
    }
  };

  return (
    <CollapsibleCard
      heading={`${title} (${filtered.length})`}
      badge={filtered.length > 0 ? String(filtered.length) : undefined}
      // Heading includes a live count, so derive a stable storage key
      // from the title + owner — otherwise persisted open-state would
      // be lost every time an asset is imported / removed.
      storageKey={`imported-assets:${ownerFilter}:${title}`}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".usdz"
        multiple
        disabled={disabled}
        onChange={(e) => onImportFiles(e.target.files)}
        style={{ fontSize: 11 }}
      />
      <label className="field">
        Default label
        <input
          value={importLabel}
          onChange={(e) => setImportLabel(e.target.value)}
          placeholder="(uses filename if blank)"
          disabled={disabled}
        />
      </label>
      {filtered.length > 0 && (
        <>
          <button onClick={onClearAssets} disabled={disabled}>
            Clear all
          </button>
          <div
            style={{
              maxHeight: 220,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {filtered.map((a) => (
              <ImportedAssetRow
                key={a.id}
                asset={a}
                sizeRange={sizeRange}
                showPhysics={showPhysics}
                disabled={disabled}
                onUpdate={(patch) => updateAsset(a.id, patch)}
                onRemove={() => onRemoveAsset(a)}
              />
            ))}
          </div>
        </>
      )}
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
        {helpText ?? (
          <>
            Drop in <code>.usdz</code> files (zipped USD). For{' '}
            <code>.usd</code> / <code>.usda</code> / <code>.usdc</code>,
            convert first via Blender, Omniverse, or <code>usdcat</code>.
          </>
        )}
      </div>
    </CollapsibleCard>
  );
}

function ImportedAssetRow({
  asset,
  sizeRange,
  showPhysics,
  disabled,
  onUpdate,
  onRemove,
}: {
  asset: ImportedAsset;
  sizeRange: { min: number; max: number; step: number };
  showPhysics: boolean;
  disabled: boolean;
  onUpdate: (patch: Partial<ImportedAsset>) => void;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        fontSize: 11,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span
          style={{
            color: 'var(--muted)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={asset.name}
        >
          {asset.name}.usdz
          {asset.isAnimated ? ' · anim' : ''}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          {asset.isAnimated && (
            <button
              onClick={() =>
                onUpdate({ animationPlaying: !asset.animationPlaying })
              }
              title={asset.animationPlaying ? 'Pause animation' : 'Play animation'}
              disabled={disabled}
              style={{ padding: '2px 6px' }}
            >
              {asset.animationPlaying ? 'Pause' : 'Play'}
            </button>
          )}
          <button
            onClick={onRemove}
            disabled={disabled}
            style={{ padding: '2px 6px' }}
          >
            x
          </button>
        </div>
      </div>
      <input
        value={asset.label}
        onChange={(e) => onUpdate({ label: e.target.value })}
        placeholder="label"
        disabled={disabled}
        style={{ padding: '3px 6px' }}
      />
      <label className="field" style={{ gap: 2 }}>
        Scale
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="range"
            min={sizeRange.min}
            max={sizeRange.max}
            step={sizeRange.step}
            value={asset.scale}
            disabled={disabled}
            onChange={(e) =>
              onUpdate({
                scale: Number(e.target.value),
              })
            }
            style={{ flex: 1 }}
          />
          <NumberField
            min={sizeRange.min}
            max={sizeRange.max}
            step={sizeRange.step}
            value={asset.scale}
            onChange={(n) => onUpdate({ scale: n })}
            disabled={disabled}
            style={{
              width: 64,
              flex: 'none',
              padding: '3px 6px',
            }}
          />
        </div>
      </label>
      <div className="row">
        {(['X', 'Y', 'Z'] as const).map((axis, i) => (
          <label className="field" key={axis} style={{ gap: 2 }}>
            {axis}
            <input
              type="number"
              step={0.1}
              value={asset.position[i]}
              disabled={disabled}
              onChange={(e) => {
                const next = [...asset.position] as [number, number, number];
                next[i] = Number(e.target.value);
                onUpdate({ position: next });
              }}
              style={{ padding: '3px 6px' }}
            />
          </label>
        ))}
      </div>
      <label className="field" style={{ gap: 2 }}>
        Yaw {((asset.rotation[1] * 180) / Math.PI).toFixed(0)} deg
        <input
          type="range"
          min={-Math.PI}
          max={Math.PI}
          step={0.05}
          value={asset.rotation[1]}
          disabled={disabled}
          onChange={(e) =>
            onUpdate({
              rotation: [
                asset.rotation[0],
                Number(e.target.value),
                asset.rotation[2],
              ],
            })
          }
        />
      </label>
      {showPhysics && (
        <label
          className="field"
          style={{
            gap: 2,
            flexDirection: 'row',
            alignItems: 'center',
          }}
        >
          <input
            type="checkbox"
            checked={asset.physics}
            disabled={disabled}
            onChange={(e) => onUpdate({ physics: e.target.checked })}
            style={{ width: 'auto', flex: 'none' }}
          />
          <span style={{ flex: 1, textTransform: 'none', letterSpacing: 0 }}>
            Physics (falls, collides, rides belt)
          </span>
        </label>
      )}
      <label
        className="field"
        style={{
          gap: 2,
          flexDirection: 'row',
          alignItems: 'center',
        }}
      >
        <input
          type="checkbox"
          checked={asset.overrideMaterial}
          disabled={disabled}
          onChange={(e) => onUpdate({ overrideMaterial: e.target.checked })}
          style={{ width: 'auto', flex: 'none' }}
        />
        <span style={{ flex: 1, textTransform: 'none', letterSpacing: 0 }}>
          Override material (use if it&apos;s pink)
        </span>
      </label>
      {asset.overrideMaterial && (
        <div className="row" style={{ alignItems: 'center', gap: 6 }}>
          <input
            type="color"
            value={asset.overrideColor}
            disabled={disabled}
            onChange={(e) => onUpdate({ overrideColor: e.target.value })}
            style={{ flex: 'none', width: 32, height: 28, padding: 0 }}
          />
          <label className="field" style={{ gap: 0, flex: 1 }}>
            Rough
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={asset.overrideRoughness}
              disabled={disabled}
              onChange={(e) =>
                onUpdate({
                  overrideRoughness: Number(e.target.value),
                })
              }
            />
          </label>
          <label className="field" style={{ gap: 0, flex: 1 }}>
            Metal
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={asset.overrideMetalness}
              disabled={disabled}
              onChange={(e) =>
                onUpdate({
                  overrideMetalness: Number(e.target.value),
                })
              }
            />
          </label>
        </div>
      )}
    </div>
  );
}
