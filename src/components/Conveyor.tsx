import { RigidBody, CuboidCollider } from '@react-three/rapier';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useStore } from '../store/useStore';

const BELT_LENGTH = 8;
const BELT_WIDTH = 1.6;
const BELT_HEIGHT = 0.1;

/**
 * A simple conveyor belt: a static collider at y=0 with a scrolling striped
 * texture, flanked by two side rails. The belt doesn't actually transport
 * dynamic bodies (that would need surface velocity from the physics engine);
 * it's a visual prop for object-detection scenes. Motion-mode users won't
 * see it.
 */
export function Conveyor() {
  const speed = useStore((s) => s.conveyorSpeed);
  const matRef = useRef<THREE.MeshStandardMaterial>(null);

  const texture = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 256;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#222831';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#3d4651';
    for (let i = 0; i < 8; i++) {
      ctx.fillRect(0, i * 32, c.width, 16);
    }
    ctx.fillStyle = '#1a1f26';
    for (let i = 0; i < 9; i++) {
      ctx.fillRect(0, i * 32 - 1, c.width, 2);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 6);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  useFrame((_, dt) => {
    texture.offset.y -= speed * dt;
  });

  return (
    <group position={[0, 0, 0]}>
      {/* Belt surface */}
      <RigidBody type="fixed" colliders={false} friction={0.9} restitution={0.1}>
        <CuboidCollider
          args={[BELT_WIDTH / 2, BELT_HEIGHT / 2, BELT_LENGTH / 2]}
          position={[0, BELT_HEIGHT / 2, 0]}
        />
        <mesh position={[0, BELT_HEIGHT / 2, 0]} receiveShadow castShadow>
          <boxGeometry args={[BELT_WIDTH, BELT_HEIGHT, BELT_LENGTH]} />
          <meshStandardMaterial
            ref={matRef}
            map={texture}
            roughness={0.7}
            metalness={0.1}
          />
        </mesh>
      </RigidBody>

      {/* Side rails */}
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          position={[side * (BELT_WIDTH / 2 + 0.06), 0.18, 0]}
          castShadow
        >
          <boxGeometry args={[0.08, 0.36, BELT_LENGTH]} />
          <meshStandardMaterial color="#9ca3af" roughness={0.4} metalness={0.6} />
        </mesh>
      ))}

      {/* End caps with rollers */}
      {[-1, 1].map((end) => (
        <mesh
          key={end}
          position={[0, BELT_HEIGHT / 2, end * (BELT_LENGTH / 2)]}
          rotation={[0, 0, Math.PI / 2]}
          castShadow
        >
          <cylinderGeometry args={[BELT_HEIGHT / 1.6, BELT_HEIGHT / 1.6, BELT_WIDTH, 16]} />
          <meshStandardMaterial color="#6b7280" roughness={0.3} metalness={0.8} />
        </mesh>
      ))}

      {/* Support legs */}
      {[
        [-BELT_WIDTH / 2 - 0.1, -BELT_LENGTH / 2 + 0.4],
        [BELT_WIDTH / 2 + 0.1, -BELT_LENGTH / 2 + 0.4],
        [-BELT_WIDTH / 2 - 0.1, BELT_LENGTH / 2 - 0.4],
        [BELT_WIDTH / 2 + 0.1, BELT_LENGTH / 2 - 0.4],
      ].map(([x, z], i) => (
        <mesh key={i} position={[x, -0.4, z]}>
          <boxGeometry args={[0.06, 0.8, 0.06]} />
          <meshStandardMaterial color="#4b5563" roughness={0.5} metalness={0.5} />
        </mesh>
      ))}
    </group>
  );
}
