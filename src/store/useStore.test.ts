import { beforeEach, describe, expect, it } from 'vitest';
import { Group } from 'three';
import { useStore } from './useStore';
import { ARM_PICKUP_SUCCESS_LIFT_M } from '../lib/armPickupOutcome';
import { BRACCIO_REST_RAD } from '../lib/braccio';

// Polyfill crypto.randomUUID for happy-dom (which has crypto but not randomUUID).
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: () => 'uuid-' + Math.random().toString(36).slice(2),
  });
}

beforeEach(() => {
  // Reset store to a known baseline before each test.
  useStore.setState({
    mode: 'motion',
    sceneObjects: [],
    assets: [],
    samples: [],
    isRecording: false,
    isGrabbed: false,
    pinchTarget: null,
    captures: [],
    showConveyor: false,
    conveyorSpeed: 0.5,
    envPreset: 'studio',
    anomalyLabel: 'normal',
    status: { kind: 'idle', msg: '' },
    robotRunning: false,
    armPickupObservation: null,
    armTargetId: null,
  });
});

describe('envPreset', () => {
  it('starts at studio (the dark-theme default)', () => {
    expect(useStore.getState().envPreset).toBe('studio');
  });

  it('setEnvPreset persists the chosen preset', () => {
    useStore.getState().setEnvPreset('whitebox');
    expect(useStore.getState().envPreset).toBe('whitebox');
    useStore.getState().setEnvPreset('warehouse');
    expect(useStore.getState().envPreset).toBe('warehouse');
    useStore.getState().setEnvPreset('outdoor');
    expect(useStore.getState().envPreset).toBe('outdoor');
  });

  it('does not auto-change when switching mode', () => {
    useStore.getState().setEnvPreset('warehouse');
    useStore.getState().setMode('detection');
    expect(useStore.getState().envPreset).toBe('warehouse');
    useStore.getState().setMode('anomaly');
    expect(useStore.getState().envPreset).toBe('warehouse');
  });
});

describe('captures', () => {
  const fakeBlob = new Blob(['x'], { type: 'image/png' });

  it('addCapture appends and assigns ts ordering', () => {
    const s = useStore.getState();
    s.addCapture({
      id: 'a',
      filename: 'a.png',
      blob: fakeBlob,
      boxes: [],
      label: '',
      width: 64,
      height: 48,
      ts: 1,
    });
    s.addCapture({
      id: 'b',
      filename: 'b.png',
      blob: fakeBlob,
      boxes: [{ label: 'cube', x: 0, y: 0, width: 10, height: 10 }],
      label: '',
      width: 64,
      height: 48,
      ts: 2,
    });
    const list = useStore.getState().captures;
    expect(list).toHaveLength(2);
    expect(list.map((c) => c.id)).toEqual(['a', 'b']);
    expect(list[1].boxes).toHaveLength(1);
  });

  it('clearCaptures empties the list', () => {
    const s = useStore.getState();
    s.addCapture({
      id: 'a',
      filename: 'a.png',
      blob: fakeBlob,
      boxes: [],
      label: '',
      width: 1,
      height: 1,
      ts: 0,
    });
    expect(useStore.getState().captures).toHaveLength(1);
    s.clearCaptures();
    expect(useStore.getState().captures).toHaveLength(0);
  });
});

describe('nextReleaseAngVel', () => {
  it('starts at null', () => {
    expect(useStore.getState().nextReleaseAngVel).toBeNull();
  });

  it('setNextReleaseAngVel stores the requested vector', () => {
    useStore.getState().setNextReleaseAngVel([1.5, -0.5, 2.0]);
    expect(useStore.getState().nextReleaseAngVel).toEqual([1.5, -0.5, 2.0]);
  });

  it('setNextReleaseAngVel(null) clears the hint', () => {
    useStore.getState().setNextReleaseAngVel([1, 2, 3]);
    useStore.getState().setNextReleaseAngVel(null);
    expect(useStore.getState().nextReleaseAngVel).toBeNull();
  });

  it('does not affect other state', () => {
    const before = useStore.getState().mode;
    useStore.getState().setNextReleaseAngVel([0.1, 0.2, 0.3]);
    expect(useStore.getState().mode).toBe(before);
  });
});

describe('anomalyLabel', () => {
  it('default is "normal"', () => {
    expect(useStore.getState().anomalyLabel).toBe('normal');
  });
  it('setAnomalyLabel updates the value', () => {
    useStore.getState().setAnomalyLabel('anomaly');
    expect(useStore.getState().anomalyLabel).toBe('anomaly');
  });
});

describe('mode', () => {
  it('starts in motion mode by default', () => {
    expect(useStore.getState().mode).toBe('motion');
  });
  it('switches mode', () => {
    useStore.getState().setMode('detection');
    expect(useStore.getState().mode).toBe('detection');
  });
});

