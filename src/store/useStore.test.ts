import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './useStore';
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
  it('restores the default arm home pose when resetting the arm scene', () => {
    useStore.getState().setRobot({
      kind: 'arm',
      armHomePose: [0, 0, 0, 0, 0, 0],
    });
    useStore.getState().addSceneObject('cube', 'pickup', 'arm');
    useStore.getState().addSceneObject('cone', 'obstacle', 'rover');

    useStore.getState().resetRobotScene();

    expect(useStore.getState().robot.armHomePose).toEqual(BRACCIO_REST_RAD);
    expect(useStore.getState().sceneObjects.map((o) => o.owner)).toEqual([
      'rover',
    ]);
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
