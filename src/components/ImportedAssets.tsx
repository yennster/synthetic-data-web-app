import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import {
  RigidBody,
  type RapierRigidBody,
} from '@react-three/rapier';
import { BELT_TRANSPORTABLES } from '../lib/beltDynamics';
import { useStore, type ImportedAsset } from '../store/useStore';

/**
 * Tag every descendant of the asset object with `userData.label` so the
 * bounding-box projector finds it as one labelled unit.
 */
function useLabelTagging(asset: ImportedAsset) {
  useEffect(() => {
    asset.object.traverse((o) => {
      o.userData.label = asset.label;
      o.userData.assetId = asset.id;
    });
  }, [asset.label, asset.id, asset.object]);
}

/** Visual-only path: transforms applied via parent group. */
function VisualAsset({ asset }: { asset: ImportedAsset }) {
  const groupRef = useRef<THREE.Group>(null);
  useLabelTagging(asset);
  useEffect(() => {
    if (groupRef.current) {
      groupRef.current.userData.label = asset.label;
      groupRef.current.userData.assetId = asset.id;
    }
  }, [asset.label, asset.id]);
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

/**
 * Physics path: wrap the asset in a RigidBody with a convex-hull collider so
 * it falls / collides / can be carried by the conveyor. The body's initial
 * pose is the asset's position/rotation; subsequent slider changes call
 * setTranslation / setRotation to teleport it. Scale changes remount the
 * body via a key so the collider gets recomputed.
 */
function PhysicsAsset({ asset }: { asset: ImportedAsset }) {
  const bodyRef = useRef<RapierRigidBody>(null);
  useLabelTagging(asset);

  // Register with the belt transport set
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    BELT_TRANSPORTABLES.add(body);
    return () => {
      BELT_TRANSPORTABLES.delete(body);
    };
  }, []);

  // Sync slider changes back into the physics body (teleport).
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.setTranslation(
      { x: asset.position[0], y: asset.position[1], z: asset.position[2] },
      true,
    );
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }, [asset.position]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const e = new THREE.Euler(...asset.rotation);
    const q = new THREE.Quaternion().setFromEuler(e);
    body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
  }, [asset.rotation]);

  return (
    <RigidBody
      ref={bodyRef}
      type="dynamic"
      colliders="hull"
      position={asset.position}
      rotation={asset.rotation}
      restitution={0.2}
      friction={0.7}
      // Carry the asset's userData onto the RigidBody's wrapping object so the
      // bbox projector can find this subtree.
      userData={{ label: asset.label, assetId: asset.id }}
    >
      <group scale={asset.scale}>
        <primitive object={asset.object} />
      </group>
    </RigidBody>
  );
}

function Asset({ asset }: { asset: ImportedAsset }) {
  // Remount the physics path when scale changes so the convex-hull collider
  // gets recomputed at the new size.
  const key = asset.physics ? `phys-${asset.id}-${asset.scale.toFixed(3)}` : `vis-${asset.id}`;
  return asset.physics ? (
    <PhysicsAsset key={key} asset={asset} />
  ) : (
    <VisualAsset key={key} asset={asset} />
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
