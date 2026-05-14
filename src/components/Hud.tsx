import { useStore } from '../store/useStore';

export function Hud() {
  const mode = useStore((s) => s.mode);
  const handDetected = useStore((s) => s.handDetected);
  const pinchStrength = useStore((s) => s.pinchStrength);
  const isGrabbed = useStore((s) => s.isGrabbed);
  const isRecording = useStore((s) => s.isRecording);
  const samples = useStore((s) => s.samples);
  const captures = useStore((s) => s.captures);
  const robotCaptures = useStore((s) => s.robotCaptures);
  const sceneObjects = useStore((s) => s.sceneObjects);
  const assets = useStore((s) => s.assets);
  const restoring = useStore((s) => s.restoringAssets);

  if (mode === 'motion') {
    return (
      <div className="hud">
        <div className={`pill ${handDetected ? 'live' : ''}`}>
          Hand: {handDetected ? 'tracked' : '—'}
        </div>
        <div className="pill">Pinch: {(pinchStrength * 100).toFixed(0)}%</div>
        <div className={`pill ${isGrabbed ? 'live' : ''}`}>
          {isGrabbed ? 'Grabbed' : 'Released'}
        </div>
        {isRecording && <div className="pill rec">● REC · {samples.length}</div>}
        {restoring.phase === 'busy' && (
          <div className="pill" title="Re-importing USDZ assets saved from a previous session">
            ⟳ Restoring {restoring.done}/{restoring.total}…
          </div>
        )}
        {restoring.phase === 'success' && (
          <div className="pill live" title="USDZ assets restored from saved storage">
            ✓ Success!
          </div>
        )}
      </div>
    );
  }

  const modeLabel =
    mode === 'detection'
      ? 'object detection'
      : mode === 'anomaly'
        ? 'visual anomaly'
        : mode === 'robot'
          ? 'robotics'
          : mode;

  // Robotics mode produces rosbag / timeseries captures via RobotPanel
  // (no image-capture path), so the vision `captures` array stays empty.
  // Surface the robotics-run counter instead so the pill actually updates.
  const captureCount = mode === 'robot' ? robotCaptures : captures.length;

  return (
    <div className="hud">
      <div className="pill">Mode: {modeLabel}</div>
      <div className="pill">Objects: {sceneObjects.length + assets.length}</div>
      <div className={`pill ${captureCount > 0 ? 'live' : ''}`}>
        Captures: {captureCount}
      </div>
      <div
        className="pill tip"
        title="Shift+drag = camera-aligned plane. Hold Alt/Option/Ctrl for depth (cursor up = closer). Click to select, Cmd/Ctrl-click to multi-select, Esc clears. [ / ] rotate the selection (or all objects if none selected). Q/E rotate the camera; arrow keys pan; right-mouse drag also pans."
      >
        Tip: Click select · Cmd-click multi · [ ] rotate · Q/E cam · Shift+drag move
      </div>
      {restoring.phase === 'busy' && (
        <div className="pill" title="Re-importing USDZ assets saved from a previous session">
          ⟳ Restoring {restoring.done}/{restoring.total}…
        </div>
      )}
      {restoring.phase === 'success' && (
        <div className="pill live" title="USDZ assets restored from saved storage">
          ✓ Success!
        </div>
      )}
    </div>
  );
}
