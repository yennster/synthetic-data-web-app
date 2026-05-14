import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

/**
 * Locks in the layered-raycasting invariant that drives the virtual
 * capture camera's drag handle:
 *
 *   - Gizmo meshes sit on layer 1 (`GIZMO_LAYER` in Scene.tsx) so the
 *     capture cameras (default raycast/render mask = layer 0) skip
 *     them.
 *   - The orbit camera enables layer 1 on *both* its render mask AND
 *     r3f's pointer-event raycaster, so the orbit user can see *and*
 *     click them.
 *
 * The previous bug: only the camera's render layer was enabled, not the
 * raycaster's. The handle therefore drew on screen but pointer events
 * silently fell through to OrbitControls — a tricky symptom because the
 * fix lives in a completely different code path from the visuals.
 */

const GIZMO_LAYER = 1;

function buildSceneWithGizmo() {
  const scene = new THREE.Scene();
  const handleGroup = new THREE.Group();
  // The actual hit-target shape used by VirtualCameraHandle.
  const hitTarget = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 12, 12),
    new THREE.MeshBasicMaterial(),
  );
  hitTarget.visible = false; // mirrors the production setup
  handleGroup.add(hitTarget);
  handleGroup.position.set(1.5, 1.5, 1.5);
  handleGroup.updateMatrixWorld(true);
  // The production code traverse-sets every gizmo descendant to layer 1.
  handleGroup.traverse((o) => o.layers.set(GIZMO_LAYER));
  scene.add(handleGroup);
  return { scene, hitTarget };
}

function rayFromOrbitOriginThrough(point: THREE.Vector3): THREE.Raycaster {
  const origin = new THREE.Vector3(4, 3, 6);
  const dir = point.clone().sub(origin).normalize();
  const ray = new THREE.Raycaster(origin, dir);
  return ray;
}

describe('gizmo layer + raycaster interaction', () => {
  it('default raycaster (layer 0 only) MISSES gizmo-layer meshes — this is what the capture cameras do', () => {
    const { scene, hitTarget } = buildSceneWithGizmo();
    const ray = rayFromOrbitOriginThrough(
      new THREE.Vector3(1.5, 1.5, 1.5),
    );
    // Sanity: ray definitely points at the hit-target. Confirm by
    // running with layer 1 enabled.
    ray.layers.enable(GIZMO_LAYER);
    const withLayer = ray.intersectObjects(scene.children, true);
    expect(withLayer.length).toBeGreaterThan(0);

    // Now back to layer-0-only (default mask). The capture-cam scenario.
    ray.layers.set(0);
    const layer0Only = ray.intersectObjects(scene.children, true);
    expect(layer0Only.length).toBe(0);
    expect(hitTarget.layers.test(ray.layers)).toBe(false);
  });

  it('orbit raycaster (layers 0 + 1) HITS the invisible hit-target — this is the fix', () => {
    const { scene, hitTarget } = buildSceneWithGizmo();
    const ray = rayFromOrbitOriginThrough(
      new THREE.Vector3(1.5, 1.5, 1.5),
    );
    ray.layers.enable(GIZMO_LAYER);
    const hits = ray.intersectObjects(scene.children, true);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].object).toBe(hitTarget);
  });

  it('three.js Raycaster.intersectObject ignores `visible` — invisible hit-target is still pickable', () => {
    const { scene } = buildSceneWithGizmo();
    const ray = rayFromOrbitOriginThrough(
      new THREE.Vector3(1.5, 1.5, 1.5),
    );
    ray.layers.enable(GIZMO_LAYER);
    const hits = ray.intersectObjects(scene.children, true);
    // The hit-target is visible=false, but still appears in intersects.
    expect(hits[0].object.visible).toBe(false);
  });

  it('a 0.5 m hit sphere covers the (28 cm body) icon area generously', () => {
    // Body box was 0.28 × 0.20 × 0.18. The hit sphere should contain it.
    const body = new THREE.Box3(
      new THREE.Vector3(-0.14, -0.1, -0.09),
      new THREE.Vector3(0.14, 0.1, 0.09),
    );
    const bodyCorner = body.max.length();
    expect(bodyCorner).toBeLessThan(0.5);
  });
});
