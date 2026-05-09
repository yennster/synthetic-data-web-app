import { useDragMove } from '../lib/dragMove';
import { useStore, type RobotObstacle } from '../store/useStore';

/**
 * Static obstacle field placed around the rover so the lidar/ToF ring
 * has something to hit and the contact detector has something to fire
 * against. Positions live in the store (`robotObstacles`) so the user
 * can drag obstacles around with the same Shift+drag controls as the
 * detection-mode scene, and "Randomize obstacles" can rewrite the
 * array.
 *
 * Each disc renders as one of three shapes — pillar / crate / cone —
 * picked deterministically from the obstacle's id, so the field reads
 * as a varied environment but the shape choice is stable across re-
 * renders.
 *
 * The forwarded ref is the group the rover's lidar component
 * raycasts against; the floor and the rover's own chassis are NOT
 * inside it so beams can't false-hit on either.
 */
type ObstacleShape = 'pillar' | 'crate' | 'cone';

function shapeForId(id: string): ObstacleShape {
  // Stable hash so the same obstacle keeps the same visual shape across
  // re-renders. Sum of char codes is plenty here — collisions just
  // mean two obstacles share a shape, which is fine.
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const v = ((h % 3) + 3) % 3;
  return (['pillar', 'crate', 'cone'] as const)[v];
}

export function RobotObstacles() {
  const obstacles = useStore((s) => s.robotObstacles);
  return (
    <>
      {obstacles.map((o) => (
        <DraggableObstacle key={o.id} obstacle={o} />
      ))}
    </>
  );
}

function DraggableObstacle({ obstacle }: { obstacle: RobotObstacle }) {
  const updateRobotObstacle = useStore((s) => s.updateRobotObstacle);
  const shape = shapeForId(obstacle.id);
  // Visual height varies by shape — kept in sync with the contact
  // detector's planar treatment, which only uses (x, z, r). Height is
  // purely cosmetic / lidar-elevation.
  const height =
    shape === 'pillar' ? 1.4 : shape === 'crate' ? 0.6 : 0.45;

  const dragHandlers = useDragMove({
    getPosition: () => [obstacle.x, height / 2, obstacle.z],
    setPosition: (p) =>
      updateRobotObstacle(obstacle.id, { x: p[0], z: p[2] }),
  });

  if (shape === 'pillar') {
    return (
      <mesh
        position={[obstacle.x, height / 2, obstacle.z]}
        castShadow
        receiveShadow
        userData={{ obstacleId: obstacle.id }}
        {...dragHandlers}
      >
        <cylinderGeometry args={[obstacle.r, obstacle.r, height, 24]} />
        <meshStandardMaterial
          color="#3b4451"
          roughness={0.7}
          metalness={0.2}
        />
      </mesh>
    );
  }
  if (shape === 'crate') {
    const w = obstacle.r * 3.0;
    const d = obstacle.r * 3.0;
    return (
      <mesh
        position={[obstacle.x, height / 2, obstacle.z]}
        castShadow
        receiveShadow
        userData={{ obstacleId: obstacle.id }}
        {...dragHandlers}
      >
        <boxGeometry args={[w, height, d]} />
        <meshStandardMaterial
          color="#5a4632"
          roughness={0.85}
          metalness={0.05}
        />
      </mesh>
    );
  }
  return (
    <mesh
      position={[obstacle.x, height / 2, obstacle.z]}
      castShadow
      receiveShadow
      userData={{ obstacleId: obstacle.id }}
      {...dragHandlers}
    >
      <coneGeometry args={[obstacle.r, height, 16]} />
      <meshStandardMaterial
        color="#e36a30"
        roughness={0.55}
        metalness={0.1}
      />
    </mesh>
  );
}
