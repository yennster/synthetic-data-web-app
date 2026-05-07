import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import type { EnvPreset } from '../store/useStore';

/**
 * Renders the floor + optional back walls for the scene based on the
 * selected environment preset. Replaces the old fixed-color Ground so the
 * user can pick a backdrop that suits their training data without needing
 * to import any external textures — every preset's surface is generated
 * procedurally on a `<canvas>` and uploaded as a `THREE.CanvasTexture`.
 *
 * The floor collider is identical across presets — only visuals change —
 * so physics behavior stays consistent regardless of which backdrop the
 * user picks.
 */
export function SceneEnvironment({ preset }: { preset: EnvPreset }) {
  const floorTex = useMemo(() => makeFloorTexture(preset), [preset]);
  const wallTex = useMemo(() => makeWallTexture(preset), [preset]);
  // Set scene.background so the virtual capture camera (which renders to its
  // own offscreen target through the same THREE.Scene) actually picks up the
  // sky/cyclorama backdrop. The CSS gradient on the <Canvas> only affects the
  // main viewport — captures rendered via captureFrame() get whatever the
  // scene's background is set to.
  const { scene } = useThree();
  useEffect(() => {
    const bg = makeSceneBackground(preset);
    const prev = scene.background;
    scene.background = bg;
    return () => {
      scene.background = prev;
      if (bg && 'dispose' in bg && typeof (bg as THREE.Texture).dispose === 'function') {
        (bg as THREE.Texture).dispose();
      }
    };
  }, [preset, scene]);
  const floorMaterial = useMemo(() => {
    if (!floorTex) {
      // whitebox uses a flat material (the cyclorama vibe), no procedural texture
      return new THREE.MeshStandardMaterial({
        color: presetFlatFloorColor(preset),
        roughness: presetFlatFloorRoughness(preset),
        metalness: 0.05,
      });
    }
    return new THREE.MeshStandardMaterial({
      map: floorTex,
      roughness: 0.85,
      metalness: 0.05,
    });
  }, [floorTex, preset]);

  return (
    <>
      <RigidBody type="fixed" colliders={false} friction={0.8} restitution={0.3}>
        <CuboidCollider args={[20, 0.5, 20]} position={[0, -0.5, 0]} />
        <mesh
          position={[0, -0.05, 0]}
          receiveShadow
          material={floorMaterial}
        >
          <boxGeometry args={[40, 0.1, 40]} />
        </mesh>
      </RigidBody>
      {/* Back walls at the far edges. Provide both visual and a thin
          collider so a fast-thrown object can't escape the scene. */}
      {hasWalls(preset) && (
        <RigidBody type="fixed" colliders={false} friction={0.5}>
          {/* North wall */}
          <CuboidCollider args={[20, 5, 0.1]} position={[0, 5, -20]} />
          <mesh position={[0, 5, -20]} receiveShadow castShadow>
            <boxGeometry args={[40, 10, 0.2]} />
            <WallMaterial preset={preset} tex={wallTex} />
          </mesh>
          {/* South wall */}
          <CuboidCollider args={[20, 5, 0.1]} position={[0, 5, 20]} />
          <mesh position={[0, 5, 20]} receiveShadow castShadow>
            <boxGeometry args={[40, 10, 0.2]} />
            <WallMaterial preset={preset} tex={wallTex} />
          </mesh>
          {/* East wall */}
          <CuboidCollider args={[0.1, 5, 20]} position={[20, 5, 0]} />
          <mesh position={[20, 5, 0]} receiveShadow castShadow>
            <boxGeometry args={[0.2, 10, 40]} />
            <WallMaterial preset={preset} tex={wallTex} />
          </mesh>
          {/* West wall */}
          <CuboidCollider args={[0.1, 5, 20]} position={[-20, 5, 0]} />
          <mesh position={[-20, 5, 0]} receiveShadow castShadow>
            <boxGeometry args={[0.2, 10, 40]} />
            <WallMaterial preset={preset} tex={wallTex} />
          </mesh>
        </RigidBody>
      )}
    </>
  );
}

function WallMaterial({
  preset,
  tex,
}: {
  preset: EnvPreset;
  tex: THREE.Texture | null;
}) {
  if (tex) {
    return (
      <meshStandardMaterial
        map={tex}
        roughness={0.9}
        metalness={0.05}
      />
    );
  }
  return (
    <meshStandardMaterial
      color={presetFlatWallColor(preset)}
      roughness={0.9}
      metalness={0.05}
    />
  );
}

function hasWalls(preset: EnvPreset): boolean {
  return preset === 'warehouse' || preset === 'whitebox';
}

function presetFlatFloorColor(preset: EnvPreset): string {
  switch (preset) {
    case 'whitebox':
      return '#f1f1ee';
    case 'studio':
      return '#1c2128';
    default:
      return '#1c2128';
  }
}

function presetFlatFloorRoughness(preset: EnvPreset): number {
  return preset === 'whitebox' ? 0.6 : 0.95;
}

