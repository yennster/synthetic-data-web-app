import { useEffect } from 'react';
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
 * The guard is module-level (not a `useRef`) on purpose: under React
 * StrictMode the dev-only synthetic remount creates a fresh component
 * instance with a fresh ref every time, so a per-component guard would
 * fire the rehydration twice — racing two `loadUsdz` calls into the same
 * OpenUSD WASM singleton. A module-level boolean is shared across
 * mounts and survives StrictMode's mount → unmount → remount cycle.
 */
let rehydrateStarted = false;

export function useRehydrateAssets(): void {
  useEffect(() => {
    if (rehydrateStarted) return;
    rehydrateStarted = true;

    const {
      pendingAssets,
      addAsset,
      setPendingAssets,
      setStatus,
      setRestoringAssets,
    } = useStore.getState();
    if (pendingAssets.length === 0) return;

    let restored = 0;
    const total = pendingAssets.length;
    setStatus('busy', `Restoring ${total} asset(s)…`);
    setRestoringAssets({ done: 0, total, phase: 'busy' });

    (async () => {
      for (const meta of pendingAssets) {
        try {
          const blob = await getAssetBlob(meta.id);
          if (!blob) {
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
        setRestoringAssets({ done: restored, total, phase: 'busy' });
      }
      setPendingAssets([]);
      setStatus(
        'ok',
        restored === total
          ? `Restored ${restored} asset(s)`
          : `Restored ${restored} of ${total} asset(s)`,
      );
      // Flash a "Success" confirmation in the HUD pill, then hide it.
      // The 1-second hold is short enough not to nag, long enough that
      // users actually catch the green pulse and know rehydrate is done.
      setRestoringAssets({ done: restored, total, phase: 'success' });
      setTimeout(() => {
        setRestoringAssets({ done: 0, total: 0, phase: 'idle' });
      }, 1000);
    })();
  }, []);
}
