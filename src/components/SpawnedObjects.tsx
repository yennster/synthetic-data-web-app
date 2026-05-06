import { RigidBody, type RapierRigidBody } from '@react-three/rapier';
import { useEffect, useRef } from 'react';
import { BELT_TRANSPORTABLES } from '../lib/beltDynamics';
import { useDragMove } from '../lib/dragMove';
import { useStore, type ObjectKind, type SceneObject } from '../store/useStore';

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
    case 'cube':
    default:
      return <boxGeometry args={[0.6, 0.6, 0.6]} />;
  }
}

function SpawnedMesh({ obj }: { obj: SceneObject }) {
  const bodyRef = useRef<RapierRigidBody>(null);
  const updateSceneObject = useStore((s) => s.updateSceneObject);
  const isInitialMount = useRef(true);

  // Register with the belt-dynamics registry so the conveyor can transport us.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    BELT_TRANSPORTABLES.add(body);
    return () => {
      BELT_TRANSPORTABLES.delete(body);
    };
  }, []);

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
    // down between drag samples. Back to dynamic on release so it falls
    // / collides / rides the belt normally.
    onDragStart: () => {
      const body = bodyRef.current;
      if (!body) return;
      body.setBodyType(2 /* KinematicPositionBased */, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    },
    onDragEnd: () => {
      const body = bodyRef.current;
      if (!body) return;
      body.setBodyType(0 /* Dynamic */, true);
    },
  });

  return (
    <RigidBody
      ref={bodyRef}
      type="dynamic"
      colliders="hull"
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

export function SpawnedObjects() {
  const sceneObjects = useStore((s) => s.sceneObjects);
  return (
    <>
      {sceneObjects.map((obj) => (
        <SpawnedMesh key={obj.id} obj={obj} />
      ))}
    </>
  );
}