function presetFlatWallColor(preset: EnvPreset): string {
  return preset === 'whitebox' ? '#f1f1ee' : '#3d4651';
}

/**
 * Background that's actually visible to the WebGL renderer (and therefore
 * to virtual-camera captures). For outdoor we render a vertical sky
 * gradient texture; for the others we use a flat color matching the CSS
 * canvas backdrop so captures look consistent with what the user sees.
 */
function makeSceneBackground(preset: EnvPreset): THREE.Texture | THREE.Color {
  switch (preset) {
    case 'outdoor':
      return makeSkyGradient();
    case 'whitebox':
      return new THREE.Color('#f1f1ee');
    case 'warehouse':
      return new THREE.Color('#1f1c18');
    case 'studio':
    default:
      return new THREE.Color('#0e1115');
  }
}

function makeSkyGradient(): THREE.Texture {
  // Vertical gradient: brighter near the horizon, deeper blue overhead.
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#5fa3d6');
  grad.addColorStop(0.55, '#9bc1dd');
  grad.addColorStop(1, '#dfe7ec');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 2, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

// ---------- Procedural textures ----------

function makeFloorTexture(preset: EnvPreset): THREE.Texture | null {
  switch (preset) {
    case 'warehouse':
      return concreteTexture({
        base: '#a39a8c',
        stainAlpha: 0.12,
        crackCount: 18,
        speckles: 3000,
        repeat: 12,
      });
    case 'outdoor':
      return grassTexture();
    case 'studio':
    case 'whitebox':
      return null;
  }
}

function makeWallTexture(preset: EnvPreset): THREE.Texture | null {
  switch (preset) {
    case 'warehouse':
      // Painted-concrete wall: lighter base, fewer/lighter stains, vertical streaks.
      return concreteTexture({
        base: '#cdc4b4',
        stainAlpha: 0.06,
        crackCount: 6,
        speckles: 1500,
        repeat: 6,
        verticalStreaks: true,
      });
    case 'whitebox':
    case 'studio':
    case 'outdoor':
      return null;
  }
}

function concreteTexture(opts: {
  base: string;
  stainAlpha: number;
  crackCount: number;
  speckles: number;
  repeat: number;
  verticalStreaks?: boolean;
}): THREE.Texture {
  const { base, stainAlpha, crackCount, speckles, repeat, verticalStreaks } = opts;
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d')!;
  // Base
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 512, 512);
  // Soft tonal blobs to break up uniformity
  for (let i = 0; i < 90; i++) {
    const r = 40 + Math.random() * 120;
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    const dark = Math.random() < 0.5;
    grad.addColorStop(0, `rgba(${dark ? 50 : 230}, ${dark ? 45 : 220}, ${dark ? 40 : 200}, ${stainAlpha})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Cracks — short jagged polylines
  ctx.strokeStyle = 'rgba(40, 35, 30, 0.45)';
  ctx.lineWidth = 1;
  for (let i = 0; i < crackCount; i++) {
    let x = Math.random() * 512;
    let y = Math.random() * 512;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const segs = 4 + Math.floor(Math.random() * 4);
    for (let j = 0; j < segs; j++) {
      x += (Math.random() - 0.5) * 80;
      y += (Math.random() - 0.5) * 80;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // Vertical streaks (for walls — paint runs / weathering)
  if (verticalStreaks) {
    for (let i = 0; i < 18; i++) {
      const x = Math.random() * 512;
      const y0 = Math.random() * 256;
      const len = 80 + Math.random() * 200;
      const grad = ctx.createLinearGradient(x, y0, x, y0 + len);
      grad.addColorStop(0, 'rgba(60, 55, 45, 0)');
      grad.addColorStop(0.5, 'rgba(60, 55, 45, 0.18)');
      grad.addColorStop(1, 'rgba(60, 55, 45, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y0, 1 + Math.random() * 2, len);
    }
  }
  // Fine speckles for a gritty surface feel
  for (let i = 0; i < speckles; i++) {
    ctx.fillStyle = `rgba(0, 0, 0, ${Math.random() * 0.18})`;
    ctx.fillRect(Math.random() * 512, Math.random() * 512, 1, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function grassTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d')!;
  // Base grass green
  ctx.fillStyle = '#3a5e2a';
  ctx.fillRect(0, 0, 512, 512);
  // Variation patches
  for (let i = 0; i < 200; i++) {
    const r = 8 + Math.random() * 24;
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const g = 70 + Math.random() * 60;
    const dr = 30 + Math.random() * 30;
    ctx.fillStyle = `rgba(${dr}, ${g}, ${30 + Math.random() * 25}, 0.4)`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Blade-like flecks
  for (let i = 0; i < 4000; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    ctx.strokeStyle = `rgba(${30 + Math.random() * 40}, ${100 + Math.random() * 80}, ${30 + Math.random() * 30}, 0.5)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 4, y - 2 - Math.random() * 4);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(20, 20);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
