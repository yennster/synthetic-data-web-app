import { RigidBody, CuboidCollider } from '@react-three/rapier';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import {
  BELT_COLLIDER_DEPTH,
  BELT_HEIGHT,
  BELT_LENGTH,
  BELT_TOP_Y,
  BELT_TRANSPORTABLES,
  BELT_WIDTH,
  isOnBelt,
} from '../lib/beltDynamics';
import { useStore } from '../store/useStore';

/**
 * A conveyor belt: a static collider with a scrolling striped texture and
 * support legs that stand on the ground (y=0). The belt slab sits at
 * BELT_TOP_Y so the legs are visible above the floor instead of clipping
 * through it.
 *
 * Bodies registered in `BELT_TRANSPORTABLES` and currently resting on top
 * of the belt are pushed in the belt direction every frame (rapier in our
 * version doesn't natively support per-collider surface velocity, so we
 * simulate it by overriding the Z component of velocity on contacted
 * bodies).
 *
 * Direction: positive `conveyorSpeed` moves objects in +Z and the visual
 * stripes scroll the same way, so the user sees a coherent transport.
 */

// Layout (all in world Y):
//   ground top:           0
//   leg bottom:           0
//   leg top / belt bottom: BELT_TOP_Y - BELT_HEIGHT  = 0.4
//   belt top:             BELT_TOP_Y                = 0.5
const BELT_BOTTOM_Y = BELT_TOP_Y - BELT_HEIGHT;
const LEG_HEIGHT = BELT_BOTTOM_Y;
const LEG_CENTER_Y = LEG_HEIGHT / 2;

