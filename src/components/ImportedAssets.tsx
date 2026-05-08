import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { RigidBody, type RapierRigidBody } from '@react-three/rapier';
import { BELT_TRANSPORTABLES } from '../lib/beltDynamics';
import { useDragMove } from '../lib/dragMove';
import { useStore, type ImportedAsset } from '../store/useStore';

// See SpawnedObjects for the rationale — same rescue, same thresholds.
const FLOOR_RESCUE_Y = -3;
const RESPAWN_Y = 5;

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

/**
 * Apply / unapply the user's material override. When `overrideMaterial` is
 * on, every mesh in the asset gets its material replaced with a plain
 * MeshStandardMaterial of the override color. When toggled off, we restore
 * the original materials. Used to rescue Omniverse USDZ exports whose MDL
 * materials don't translate to three.js (they render as flat magenta).
 */
function useMaterialOverride(asset: ImportedAsset) {
  // Cache the original material per mesh so we can restore on toggle off.
  const originalMats = useRef(new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>());

  useEffect(() => {
    const overrideMat = new THREE.MeshStandardMaterial({
      color: asset.overrideColor,
      roughness: asset.overrideRoughness,
      metalness: asset.overrideMetalness,
    });

    asset.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (asset.overrideMaterial) {
        if (!originalMats.current.has(mesh)) {
          originalMats.current.set(mesh, mesh.material);
        }
        mesh.material = overrideMat;
      } else {
        const orig = originalMats.current.get(mesh);
        if (orig) mesh.material = orig;
      }
    });

    return () => {
      // Don't dispose `overrideMat` here — Three.js still references it on
      // meshes that haven't been swapped back. Vite HMR / unmount handles
      // cleanup via disposeUsdz when the asset is removed.
    };
  }, [
    asset.object,
    asset.overrideMaterial,
    asset.overrideColor,
    asset.overrideRoughness,
    asset.overrideMetalness,
  ]);
}

/**
 * Drive USD time-sample animation forward by calling `instance.update(t)`
 * every frame. The loader's `update` advances the WASM HdWebSyncDriver and
 * pushes new transforms / vertex data through the render delegate, so any
 * baked animation in the .usdz (Apple's AR Quick Look samples, GLB-style
 * skeletal anim, vertex anim, etc.) plays back. We share one wall-clock so
 * multiple animated assets stay in sync.
 */
function useUsdzAnimation(asset: ImportedAsset) {
  const tRef = useRef(0);
  useFrame((_, delta) => {
    const inst = asset.instance;
    if (!inst || !asset.isAnimated || !asset.animationPlaying) return;
    tRef.current += delta;
    inst.update(tRef.current);
  });
}

/** Visual-only path: transforms applied via parent group. */
function VisualAsset({ asset }: { asset: ImportedAsset }) {
  const groupRef = useRef<THREE.Group>(null);
  const updateAsset = useStore((s) => s.updateAsset);
  useLabelTagging(asset);
  useMaterialOverride(asset);
  useUsdzAnimation(asset);
  useEffect(() => {
    if (groupRef.current) {
      groupRef.current.userData.label = asset.label;
      groupRef.current.userData.assetId = asset.id;
    }
  }, [asset.label, asset.id]);

  const dragHandlers = useDragMove({
    getPosition: () => asset.position,
    setPosition: (p) => updateAsset(asset.id, { position: p }),
  });

  return (
    <group
      ref={groupRef}
      position={asset.position}
      rotation={asset.rotation}
      scale={asset.scale}
      {...dragHandlers}
    >
      <primitive object={asset.object} />
    </group>
  );
}

/**
 * Physics path: wrap the asset in a RigidBody with a convex-hull collider so
 * it falls / collides / can be carried by the conveyor. The body's initial
 * pose is the asset's position/rotation; subsequent slider/drag changes call
 * setTranslation / setRotation to teleport it. Scale changes remount the
 * body via a key so the collider gets recomputed.
 */
function PhysicsAsset({ asset }: { asset: ImportedAsset }) {
  const bodyRef = useRef<RapierRigidBody>(null);
  const updateAsset = useStore((s) => s.updateAsset);
  // Same reason as SpawnedMesh: rapier re-applies every mutable prop on
  // each position change, so we drive the body type declaratively instead
  // of imperatively (which would get clobbered back to "dynamic" mid-drag).
  const [isDragging, setIsDragging] = useState(false);
  useLabelTagging(asset);
  useMaterialOverride(asset);
  useUsdzAnimation(asset);

  // Register with the belt transport set
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    BELT_TRANSPORTABLES.add(body);
    return () => {
      BELT_TRANSPORTABLES.delete(body);
    };
  }, []);

  useFrame(() => {
    const body = bodyRef.current;
    if (!body || isDragging) return;
    const t = body.translation();
    if (t.y < FLOOR_RESCUE_Y) {
      body.setTranslation(
        { x: asset.position[0], y: RESPAWN_Y, z: asset.position[2] },
        true,
      );
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  });

  // Sync slider/drag changes back into the physics body (teleport).
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

  const dragHandlers = useDragMove({
    getPosition: () => {
      const body = bodyRef.current;
      if (!body) return asset.position;
      const t = body.translation();
      return [t.x, t.y, t.z];
    },
    setPosition: (p) => updateAsset(asset.id, { position: p }),
    // Kinematic while held so gravity doesn't yank the asset down between
    // drag samples — same reason as the spawned-object path.
    onDragStart: () => {
      setIsDragging(true);
      const body = bodyRef.current;
      if (!body) return;
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    },
    onDragEnd: () => setIsDragging(false),
  });

  return (
    <RigidBody
      ref={bodyRef}
      type={isDragging ? 'kinematicPosition' : 'dynamic'}
      colliders="hull"
      position={asset.position}
      rotation={asset.rotation}
      restitution={0.2}
      friction={0.7}
      ccd
      userData={{ label: asset.label, assetId: asset.id }}
    >
      <group scale={asset.scale} {...dragHandlers}>
        <primitive object={asset.object} />
      </group>
    </RigidBody>
  );
}

function Asset({ asset }: { asset: ImportedAsset }) {
  // Remount the physics path when scale changes so the convex-hull collider
  // gets recomputed at the new size.
  const key = asset.physics
    ? `phys-${asset.id}-${asset.scale.toFixed(3)}`
    : `vis-${asset.id}`;
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
