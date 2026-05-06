import { CameraFeed } from './components/CameraFeed';
import { Hud } from './components/Hud';
import { Scene } from './components/Scene';
import { Sidebar } from './components/Sidebar';

export default function App() {
  return (
    <div className="app">
      <div className="scene">
        <Scene />
        <Hud />
        <CameraFeed />
      </div>
      <Sidebar />
    </div>
  );
}
