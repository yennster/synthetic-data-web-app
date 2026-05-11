import { describe, expect, it } from 'vitest';
import {
  awaitRobotCapture,
  hasPendingRobotCapture,
  resolveRobotCapture,
  type RobotCaptureResult,
} from './robotCapture';

const fakeBlob = () => new Blob(['fake'], { type: 'image/png' });

const fakeResult = (): RobotCaptureResult => ({
  blob: fakeBlob(),
  boxes: [
    { label: 'obstacle', x: 1, y: 2, width: 3, height: 4 },
  ],
  width: 640,
  height: 480,
});

describe('robotCapture promise bridge', () => {
  it('starts with no pending resolver', () => {
    // Drain anything a previous test may have left behind so the
    // state under test is well-defined.
    resolveRobotCapture(null);
    expect(hasPendingRobotCapture()).toBe(false);
  });

  it('registers a pending resolver while awaiting', () => {
    resolveRobotCapture(null);
    const p = awaitRobotCapture();
    expect(hasPendingRobotCapture()).toBe(true);
    // Tidy up.
    resolveRobotCapture(null);
    return p;
  });

  it('resolves the awaiter with the supplied capture result', async () => {
    const promise = awaitRobotCapture();
    const result = fakeResult();
    resolveRobotCapture(result);
    const got = await promise;
    expect(got).toBe(result);
    expect(hasPendingRobotCapture()).toBe(false);
  });

  it('resolves the awaiter with null on failure path', async () => {
    const promise = awaitRobotCapture();
    resolveRobotCapture(null);
    expect(await promise).toBeNull();
  });

  it('cancels a previous in-flight capture when a new one is awaited', async () => {
    // First awaiter is queued but never resolved by the bridge.
    const first = awaitRobotCapture();
    // Second awaiter is queued — should resolve the first with null
    // so the previous caller doesn't hang forever, then start its own
    // wait.
    const second = awaitRobotCapture();
    expect(await first).toBeNull();
    // The new resolver is still pending.
    expect(hasPendingRobotCapture()).toBe(true);
    const result = fakeResult();
    resolveRobotCapture(result);
    expect(await second).toBe(result);
  });

  it('is a no-op when nothing is pending', () => {
    resolveRobotCapture(null);
    expect(hasPendingRobotCapture()).toBe(false);
    // Should not throw or change state.
    expect(() => resolveRobotCapture(fakeResult())).not.toThrow();
    expect(hasPendingRobotCapture()).toBe(false);
  });
});
