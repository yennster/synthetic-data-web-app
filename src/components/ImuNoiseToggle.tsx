import { useStore } from '../store/useStore';
import { ToggleSwitch } from './ToggleSwitch';

/**
 * "Realistic noise" toggle for the IMU sampling pipeline. Reused by
 * every panel that records IMU data — motion mode and robotics mode
 * both expose it so the user can flip between calibration-quality
 * clean traces (matching MuJoCo's analytical sensor output) and
 * LSM6DSO-style noisy traces (matching what a real Arduino-class IMU
 * would emit on hardware).
 */
export function ImuNoiseToggle() {
  const enabled = useStore((s) => s.imuNoise.enabled);
  const setImuNoise = useStore((s) => s.setImuNoise);
  return (
    <ToggleSwitch
      title="Realistic IMU noise"
      help="On: LSM6DSO-style bias drift, scale-factor error, quantization, and range clipping. Off: clean MuJoCo sensor output."
      on={enabled}
      onChange={(next) => setImuNoise({ enabled: next })}
    />
  );
}
