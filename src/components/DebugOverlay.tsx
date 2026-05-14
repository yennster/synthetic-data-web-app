import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { URL_FLAGS } from '../lib/urlParams';

/**
 * Tiny debug instrumentation that mounts when `?debug=1`, `?perf=1`, or
 * `?camLog=1` is set:
 *
 *   - `debug` renders an FPS counter pinned to the bottom-left of the
 *     canvas overlay, and adds a 5 m AxesHelper at the world origin.
 *   - `perf` logs per-frame timing (dt + frame number) to console at
 *     1 Hz so the dev tools console doesn't drown.
 *   - `camLog` logs every orbit-camera move (throttled to 4 Hz).
 *
 * No-op when none of the flags are set, so the build cost in production
 * is a single conditional render.
 */
export function DebugOverlay() {
  if (!URL_FLAGS.debug && !URL_FLAGS.perf && !URL_FLAGS.camLog) return null;
  return <DebugBody />;
}

function DebugBody() {
  const { scene, camera } = useThree();
  const [fps, setFps] = useState(0);
  const frameCount = useRef(0);
  const lastFpsTickMs = useRef(performance.now());
  const lastPerfLogMs = useRef(performance.now());
  const lastCamLogMs = useRef(performance.now());
  const lastCamPos = useRef<THREE.Vector3 | null>(null);

  // Axis helper at origin so users can see XYZ orientation.
  useEffect(() => {
    if (!URL_FLAGS.debug) return;
    const helper = new THREE.AxesHelper(5);
    helper.renderOrder = 999;
    scene.add(helper);
    return () => {
      scene.remove(helper);
      helper.dispose();
    };
  }, [scene]);

  // Expose a few internals on `window` for console debugging.
  useEffect(() => {
    if (!URL_FLAGS.debug) return;
    type DebugWindow = Window & {
      __sds_debug?: {
        scene: THREE.Scene;
        camera: THREE.Camera;
      };
    };
    (window as DebugWindow).__sds_debug = { scene, camera };
    return () => {
      delete (window as DebugWindow).__sds_debug;
    };
  }, [scene, camera]);

  useFrame((_state, dt) => {
    const now = performance.now();
    frameCount.current += 1;

    // FPS (1 Hz)
    if (URL_FLAGS.debug && now - lastFpsTickMs.current >= 1000) {
      const elapsedSec = (now - lastFpsTickMs.current) / 1000;
      setFps(Math.round(frameCount.current / elapsedSec));
      frameCount.current = 0;
      lastFpsTickMs.current = now;
    }

    // Perf log (1 Hz)
    if (URL_FLAGS.perf && now - lastPerfLogMs.current >= 1000) {
      lastPerfLogMs.current = now;
      console.debug(`[sds:perf] dt=${(dt * 1000).toFixed(2)}ms`);
    }

    // Camera log (4 Hz, only on actual movement)
    if (URL_FLAGS.camLog && now - lastCamLogMs.current >= 250) {
      const p = camera.position;
      if (
        !lastCamPos.current ||
        lastCamPos.current.distanceToSquared(p) > 1e-6
      ) {
        console.debug(
          `[sds:cam] pos=(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`,
        );
        lastCamPos.current = lastCamPos.current
          ? lastCamPos.current.copy(p)
          : p.clone();
        lastCamLogMs.current = now;
      }
    }
  });

  // We render a DOM overlay via `document.body`-less inline placement:
  // can't use a regular DOM node from inside <Canvas>. Instead, write
  // the FPS to window.__sds_fps and have a DOM sibling read it.
  // Simpler: render through a portal — but to keep this tight, we
  // attach a single floating div via a one-time DOM op.
  useEffect(() => {
    if (!URL_FLAGS.debug) return;
    const div = document.createElement('div');
    div.id = '__sds-fps';
    div.style.cssText =
      'position:fixed;left:8px;bottom:8px;background:rgba(0,0,0,0.6);color:#fff;font:11px monospace;padding:4px 8px;border-radius:4px;pointer-events:none;z-index:9999;';
    div.textContent = 'fps —';
    document.body.appendChild(div);
    return () => {
      document.body.removeChild(div);
    };
  }, []);

  useEffect(() => {
    if (!URL_FLAGS.debug) return;
    const div = document.getElementById('__sds-fps');
    if (div) div.textContent = `fps ${fps}`;
  }, [fps]);

  return null;
}