export function Conveyor() {
  const speed = useStore((s) => s.conveyorSpeed);
  const matRef = useRef<THREE.MeshStandardMaterial>(null);

  // How many times the stripe pattern tiles along the belt's length. Stays
  // tied to the texture animation below — UV offset has to be scaled by
  // this to keep the visual stripe speed locked to physical body speed.
  const TEXTURE_REPEAT_Y = 6;

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
    tex.repeat.set(1, TEXTURE_REPEAT_Y);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  useFrame((_, dt) => {
    // Visual scroll. Three.js box top-face V-axis is along -Z, so to make
    // stripes visually flow in +Z we *increase* offset.y as speed > 0. The
    // factor of `repeat / length` converts world-space speed (m/s) into
    // UV-space offset units — without it the texture appears to slide
    // ~1.3× faster than the bodies on top, breaking the illusion that
    // the belt is what's transporting them.
    texture.offset.y += (speed * dt * TEXTURE_REPEAT_Y) / BELT_LENGTH;

    // Transport bodies that are on top of the belt.
    if (Math.abs(speed) < 1e-4) return;
    for (const body of BELT_TRANSPORTABLES) {
      const t = body.translation();
      if (!isOnBelt(t)) continue;
      const lv = body.linvel();
      // Override Z velocity to match the belt speed. Damp X velocity so things
      // don't skitter sideways forever; leave Y alone so gravity / bouncing
      // still works naturally.
      body.setLinvel(
        { x: lv.x * 0.4, y: lv.y, z: speed },
        true,
      );
    }
  });

  return (
    <group position={[0, 0, 0]}>
      {/* Belt surface — collider extends below the visual mesh so objects
          can't tunnel through the thin top slab on fast falls. The top
          surface sits at y=BELT_TOP_Y for the on-belt detection. */}
      <RigidBody type="fixed" colliders={false} friction={0.9} restitution={0.1}>
        <CuboidCollider
          args={[BELT_WIDTH / 2, BELT_COLLIDER_DEPTH / 2, BELT_LENGTH / 2]}
          position={[0, BELT_TOP_Y - BELT_COLLIDER_DEPTH / 2, 0]}
        />
        <mesh
          position={[0, BELT_TOP_Y - BELT_HEIGHT / 2, 0]}
          receiveShadow
          castShadow
        >
          <boxGeometry args={[BELT_WIDTH, BELT_HEIGHT, BELT_LENGTH]} />
          <meshStandardMaterial
            ref={matRef}
            map={texture}
            roughness={0.7}
            metalness={0.1}
          />
        </mesh>
      </RigidBody>

      {/* Side rails — visual mesh + matching fixed collider so objects can't
          slip through and fall off the conveyor. The visual box and the
          collider share the same half-extents and position so what you see
          is exactly what objects bounce off. The collider extends downward
          from the rail top to the belt surface, sealing the gap that
          previously let cans tip over the edge. */}
      <RigidBody type="fixed" colliders={false} friction={0.4} restitution={0.05}>
        {[-1, 1].map((side) => (
          <CuboidCollider
            key={`rail-col-${side}`}
            // half-width 0.06, centered at ±(BELT_WIDTH/2 + 0.06) so the
            // inner face sits exactly at the belt edge — no gap for small
            // objects to slip through. Half-height 0.22 covers from y=0.44
            // (below belt top) up to y=0.88 (well above any settled can).
            args={[0.06, 0.22, BELT_LENGTH / 2]}
            position={[side * (BELT_WIDTH / 2 + 0.06), BELT_TOP_Y + 0.16, 0]}
          />
        ))}
      </RigidBody>
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          position={[
            side * (BELT_WIDTH / 2 + 0.06),
            BELT_TOP_Y + 0.18,
            0,
          ]}
          castShadow
        >
          <boxGeometry args={[0.08, 0.36, BELT_LENGTH]} />
          <meshStandardMaterial color="#9ca3af" roughness={0.4} metalness={0.6} />
        </mesh>
      ))}

      {/* End-cap rollers, centered on the belt's mid-height. */}
      {[-1, 1].map((end) => (
        <mesh
          key={end}
          position={[
            0,
            BELT_TOP_Y - BELT_HEIGHT / 2,
            end * (BELT_LENGTH / 2),
          ]}
          rotation={[0, 0, Math.PI / 2]}
          castShadow
        >
          <cylinderGeometry args={[BELT_HEIGHT / 1.6, BELT_HEIGHT / 1.6, BELT_WIDTH, 16]} />
          <meshStandardMaterial color="#6b7280" roughness={0.3} metalness={0.8} />
        </mesh>
      ))}

      {/* Frame: cross-beams running the length of the belt under each
          outer edge, and short crossbars connecting them at each end.
          This is what the legs actually attach to and what carries the
          belt's load — much more believable than free-floating legs. */}
      {[-1, 1].map((side) => (
        <mesh
          key={`rail-${side}`}
          position={[
            side * (BELT_WIDTH / 2 - 0.04),
            BELT_BOTTOM_Y - 0.04,
            0,
          ]}
          castShadow
        >
          <boxGeometry args={[0.06, 0.08, BELT_LENGTH - 0.2]} />
          <meshStandardMaterial color="#4b5563" roughness={0.5} metalness={0.5} />
        </mesh>
      ))}
      {[-1, 1].map((end) => (
        <mesh
          key={`crossbar-${end}`}
          position={[0, BELT_BOTTOM_Y - 0.04, end * (BELT_LENGTH / 2 - 0.4)]}
          castShadow
        >
          <boxGeometry args={[BELT_WIDTH - 0.04, 0.06, 0.06]} />
          <meshStandardMaterial color="#4b5563" roughness={0.5} metalness={0.5} />
        </mesh>
      ))}

      {/* Support legs — bottoms sit on the ground (y=0), tops attach to
          the corners of the frame above. Tucked just inside the belt's
          XZ footprint so they look attached, not floating. */}
      {[
        [-(BELT_WIDTH / 2 - 0.04), -(BELT_LENGTH / 2 - 0.4)],
        [BELT_WIDTH / 2 - 0.04, -(BELT_LENGTH / 2 - 0.4)],
        [-(BELT_WIDTH / 2 - 0.04), BELT_LENGTH / 2 - 0.4],
        [BELT_WIDTH / 2 - 0.04, BELT_LENGTH / 2 - 0.4],
      ].map(([x, z], i) => (
        <mesh key={`leg-${i}`} position={[x, LEG_CENTER_Y, z]} castShadow>
          <boxGeometry args={[0.06, LEG_HEIGHT, 0.06]} />
          <meshStandardMaterial color="#4b5563" roughness={0.5} metalness={0.5} />
        </mesh>
      ))}
    </group>
  );
}
