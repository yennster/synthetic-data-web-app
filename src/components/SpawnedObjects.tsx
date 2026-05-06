import { RigidBody } from '@react-three/rapier';
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
  return (
    <RigidBody
      type="dynamic"
      colliders="hull"
      position={obj.position}
      rotation={obj.rotation}
      restitution={0.2}
      friction={0.7}
    >
      <mesh
        scale={obj.scale}
        castShadow
        receiveShadow
        userData={{ label: obj.label, sceneObjectId: obj.id }}
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
