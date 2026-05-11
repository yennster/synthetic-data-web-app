import { useStore } from '../store/useStore';

/**
 * "Realistic noise" toggle for the IMU sampling pipeline. Reused by
 * every panel that records IMU data — motion mode and robotics mode
 * both expose it so the user can flip between calibration-quality
 * clean traces (matching MuJoCo's analytical sensor output) and
 * LSM6DSO-style noisy traces (matching what a real Arduino-class IMU
 * would emit on hardware).
 *
 * Visually mirrors the `webcam-control` / `webcam-switch` pattern
 * the ROS-export and randomize toggles use, so the panels stay
 * consistent without a fresh style block per toggle.
 */
export function ImuNoiseToggle() {
  const enabled = useStore((s) => s.imuNoise.enabled);
  const setImuNoise = useStore((s) => s.setImuNoise);
  return (
    <div className="webcam-control">
      <div className="webcam-control-copy">
        <div className="webcam-control-heading">
          <span className="webcam-control-title">Realistic IMU noise</span>
          <span
            className={`webcam-control-state ${enabled ? 'on' : 'off'}`}
          >
            {enabled ? 'On' : 'Off'}
          </span>
        </div>
        <div className="webcam-control-help">
          When on, samples include LSM6DSO-style bias drift, scale-
          factor errors, ADC quantization, and ±range clipping — so
          synthetic traces match what a real Nano 33 BLE Sense or
          Portenta IMU would produce. Off gives the clean MuJoCo
          sensor output, useful for debugging trajectories.
        </div>
      </div>
      <button
        type="button"
        className={`webcam-switch ${enabled ? 'on' : ''}`}
        role="switch"
        aria-checked={enabled}
        aria-label={
          enabled ? 'Turn realistic IMU noise off' : 'Turn realistic IMU noise on'
        }
        onClick={() => setImuNoise({ enabled: !enabled })}
      >
        <span className="webcam-switch-thumb" />
      </button>
    </div>
  );
}
