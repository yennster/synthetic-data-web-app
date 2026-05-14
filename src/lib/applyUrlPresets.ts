/**
 * Apply parsed URL presets to the zustand store. Called from `main.tsx`
 * after the store has been imported (so the persist rehydrate has run)
 * but before React mounts, so the user sees the deep-linked state
 * immediately rather than briefly flashing the persisted defaults.
 *
 * Each preset is best-effort: missing fields are skipped, invalid
 * values were already filtered out by `parseUrlParams`. Unknown object
 * kinds in `?objects=` are silently dropped earlier in the pipeline.
 */

import { rng } from './rng';
import { URL_PRESETS } from './urlParams';
import { useStore, type ObjectKind } from '../store/useStore';

export function applyUrlPresets(): void {
  const p = URL_PRESETS;
  if (Object.keys(p).length === 0) return;
  const state = useStore.getState();

  // Theme handled at index.html level pre-paint; nothing to do here.

  // ---------- Mode ----------
  if (p.mode && p.mode !== state.mode) {
    state.setMode(p.mode);
  }
  if (p.robotKind) {
    state.setRobot({ kind: p.robotKind });
  }

  // ---------- Scene ----------
  if (p.env) state.setEnvPreset(p.env);
  if (p.conveyor !== undefined) state.setShowConveyor(p.conveyor);
  if (p.conveyorSpeed !== undefined) state.setConveyorSpeed(p.conveyorSpeed);

  // Pre-spawn primitives. `?objects=` populates explicit kinds first,
  // then `?objectCount=N` tops up with random kinds so the two compose
  // (e.g. `?objects=phone&objectCount=10` gives one phone + 9 randoms).
  const explicitKinds = p.objects ?? [];
  for (const kind of explicitKinds) {
    state.addSceneObject(kind);
  }
  if (p.objectCount !== undefined && p.objectCount > 0) {
    const remaining = Math.max(0, p.objectCount - explicitKinds.length);
    const KINDS: ObjectKind[] = [
      'cube',
      'sphere',
      'phone',
      'capsule',
      'cylinder',
      'torus',
      'soda_can',
    ];
    for (let i = 0; i < remaining; i++) {
      const kind = KINDS[Math.floor(rng() * KINDS.length)] ?? 'cube';
      state.addSceneObject(kind);
    }
  }

  // ---------- Capture settings ----------
  const capturePatch: Partial<Parameters<typeof state.setCapture>[0]> = {};
  if (p.batchCount !== undefined) capturePatch.batchCount = p.batchCount;
  if (p.trajectory) capturePatch.cameraTrajectory = p.trajectory;
  if (p.trajectoryRadius !== undefined) {
    capturePatch.trajectoryRadius = p.trajectoryRadius;
  }
  if (p.trajectoryHeight !== undefined) {
    capturePatch.trajectoryHeight = p.trajectoryHeight;
  }
  if (p.fov !== undefined) capturePatch.fov = p.fov;
  if (p.resolution) {
    capturePatch.width = p.resolution.width;
    capturePatch.height = p.resolution.height;
  }
  if (p.camPos) capturePatch.camPos = p.camPos;
  if (p.camTarget) capturePatch.camTarget = p.camTarget;
  if (p.lightIntensity !== undefined) {
    capturePatch.lightIntensity = p.lightIntensity;
  }
  if (Object.keys(capturePatch).length > 0) state.setCapture(capturePatch);

  // ---------- Edge Impulse ----------
  const eiPatch: Partial<Parameters<typeof state.setEi>[0]> = {};
  if (p.eiLabel) eiPatch.label = p.eiLabel;
  if (p.eiCategory) eiPatch.category = p.eiCategory;
  if (Object.keys(eiPatch).length > 0) state.setEi(eiPatch);
  // `?eiProject` isn't currently a store field — exposed via
  // `URL_PRESETS.eiProject` for components (e.g. retrain) that need it.

  // ---------- Realism ----------
  if (p.realismMode || p.realism) {
    const realismPatch: Partial<Parameters<typeof state.setRealism>[0]> = {};
    if (p.realismMode) realismPatch.mode = p.realismMode;
    if (p.realism) Object.assign(realismPatch, p.realism);
    state.setRealism(realismPatch);
  }

  // ---------- Motion mode ----------
  if (p.sampleRate !== undefined) state.setSampleRateHz(p.sampleRate);

  // ---------- Robotics ----------
  const robotPatch: Partial<Parameters<typeof state.setRobot>[0]> = {};
  if (p.armPose) robotPatch.armHomePose = p.armPose;
  if (p.roverEvent) robotPatch.roverEvent = p.roverEvent;
  if (Object.keys(robotPatch).length > 0) state.setRobot(robotPatch);
}
