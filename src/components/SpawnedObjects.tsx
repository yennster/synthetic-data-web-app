import { useFrame } from '@react-three/fiber';
import { RigidBody, type RapierRigidBody } from '@react-three/rapier';
import { useEffect, useRef, useState } from 'react';
import { BELT_TRANSPORTABLES } from '../lib/beltDynamics';
import { useDragMove } from '../lib/dragMove';
import {
  useStore,
  type ObjectKind,
  type SceneObject,
  type SceneObjectOwner,
} from '../store/useStore';

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
 * Visual-only path used when the user has turned physics off for this
 * object — no RigidBody, no collider, no belt transport. The mesh sits at
 * its store position, still draggable via Shift+drag (the drag handler
 * just writes the new position back to the store).
 */
function StaticSpawnedMesh({ obj }: { obj: SceneObject }) {
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
      <meshStandardMaterial
        color={obj.color}
        roughness={obj.roughness}
        metalness={obj.metalness}
      />
    </mesh>
  );
}

function SpawnedMesh({ obj }: { obj: SceneObject }) {
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

  // Last position we wrote to the store, in body-frame coords. Used by
  // the settle-sync below to avoid restating the same position every
  // frame, and by the position-change effect to recognize its own
  // writes (so it doesn't teleport the body to where it already is).
  const lastSyncedPos = useRef<[number, number, number]>([
    obj.position[0],
    obj.position[1],
    obj.position[2],
  ]);

  // Throttle the settle-sync to 0.25 s so a falling body produces a
  // few intermediate writes (intermediate cushioning against scale-
  // toggle remounts during the fall) but doesn't storm the store.
  const lastSyncMs = useRef(0);

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
      return;
    }
    // Sync the body's current pose back to the store so the next
    // remount (scale change, physics toggle, kind change) respawns
    // the new body at its current location instead of the stale
    // initial spawn. Two-gate filter keeps writes cheap:
    //   1. throttle to ~4 Hz
    //   2. position must have changed ≥1 cm since the last write
    // The matching `[obj.position]` effect below recognizes these
    // writes (body already at the target) and skips its teleport,
    // so the loop terminates.
    const now = performance.now();
    if (now - lastSyncMs.current < 250) return;
    const dx = t.x - lastSyncedPos.current[0];
    const dy = t.y - lastSyncedPos.current[1];
    const dz = t.z - lastSyncedPos.current[2];
    if (dx * dx + dy * dy + dz * dz < 1e-4) return;
    lastSyncMs.current = now;
    lastSyncedPos.current = [t.x, t.y, t.z];
    updateSceneObject(obj.id, { position: [t.x, t.y, t.z] });
  });

  // When `obj.position` changes (drag, programmatic teleport, …),
  // snap the body to the new pose. Skips no-op writes that came from
  // our own settle-sync above — if the body is already at the target
  // position (within 5 cm), we leave it alone instead of re-zeroing
  // velocities.
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      lastSyncedPos.current = [
        obj.position[0],
        obj.position[1],
        obj.position[2],
      ];
      return;
    }
    const body = bodyRef.current;
    if (!body) return;
    const t = body.translation();
    const dx = obj.position[0] - t.x;
    const dy = obj.position[1] - t.y;
    const dz = obj.position[2] - t.z;
    if (dx * dx + dy * dy + dz * dz < 0.0025) {
      // Body already at target — this `obj.position` change came from
      // our own settle-sync. Update the watermark and bail.
      lastSyncedPos.current = [t.x, t.y, t.z];
      return;
    }
    body.setTranslation(
      { x: obj.position[0], y: obj.position[1], z: obj.position[2] },
      true,
    );
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    lastSyncedPos.current = [
      obj.position[0],
      obj.position[1],
      obj.position[2],
    ];
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
        <meshStandardMaterial
          color={obj.color}
          roughness={obj.roughness}
          metalness={obj.metalness}
        />
      </mesh>
    </RigidBody>
  );
}

export function SpawnedObjects({
  ownerFilter,
  excludeIds,
}: {
  /** Restrict rendering to objects whose `owner` matches this value.
   * `'vision'` matches the legacy untagged pool (objects added through
   * the detection / anomaly panels). Omit to render every object. */
  ownerFilter?: SceneObjectOwner | 'vision';
  /** Skip these object ids. Used to hide the arm's active pickup
   * target — that object is rendered by `BraccioArm`'s `ArmTargetMesh`
   * at MuJoCo's settled pose so it can be physically grasped, and
   * including it here too would draw two cubes on top of each other. */
  excludeIds?: ReadonlyArray<string>;
} = {}) {
  const sceneObjects = useStore((s) => s.sceneObjects);
  const filtered = (
    ownerFilter
      ? sceneObjects.filter((o) =>
          ownerFilter === 'vision'
            ? o.owner == null
            : o.owner === ownerFilter,
        )
      : sceneObjects
  ).filter((o) => !excludeIds?.includes(o.id));
  return (
    <>
      {filtered.map((obj) => {
        // Include scale + physics flag in the key so:
        //  - Resizing recomputes the rapier auto-collider for the new mesh.
        //  - Toggling physics swaps the entire branch (RigidBody ↔ plain mesh)
        //    instead of trying to mutate a body in place.
        const key = `${obj.id}-${obj.scale.toFixed(3)}-${obj.physics ? 'p' : 's'}`;
        return obj.physics ? (
          <SpawnedMesh key={key} obj={obj} />
        ) : (
          <StaticSpawnedMesh key={key} obj={obj} />
        );
      })}
    </>
  );
}
