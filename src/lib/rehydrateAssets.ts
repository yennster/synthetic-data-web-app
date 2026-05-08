import { useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import { getAssetBlob, deleteAssetBlob } from './assetStore';
import { loadUsdz } from './usdz';

/**
 * Re-import every USDZ asset that was in the scene before the last reload.
 *
 * The persisted store keeps a `pendingAssets` array of metadata snapshots
 * (`PersistedAsset[]`); the matching `.usdz` bytes live in IndexedDB. On
 * mount we walk `pendingAssets`, pull each blob, re-run `loadUsdz()` to
 * rebuild the live three.js Group + needle hydra handle, and add the
 * resulting `ImportedAsset` back to the store with the user's positions /
 * scales / labels intact.
 *
 * Runs exactly once per app session — once we've consumed the pending list
 * we clear it. New imports during the session go through the normal
 * import path and don't touch this hook.
 */
export function useRehydrateAssets(): void {
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    const { pendingAssets } = useStore.getState();
    if (pendingAssets.length === 0) return;

    const { addAsset, setPendingAssets, setStatus } = useStore.getState();

    let cancelled = false;
    let restored = 0;
    const total = pendingAssets.length;
    setStatus('busy', `Restoring ${total} asset(s)…`);

    (async () => {
      for (const meta of pendingAssets) {
        if (cancelled) return;
        try {
          const blob = await getAssetBlob(meta.id);
          if (!blob) {
            // The metadata exists but the blob is gone (e.g. user cleared
            // site data, or storage was evicted). Drop the orphan so we
            // don't try to restore it again on the next load.
            console.warn(
              `[persist] missing usdz blob for ${meta.name}, skipping`,
            );
            await deleteAssetBlob(meta.id).catch(() => {});
            continue;
          }
          const file = new File([blob], `${meta.name}.usdz`, {
            type: 'model/vnd.usdz+zip',
          });
          const { object, handle, isAnimated } = await loadUsdz(file);
          if (cancelled) return;
          addAsset({
            id: meta.id,
            name: meta.name,
            label: meta.label,
            object,
            position: meta.position,
            rotation: meta.rotation,
            scale: meta.scale,
            physics: meta.physics,
            overrideMaterial: meta.overrideMaterial,
            overrideColor: meta.overrideColor,
            overrideRoughness: meta.overrideRoughness,
            overrideMetalness: meta.overrideMetalness,
            handle,
            // Trust whatever the freshly-loaded stage reports; persisted
            // value is a hint but the loader is authoritative.
            isAnimated,
            animationPlaying: meta.animationPlaying && isAnimated,
          });
          restored += 1;
        } catch (err) {
          console.warn(`[persist] failed to restore ${meta.name}:`, err);
        }
      }
      if (cancelled) return;
      setPendingAssets([]);
      setStatus(
        'ok',
        restored === total
          ? `Restored ${restored} asset(s)`
          : `Restored ${restored} of ${total} asset(s)`,
      );
    })();

    return () => {
      cancelled = true;
    };
  }, []);
}
