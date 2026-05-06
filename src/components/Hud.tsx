import { useStore } from '../store/useStore';

export function Hud() {
  const { handDetected, pinchStrength, isGrabbed, isRecording, samples } =
    useStore();

  return (
    <div className="hud">
      <div className={`pill ${handDetected ? 'live' : ''}`}>
        Hand: {handDetected ? 'tracked' : '—'}
      </div>
      <div className="pill">Pinch: {(pinchStrength * 100).toFixed(0)}%</div>
      <div className={`pill ${isGrabbed ? 'live' : ''}`}>
        {isGrabbed ? 'Grabbed' : 'Released'}
      </div>
      {isRecording && (
        <div className="pill rec">● REC · {samples.length}</div>
      )}
    </div>
  );
}
