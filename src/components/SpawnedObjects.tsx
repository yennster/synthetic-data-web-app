import { useFrame } from '@react-three/fiber';
import { RigidBody, type RapierRigidBody } from '@react-three/rapier';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { BELT_TRANSPORTABLES } from '../lib/beltDynamics';
import { useDragMove } from '../lib/dragMove';
import { useCustomTexture } from '../lib/useCustomTexture';
import { useStore, type ObjectKind, type SceneObject } from '../store/useStore';

// If a body somehow tunnels through the ground (fast Shift+drag release, CCD
// edge cases, scale change mid-fall, etc.) it would otherwise fall forever
// off-screen. Below this Y we teleport the body back above where the user
// last placed it (xz from the store, y = RESPAWN_Y) and zero velocities.
const FLOOR_RESCUE_Y = -3;
const RESPAWN_Y = 5;

// Pick a collider auto-shape per kind. `cuboid`/`ball` produce primitives that
// match the geometry exactly; the convex-hull path is used for the
// non-primitive shapes (and adds a small contact margin that makes thin
// slabs like "phone" hover above the floor — that's the whole reason this
// helper exists).
type RigidBodyAutoCollider = 'cuboid' | 'ball' | 'hull';
function colliderForKind(kind: ObjectKind): RigidBodyAutoCollider {
  switch (kind) {
    case 'cube':
    case 'phone':
      return 'cuboid';
    case 'sphere':
      return 'ball';
    case 'soda_can':
      return 'hull';
    default:
      return 'hull';
  }
}

function Geometry({ kind }: { kind: ObjectKind }) {
  switch (kind) {
    case 'sphere':
      return <sphereGeometry args={[0.4, 32, 32]} />;
    case 'phone':
      return <boxGeometry args={[0.5, 1.0, 0.08]} />;
    case 'capsule':
      return <capsuleGeometry args={[0.3, 0.6, 8, 16]} />;
    case 'cylinder':
      return <cylinderGeometry args={[0.35, 0.35, 0.7, 24]} />;
    case 'cone':
      return <coneGeometry args={[0.4, 0.8, 24]} />;
    case 'torus':
      return <torusGeometry args={[0.35, 0.12, 16, 32]} />;
    case 'soda_can':
      // Real 355ml can ≈ 6.6cm Ø × 12.3cm. Scaled so it visually matches the
      // other primitives but reads as taller than wide.
      return <cylinderGeometry args={[0.22, 0.22, 0.62, 32]} />;
    case 'cube':
    default:
      return <boxGeometry args={[0.6, 0.6, 0.6]} />;
  }
}

/**
 * `meshStandardMaterial` JSX with the custom object texture applied when
 * one is loaded. We multiply the texture by white (instead of the user's
 * `obj.color`) so the photo's own colors come through; rolling back to
 * the solid `obj.color` happens automatically the moment `texture` is
 * null. Roughness/metalness still come from the per-object knobs.
 */
function ObjectMaterial({
  obj,
  texture,
}: {
  obj: SceneObject;
  texture: THREE.Texture | null;
}) {
  if (texture) {
    return (
      <meshStandardMaterial
        map={texture}
        color="#ffffff"
        roughness={obj.roughness}
        metalness={obj.metalness}
      />
    );
  }
  return (
    <meshStandardMaterial
      color={obj.color}
      roughness={obj.roughness}
      metalness={obj.metalness}
    />
  );
}

/**
 * Visual-only path used when the user has turned physics off for this
 * object — no RigidBody, no collider, no belt transport. The mesh sits at
 * its store position, still draggable via Shift+drag (the drag handler
 * just writes the new position back to the store).
 */
function StaticSpawnedMesh({
  obj,
  texture,
}: {
  obj: SceneObject;
  texture: THREE.Texture | null;
}) {
  const updateSceneObject = useStore((s) => s.updateSceneObject);
  const dragHandlers = useDragMove({
    getPosition: () => obj.position,
    setPosition: (p) => updateSceneObject(obj.id, { position: p }),
  });
  return (
    <mesh
      position={obj.position}
      rotation={obj.rotation}
      scale={obj.scale}
      castShadow
      receiveShadow
      userData={{ label: obj.label, sceneObjectId: obj.id }}
      {...dragHandlers}
    >
      <Geometry kind={obj.kind} />
      <ObjectMaterial obj={obj} texture={texture} />
    </mesh>
  );
}

function SpawnedMesh({
  obj,
  texture,
}: {
  obj: SceneObject;
  texture: THREE.Texture | null;
}) {
  const bodyRef = useRef<RapierRigidBody>(null);
  const updateSceneObject = useStore((s) => s.updateSceneObject);
  const isInitialMount = useRef(true);
  // Drive the rapier body type via React state so @react-three/rapier's
  // useUpdateRigidBodyOptions effect — which fires on every position change
  // and re-applies *all* mutable props — keeps the body kinematic while
  // dragging instead of clobbering an imperative setBodyType call back to
  // dynamic on the next pointer move.
  const [isDragging, setIsDragging] = useState(false);

  // Register with the belt-dynamics registry so the conveyor can transport us.
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
        { x: obj.position[0], y: RESPAWN_Y, z: obj.position[2] },
        true,
      );
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  });

  // When obj.position changes (e.g. user drags), teleport the body. We only
  // act on subsequent changes — the initial mount uses the RigidBody position
  // prop, which sets the body up at the right place automatically.
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    const body = bodyRef.current;
    if (!body) return;
    body.setTranslation(
      { x: obj.position[0], y: obj.position[1], z: obj.position[2] },
      true,
    );
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }, [obj.position]);

  const dragHandlers = useDragMove({
    getPosition: () => {
      const body = bodyRef.current;
      if (!body) return obj.position;
      const t = body.translation();
      return [t.x, t.y, t.z];
    },
    setPosition: (p) => updateSceneObject(obj.id, { position: p }),
    // Switch the body to kinematic while held so gravity doesn't pull it
    // down between drag samples. Back to dynamic on release so it falls /
    // collides / rides the belt normally.
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
      colliders={colliderForKind(obj.kind)}
      position={obj.position}
      rotation={obj.rotation}
      restitution={0.2}
      friction={0.7}
      ccd
    >
      <mesh
        scale={obj.scale}
        castShadow
        receiveShadow
        userData={{ label: obj.label, sceneObjectId: obj.id }}
        {...dragHandlers}
      >
        <Geometry kind={obj.kind} />
        <ObjectMaterial obj={obj} texture={texture} />
      </mesh>
    </RigidBody>
  );
}

export function SpawnedObjects() {
  const sceneObjects = useStore((s) => s.sceneObjects);
  // One shared texture for every spawned object — decoded once, handed to
  // each mesh via props rather than calling the hook per-object.
  const customObjectMeta = useStore((s) => s.customObjectTexture);
  const texture = useCustomTexture('object', customObjectMeta?.name ?? null);
  return (
    <>
      {sceneObjects.map((obj) => {
        // Include scale + physics flag in the key so:
        //  - Resizing recomputes the rapier auto-collider for the new mesh.
        //  - Toggling physics swaps the entire branch (RigidBody ↔ plain mesh)
        //    instead of trying to mutate a body in place.
        const key = `${obj.id}-${obj.scale.toFixed(3)}-${obj.physics ? 'p' : 's'}`;
        return obj.physics ? (
          <SpawnedMesh key={key} obj={obj} texture={texture} />
        ) : (
          <StaticSpawnedMesh key={key} obj={obj} texture={texture} />
        );
      })}
    </>
  );
}