describe('sceneObjects', () => {
  it('addSceneObject pushes a fully-formed entry', () => {
    useStore.getState().addSceneObject('sphere');
    const list = useStore.getState().sceneObjects;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      kind: 'sphere',
      label: 'sphere',
      scale: 1,
    });
    expect(list[0].id).toBeTypeOf('string');
    expect(list[0].position).toHaveLength(3);
  });

  it('honours an explicit label override', () => {
    useStore.getState().addSceneObject('cube', 'box-of-stuff');
    expect(useStore.getState().sceneObjects[0].label).toBe('box-of-stuff');
  });

  it('removeSceneObject removes by id', () => {
    useStore.getState().addSceneObject('cube');
    useStore.getState().addSceneObject('cone');
    const id = useStore.getState().sceneObjects[0].id;
    useStore.getState().removeSceneObject(id);
    const left = useStore.getState().sceneObjects;
    expect(left).toHaveLength(1);
    expect(left[0].kind).toBe('cone');
  });

  it('updateSceneObject patches a single object without touching others', () => {
    useStore.getState().addSceneObject('cube');
    useStore.getState().addSceneObject('sphere');
    const first = useStore.getState().sceneObjects[0];
    useStore.getState().updateSceneObject(first.id, { label: 'edited' });
    const list = useStore.getState().sceneObjects;
    expect(list[0].label).toBe('edited');
    expect(list[1].label).toBe('sphere');
  });

  it('clearSceneObjects empties the list', () => {
    useStore.getState().addSceneObject('cube');
    useStore.getState().addSceneObject('cone');
    useStore.getState().clearSceneObjects();
    expect(useStore.getState().sceneObjects).toEqual([]);
  });
});

describe('randomizeArmPickupPositions', () => {
  /** Tiny deterministic RNG so the assertions can hit specific values
   * without flaking — same shape as the rover-trajectory tests. */
  function seededRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  it('rewrites every arm-owned position into the reachable annulus', () => {
    useStore.getState().addArmPickupTarget('cube');
    useStore.getState().addArmPickupTarget('cube');
    useStore.getState().addArmPickupTarget('cube');
    // A non-arm object should NOT be touched — confirms the owner filter.
    useStore.getState().addSceneObject('cube', 'distractor');
    const distractorIdBefore = useStore
      .getState()
      .sceneObjects.find((o) => o.owner == null)?.id;
    const distractorPosBefore = useStore
      .getState()
      .sceneObjects.find((o) => o.id === distractorIdBefore)?.position;

    useStore.getState().randomizeArmPickupPositions(seededRng(7));

    const after = useStore.getState().sceneObjects;
    for (const o of after) {
      if (o.owner !== 'arm') continue;
      // Reachable workspace: radius ∈ [0.11, 0.22], angle ∈ [0, π].
      const r = Math.sqrt(o.position[0] ** 2 + o.position[2] ** 2);
      expect(r).toBeGreaterThanOrEqual(0.11 - 1e-9);
      expect(r).toBeLessThanOrEqual(0.22 + 1e-9);
      // Angle ∈ [0, π] means x ≥ 0 — front half-circle only.
      expect(o.position[0]).toBeGreaterThanOrEqual(-1e-9);
      // Y stays at half the cube extent so the body rests on the floor.
      expect(o.position[1]).toBeCloseTo(0.015, 9);
    }

    // Untagged distractor must keep its original position untouched.
    const distractorAfter = after.find((o) => o.id === distractorIdBefore);
    expect(distractorAfter?.position).toEqual(distractorPosBefore);
  });

  it('rewrites arm-owned imported assets using their floor origin', () => {
    useStore.getState().addAsset({
      id: 'asset-arm',
      name: 'bolt',
      label: 'pickup',
      object: new Group(),
      position: [9, 0, 9],
      rotation: [0, 0, 0],
      scale: 0.05,
      bounds: { size: [1, 1, 1], maxDim: 1 },
      physics: false,
      overrideMaterial: false,
      overrideColor: '#ffffff',
      overrideRoughness: 0.5,
      overrideMetalness: 0,
      handle: null,
      isAnimated: false,
      animationPlaying: false,
      owner: 'arm',
    });
    useStore.getState().addAsset({
      id: 'asset-rover',
      name: 'crate',
      label: 'obstacle',
      object: new Group(),
      position: [3, 0, 3],
      rotation: [0, 0, 0],
      scale: 1,
      bounds: { size: [1, 1, 1], maxDim: 1 },
      physics: false,
      overrideMaterial: false,
      overrideColor: '#ffffff',
      overrideRoughness: 0.5,
      overrideMetalness: 0,
      handle: null,
      isAnimated: false,
      animationPlaying: false,
      owner: 'rover',
    });

    useStore.getState().randomizeArmPickupPositions(seededRng(11));

    const armAsset = useStore
      .getState()
      .assets.find((a) => a.id === 'asset-arm');
    const roverAsset = useStore
      .getState()
      .assets.find((a) => a.id === 'asset-rover');
    expect(armAsset?.position[1]).toBe(0);
    const r = Math.sqrt(
      (armAsset?.position[0] ?? 0) ** 2 +
        (armAsset?.position[2] ?? 0) ** 2,
    );
    expect(r).toBeGreaterThanOrEqual(0.11 - 1e-9);
    expect(r).toBeLessThanOrEqual(0.22 + 1e-9);
    expect(roverAsset?.position).toEqual([3, 0, 3]);
  });

  it('is a no-op when there are no arm-owned objects', () => {
    useStore.getState().addSceneObject('sphere');
    const before = useStore.getState().sceneObjects;
    useStore.getState().randomizeArmPickupPositions(seededRng(1));
    const after = useStore.getState().sceneObjects;
    expect(after).toEqual(before);
  });
});

