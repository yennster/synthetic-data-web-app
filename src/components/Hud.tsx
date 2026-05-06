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

  return (
    <div className="hud">
      <div className="pill">Mode: {mode}</div>
      <div className="pill">Objects: {sceneObjects.length}</div>
      <div className={`pill ${captures.length > 0 ? 'live' : ''}`}>
        Captures: {captures.length}
      </div>
      <div
        className="pill"
        style={{ background: 'rgba(20,24,29,0.6)', fontSize: 10 }}
        title="Hold Shift and drag with the mouse to reposition objects on the floor / belt"
      >
        Tip: Shift+drag to move
      </div>
    </div>
  );
}
