import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { scanLidar } from './lidar';

/**
 * Build a small target group with one box obstacle in front of the
 * rover. Uses three.js primitives so the raycaster behaves exactly
 * the way it does in the live scene.
 */
function singleBoxAt(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.3, 0.3),
    new THREE.MeshBasicMaterial(),
  );
  m.position.set(x, 0.15, z);
  g.add(m);
  // Three.js needs the world matrix updated for raycasts to find children
  // when the group hasn't been added to a Scene with a render pass.
  g.updateMatrixWorld(true);
  return g;
}

describe('scanLidar', () => {
  it('reports max-range for every beam when there are no obstacles', () => {
    const ranges = scanLidar({
      origin: { x: 0, y: 0.3, z: 0 },
      heading: 0,
      bins: 16,
      maxRange: 5,
      target: new THREE.Group(),
    });
    expect(ranges.length).toBe(16);
    for (const r of ranges) expect(r).toBeCloseTo(5, 5);
  });

  it('detects an obstacle directly ahead', () => {
    // Heading=0 → bin 0 points along +Z. Place a box at z=2.
    const target = singleBoxAt(0, 2);
    const ranges = scanLidar({
      origin: { x: 0, y: 0.3, z: 0 },
      heading: 0,
      bins: 16,
      maxRange: 5,
      target,
    });
    // Bin 0 should report ~2m (front face of the box).
    expect(ranges[0]).toBeGreaterThan(1.5);
    expect(ranges[0]).toBeLessThan(2.1);
    // Bin 8 (opposite direction) should still report max.
    expect(ranges[8]).toBeCloseTo(5, 5);
  });

  it('rotates the bin layout with the rover heading', () => {
    // Same box, but with a heading rotated 90° (faces +X). Now bin 0
    // should hit nothing (no box on +X axis), and the bin pointing at
    // the box (in world +Z) should fire instead.
    const target = singleBoxAt(0, 2);
    const ranges = scanLidar({
      origin: { x: 0, y: 0.3, z: 0 },
      heading: Math.PI / 2,
      bins: 16,
      maxRange: 5,
      target,
    });
    expect(ranges[0]).toBeCloseTo(5, 5);
    // Some bin should have detected the box.
    const minRange = Math.min(...ranges);
    expect(minRange).toBeLessThan(2.1);
  });

  it('clamps reads past maxRange', () => {
    const target = singleBoxAt(0, 8);
    const ranges = scanLidar({
      origin: { x: 0, y: 0.3, z: 0 },
      heading: 0,
      bins: 8,
      maxRange: 5,
      target,
    });
    for (const r of ranges) expect(r).toBeLessThanOrEqual(5);
  });
});
