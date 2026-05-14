import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import { useStore, type EnvPreset } from '../store/useStore';
import { useCustomTexture } from '../lib/useCustomTexture';

/**
 * Renders the floor and physics collider for the chosen environment
 * preset. The "walls" are no longer four tiled quads — they're a
 * panoramic skybox texture installed on `scene.background` (using
 * equirectangular mapping). The colliders that used to live on the
 * wall meshes are kept so fast-thrown objects can't escape the scene.
 *
 * A user-uploaded wall texture is interpreted as the skybox panorama
 * (still seamless across the horizon if the source is tileable on its
 * horizontal axis).
 */
export function SceneEnvironment({ preset }: { preset: EnvPreset }) {
  const customFloorMeta = useStore((s) => s.customFloorTexture);
  const customWallMeta = useStore((s) => s.customWallTexture);
  const customFloorTex = useCustomTexture('floor', customFloorMeta?.name ?? null, {
    repeat: 4,
  });
  // Skybox panorama: don't repeat-tile the user's upload — it wraps once
  // around the horizon as a 360° backdrop.
  const customSkyboxTex = useCustomTexture('wall', customWallMeta?.name ?? null, {
    repeat: 1,
  });
  const floorTex = useMemo(
    () => customFloorTex ?? makeFloorTexture(preset),
    [customFloorTex, preset],
  );
  const { scene } = useThree();
  useEffect(() => {
    let bg: THREE.Texture | THREE.Color;
    if (customSkyboxTex) {
      customSkyboxTex.mapping = THREE.EquirectangularReflectionMapping;
      customSkyboxTex.colorSpace = THREE.SRGBColorSpace;
      bg = customSkyboxTex;
    } else {
      bg = makeSceneBackground(preset);
    }
    const prev = scene.background;
    scene.background = bg;
    return () => {
      scene.background = prev;
      // Only dispose textures we created here; the custom skybox is
      // owned by useCustomTexture and disposed on slot turnover.
      if (
        bg !== customSkyboxTex &&
        bg &&
        'dispose' in bg &&
        typeof (bg as THREE.Texture).dispose === 'function'
      ) {
        (bg as THREE.Texture).dispose();
      }
    };
  }, [preset, scene, customSkyboxTex]);
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

  // Wall colliders so a fast-thrown object can't escape the scene — these
  // are invisible now that the visible walls are a skybox panorama.
  const showColliders = hasWalls(preset) || !!customWallMeta;

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
      {showColliders && (
        <RigidBody type="fixed" colliders={false} friction={0.5}>
          <CuboidCollider args={[20, 5, 0.1]} position={[0, 5, -20]} />
          <CuboidCollider args={[20, 5, 0.1]} position={[0, 5, 20]} />
          <CuboidCollider args={[0.1, 5, 20]} position={[20, 5, 0]} />
          <CuboidCollider args={[0.1, 5, 20]} position={[-20, 5, 0]} />
        </RigidBody>
      )}
    </>
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

/**
 * Build a procedural equirectangular skybox texture for the chosen
 * preset. Returned with `EquirectangularReflectionMapping` so three.js
 * samples it correctly when assigned to `scene.background`.
 *
 * Studio/whitebox use vertical gradients (cyclorama feel), warehouse
 * draws a banded wall + roof panorama, outdoor draws a sky with a
 * horizon and a faint cloud bank.
 */
function makeSceneBackground(preset: EnvPreset): THREE.Texture | THREE.Color {
  const tex = makeSkyboxTexture(preset);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeSkyboxTexture(preset: EnvPreset): THREE.Texture {
  // 2:1 equirect canvas. 2048 wide is plenty for a backdrop sampled at
  // far distances and keeps texture memory modest (~16 MB).
  const W = 2048;
  const H = 1024;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  switch (preset) {
    case 'outdoor':
      drawOutdoorSky(ctx, W, H);
      break;
    case 'warehouse':
      drawWarehousePanorama(ctx, W, H);
      break;
    case 'whitebox':
      drawWhiteboxCyclorama(ctx, W, H);
      break;
    case 'studio':
    default:
      drawStudioCyclorama(ctx, W, H);
      break;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  return tex;
}

function drawOutdoorSky(ctx: CanvasRenderingContext2D, W: number, H: number) {
  // Vertical sky gradient — top of canvas is zenith, bottom is below
  // horizon (ground band).
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#3d7fb8');
  grad.addColorStop(0.45, '#7fb1d4');
  grad.addColorStop(0.55, '#bcd6e6');
  grad.addColorStop(0.6, '#c8d8df');
  grad.addColorStop(0.62, '#7a8a72');
  grad.addColorStop(1, '#3a5e2a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // Soft drifting clouds in the upper half. Wrap across the seam so the
  // panorama tiles cleanly at the back of the camera.
  ctx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 24; i++) {
    const cx = Math.random() * W;
    const cy = Math.random() * H * 0.45;
    const r = 40 + Math.random() * 140;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    // Mirror-wrap near the seams so clouds don't get cut off
    if (cx < 200) {
      const g2 = ctx.createRadialGradient(cx + W, cy, 0, cx + W, cy, r);
      g2.addColorStop(0, 'rgba(255,255,255,0.55)');
      g2.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.arc(cx + W, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Horizon haze
  const haze = ctx.createLinearGradient(0, H * 0.52, 0, H * 0.62);
  haze.addColorStop(0, 'rgba(220, 220, 210, 0)');
  haze.addColorStop(0.5, 'rgba(220, 220, 210, 0.45)');
  haze.addColorStop(1, 'rgba(220, 220, 210, 0)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, H * 0.52, W, H * 0.1);
}

function drawWarehousePanorama(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
) {
  // Top half: dark ceiling, with a row of overhead lights.
  ctx.fillStyle = '#1f1c18';
  ctx.fillRect(0, 0, W, H * 0.4);
  for (let i = 0; i < 8; i++) {
    const x = ((i + 0.5) / 8) * W;
    const y = H * 0.22;
    const g = ctx.createRadialGradient(x, y, 0, x, y, 90);
    g.addColorStop(0, 'rgba(255, 235, 180, 0.85)');
    g.addColorStop(1, 'rgba(255, 235, 180, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, 90, 0, Math.PI * 2);
    ctx.fill();
  }
  // Wall band (the bulk of what we see at eye level).
  ctx.fillStyle = '#cdc4b4';
  ctx.fillRect(0, H * 0.4, W, H * 0.45);
  // Soft tonal blobs + vertical streaks for paint-weathering vibe.
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * W;
    const y = H * 0.4 + Math.random() * H * 0.45;
    const r = 50 + Math.random() * 160;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    const dark = Math.random() < 0.5;
    grad.addColorStop(
      0,
      `rgba(${dark ? 50 : 230}, ${dark ? 45 : 220}, ${dark ? 40 : 200}, 0.10)`,
    );
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 30; i++) {
    const x = Math.random() * W;
    const y0 = H * 0.4 + Math.random() * H * 0.1;
    const len = 80 + Math.random() * 250;
    const g = ctx.createLinearGradient(x, y0, x, y0 + len);
    g.addColorStop(0, 'rgba(60, 55, 45, 0)');
    g.addColorStop(0.5, 'rgba(60, 55, 45, 0.18)');
    g.addColorStop(1, 'rgba(60, 55, 45, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y0, 1 + Math.random() * 2, len);
  }
  // Floor band along the bottom so the skybox blends down to the actual
  // floor color without a hard edge.
  ctx.fillStyle = '#1f1c18';
  ctx.fillRect(0, H * 0.85, W, H * 0.15);
  const fadeUp = ctx.createLinearGradient(0, H * 0.82, 0, H * 0.9);
  fadeUp.addColorStop(0, 'rgba(31, 28, 24, 0)');
  fadeUp.addColorStop(1, 'rgba(31, 28, 24, 1)');
  ctx.fillStyle = fadeUp;
  ctx.fillRect(0, H * 0.82, W, H * 0.08);
}

function drawStudioCyclorama(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
) {
  // Dark gradient cyclorama. Top slightly lighter than bottom so motion
  // capture against this backdrop reads three-dimensional rather than
  // perfectly flat.
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#181c22');
  g.addColorStop(1, '#0a0c10');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Faint vignetting blobs across the equator.
  for (let i = 0; i < 10; i++) {
    const x = Math.random() * W;
    const y = H / 2 + (Math.random() - 0.5) * H * 0.3;
    const r = 200 + Math.random() * 300;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.04)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawWhiteboxCyclorama(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
) {
  // Bright off-white seamless backdrop.
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#f5f5f2');
  g.addColorStop(0.6, '#eeeeea');
  g.addColorStop(1, '#dcdcd6');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
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
