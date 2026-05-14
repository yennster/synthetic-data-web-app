import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyUrlPresets } from './applyUrlPresets';
import { useStore } from '../store/useStore';
import {
  URL_PRESETS,
  refreshUrlParams,
} from './urlParams';
import { _resetRngForTest } from './rng';

if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: () => 'uuid-' + Math.random().toString(36).slice(2),
    configurable: true,
  });
}

// Helper: stub `window.location.search`, then refresh URL_PRESETS so
// `applyUrlPresets` sees the new state on each test.
function setSearch(qs: string) {
  // happy-dom exposes a mutable `location` setter.
  window.history.replaceState({}, '', `?${qs}`);
  refreshUrlParams();
}

const STORE_BASELINE = () => ({
  mode: 'detection' as const,
  sceneObjects: [],
  assets: [],
  selectedIds: [],
  envPreset: 'studio' as const,
  showConveyor: false,
  conveyorSpeed: 0.5,
  capture: {
    width: 640,
    height: 480,
    camPos: [3.5, 3, 3.5] as [number, number, number],
    camTarget: [0, 0.5, 0] as [number, number, number],
    fov: 45,
    randomizeCamera: true,
    randomizeLighting: true,
    randomizeObjects: false,
    batchCount: 10,
    lightIntensity: 1.1,
    envRotation: 0,
    cameraTrajectory: 'random' as const,
    trajectoryRadius: 4,
    trajectoryHeight: 2,
  },
});

beforeEach(() => {
  useStore.setState(STORE_BASELINE());
  _resetRngForTest(() => 0.5); // deterministic kind selection for objectCount
});

afterEach(() => {
  setSearch('');
});

describe('applyUrlPresets', () => {
  it('is a no-op when the URL is empty', () => {
    setSearch('');
    expect(URL_PRESETS).toEqual({});
    const before = JSON.stringify(useStore.getState().capture);
    applyUrlPresets();
    expect(JSON.stringify(useStore.getState().capture)).toBe(before);
  });

  it('sets envPreset from ?env=', () => {
    setSearch('env=outdoor');
    applyUrlPresets();
    expect(useStore.getState().envPreset).toBe('outdoor');
  });

  it('pre-spawns the listed objects', () => {
    setSearch('objects=cube,sphere,phone');
    applyUrlPresets();
    const kinds = useStore.getState().sceneObjects.map((o) => o.kind);
    expect(kinds).toEqual(['cube', 'sphere', 'phone']);
  });

  it('?objectCount tops up the scene with random kinds after explicit ?objects', () => {
    setSearch('objects=cube&objectCount=4');
    applyUrlPresets();
    expect(useStore.getState().sceneObjects).toHaveLength(4);
    // First one is the explicit kind, rest are seeded-random.
    expect(useStore.getState().sceneObjects[0].kind).toBe('cube');
  });

  it('applies the full capture-settings deep link', () => {
    setSearch(
      'batchCount=50&trajectory=circle&radius=5&height=1.5&fov=60&resolution=1024x768&camera=2,2,2&target=0,0,0&lightIntensity=1.5',
    );
    applyUrlPresets();
    const cap = useStore.getState().capture;
    expect(cap.batchCount).toBe(50);
    expect(cap.cameraTrajectory).toBe('circle');
    expect(cap.trajectoryRadius).toBe(5);
    expect(cap.trajectoryHeight).toBe(1.5);
    expect(cap.fov).toBe(60);
    expect(cap.width).toBe(1024);
    expect(cap.height).toBe(768);
    expect(cap.camPos).toEqual([2, 2, 2]);
    expect(cap.camTarget).toEqual([0, 0, 0]);
    expect(cap.lightIntensity).toBe(1.5);
  });

  it('toggles conveyor + speed', () => {
    setSearch('conveyor=1&conveyorSpeed=0.7');
    applyUrlPresets();
    expect(useStore.getState().showConveyor).toBe(true);
    expect(useStore.getState().conveyorSpeed).toBe(0.7);
  });

  it('sets the EI label + category', () => {
    setSearch('eiLabel=demo&eiCategory=split');
    applyUrlPresets();
    expect(useStore.getState().ei.label).toBe('demo');
    expect(useStore.getState().ei.category).toBe('split');
  });

  it('sets realism mode + intensities', () => {
    setSearch('realism=random&grain=0.7&jpeg=0.2');
    applyUrlPresets();
    const r = useStore.getState().realism;
    expect(r.mode).toBe('random');
    expect(r.grain).toBe(0.7);
    expect(r.jpeg).toBe(0.2);
  });

  it('arm pose + rover event land on the robot config', () => {
    setSearch(
      'armPose=1.57,1.0,0.5,1.57,1.57,0.5&roverEvent=collision',
    );
    applyUrlPresets();
    const robot = useStore.getState().robot;
    expect(robot.armHomePose).toEqual([1.57, 1.0, 0.5, 1.57, 1.57, 0.5]);
    expect(robot.roverEvent).toBe('collision');
  });

  it('sets the motion-mode sample rate', () => {
    setSearch('sampleRate=200');
    applyUrlPresets();
    expect(useStore.getState().sampleRateHz).toBe(200);
  });

  it('mode + robot deep-links switch modes once at startup', () => {
    setSearch('mode=arm');
    applyUrlPresets();
    expect(useStore.getState().mode).toBe('robot');
    expect(useStore.getState().robot.kind).toBe('arm');
  });

  it('?onlyMode= snaps the active mode into the allowed set', () => {
    useStore.setState({ mode: 'motion' });
    setSearch('onlyMode=detection');
    applyUrlPresets();
    // Active mode was `motion` — not in the allowed list — so we snap
    // to the first allowed mode.
    expect(useStore.getState().mode).toBe('detection');
  });

  it('?onlyMode= leaves the active mode alone when it is already allowed', () => {
    useStore.setState({ mode: 'anomaly' });
    setSearch('onlyMode=anomaly,detection');
    applyUrlPresets();
    expect(useStore.getState().mode).toBe('anomaly');
  });
});
