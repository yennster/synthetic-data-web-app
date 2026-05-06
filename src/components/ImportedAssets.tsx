import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useStore, type ImportedAsset } from '../store/useStore';

/** One imported asset, transform-controlled and tagged for bbox capture. */
function Asset({ asset }: { asset: ImportedAsset }) {
  const groupRef = useRef<THREE.Group>(null);

  // Tag every descendant mesh with the asset's label so the bbox projector
  // can find them. We retag on label change.
  useEffect(() => {
    const root = groupRef.current;
    if (!root) return;
    root.userData.label = asset.label;
    root.userData.assetId = asset.id;
    asset.object.traverse((o) => {
      o.userData.label = asset.label;
      o.userData.assetId = asset.id;
    });
  }, [asset.label, asset.id, asset.object]);

  return (
    <group
      ref={groupRef}
      position={asset.position}
      rotation={asset.rotation}
      scale={asset.scale}
    >
      <primitive object={asset.object} />
    </group>
  );
}

export function ImportedAssets() {
  const assets = useStore((s) => s.assets);
  return (
    <>
      {assets.map((a) => (
        <Asset key={a.id} asset={a} />
      ))}
    </>
  );
}
