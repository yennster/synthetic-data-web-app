import { useStore } from '../store/useStore';

export function Hud() {
  const mode = useStore((s) => s.mode);
  const handDetected = useStore((s) => s.handDetected);
  const pinchStrength = useStore((s) => s.pinchStrength);
  const isGrabbed = useStore((s) => s.isGrabbed);
  const isRecording = useStore((s) => s.isRecording);
  const samples = useStore((s) => s.samples);
  const captures = useStore((s) => s.captures);
  const sceneObjects = useStore((s) => s.sceneObjects);
  const assets = useStore((s) => s.assets);

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
      </div>
    );
  }

  const modeLabel =
    mode === 'detection'
      ? 'object detection'
      : mode === 'anomaly'
        ? 'visual anomaly'
        : mode;

  return (
    <div className="hud">
      <div className="pill">Mode: {modeLabel}</div>
      <div className="pill">Objects: {sceneObjects.length + assets.length}</div>
      <div className={`pill ${captures.length > 0 ? 'live' : ''}`}>
        Captures: {captures.length}
      </div>
      <div
        className="pill"
        style={{ background: 'rgba(20,24,29,0.6)', fontSize: 10 }}
        title="Shift+drag = camera-aligned plane. Press/release Alt/Option/Ctrl/Cmd mid-drag to switch into depth mode — vertical cursor motion brings the object closer (up) or farther (down). Mouse wheel during drag does the same depth motion."
      >
        Tip: Shift+drag · Hold Alt/Option/Ctrl for depth
      </div>
    </div>
  );
}