describe('motion recording', () => {
  it('startRecording sets the flag and resets samples', () => {
    useStore.setState({ samples: [{ t: 0, ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0 }] });
    useStore.getState().startRecording();
    expect(useStore.getState().isRecording).toBe(true);
    expect(useStore.getState().samples).toEqual([]);
  });

  it('pushSample only appends while recording', () => {
    useStore.getState().pushSample({ t: 1, ax: 0.1, ay: 0.2, az: 0.3, gx: 0, gy: 0, gz: 0 });
    expect(useStore.getState().samples).toEqual([]);

    useStore.getState().startRecording();
    useStore.getState().pushSample({ t: 2, ax: 0.4, ay: 0.5, az: 0.6, gx: 0, gy: 0, gz: 0 });
    expect(useStore.getState().samples).toHaveLength(1);

    useStore.getState().stopRecording();
    useStore.getState().pushSample({ t: 3, ax: 0.7, ay: 0.8, az: 0.9, gx: 0, gy: 0, gz: 0 });
    expect(useStore.getState().samples).toHaveLength(1); // didn't grow
  });
});

describe('robot scene reset', () => {
  it('tracks arm pickup lift outcome for sample metadata', () => {
    const s = useStore.getState();
    s.resetArmPickupObservation('target-a');
    expect(useStore.getState().armPickupObservation).toEqual({
      targetId: 'target-a',
      maxLiftM: 0,
      success: false,
    });

    s.observeArmPickupLift('target-a', ARM_PICKUP_SUCCESS_LIFT_M / 2);
    expect(useStore.getState().armPickupObservation?.success).toBe(false);

    s.observeArmPickupLift('target-a', ARM_PICKUP_SUCCESS_LIFT_M + 0.005);
    expect(useStore.getState().armPickupObservation?.success).toBe(true);
    expect(useStore.getState().armPickupObservation?.maxLiftM).toBeCloseTo(
      ARM_PICKUP_SUCCESS_LIFT_M + 0.005,
    );

    s.observeArmPickupLift('target-a', 0.001);
    expect(useStore.getState().armPickupObservation?.maxLiftM).toBeCloseTo(
      ARM_PICKUP_SUCCESS_LIFT_M + 0.005,
    );
  });

  it('restores the default arm home pose when resetting the arm scene', () => {
    useStore.getState().setRobot({
      kind: 'arm',
      armHomePose: [0, 0, 0, 0, 0, 0],
    });
    useStore.getState().addSceneObject('cube', 'pickup', 'arm');
    useStore.getState().addSceneObject('cone', 'obstacle', 'rover');

    useStore.getState().resetRobotScene();

    expect(useStore.getState().robot.armHomePose).toEqual(BRACCIO_REST_RAD);
    expect(useStore.getState().sceneObjects).toHaveLength(1);
    expect(useStore.getState().sceneObjects[0].owner).toBe('rover');
  });
});

describe('captures', () => {
  it('addCapture / clearCaptures', () => {
    const blob = new Blob([''], { type: 'image/png' });
    useStore.getState().addCapture({
      id: 'a',
      filename: 'a.png',
      blob,
      boxes: [],
      label: '',
      width: 64,
      height: 64,
      ts: 0,
    });
    expect(useStore.getState().captures).toHaveLength(1);
    useStore.getState().clearCaptures();
    expect(useStore.getState().captures).toEqual([]);
  });
});

describe('triggerCapture / triggerBatch', () => {
  it('increments signal counters', () => {
    const { captureSignal: c0, batchSignal: b0 } = useStore.getState();
    useStore.getState().triggerCapture();
    useStore.getState().triggerBatch();
    expect(useStore.getState().captureSignal).toBe(c0 + 1);
    expect(useStore.getState().batchSignal).toBe(b0 + 1);
  });
});

describe('Edge Impulse config', () => {
  it('setEi merges into existing config', () => {
    useStore.getState().setEi({ apiKey: 'ei_abc' });
    expect(useStore.getState().ei.apiKey).toBe('ei_abc');
    // Other fields preserved.
    expect(useStore.getState().ei.category).toBe('training');
  });
});
