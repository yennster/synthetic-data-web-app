import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import {
  applyApiKeyFromUrl,
  applyEiCategoryFromUrl,
  applyThemeFromUrl,
  initPostContentHeight,
} from './lib/embed';
import './styles.css';
import { useStore } from './store/useStore';
import { setTheme } from './lib/useTheme';
import { applyUrlPresets } from './lib/applyUrlPresets';

const search = window.location.search;
// Legacy single-param helpers (kept for back-compat with existing embed
// docs). `applyUrlPresets` below additionally handles the full
// docs/url-parameters.md surface.
applyApiKeyFromUrl(search, (apiKey) =>
  useStore.getState().setEi({ apiKey }),
);
applyEiCategoryFromUrl(search, (category) =>
  useStore.getState().setEi({ category }),
);
applyThemeFromUrl(search, setTheme);

// New centralised preset application: env, objects, batch, EI label,
// realism, robotics, motion sample rate, camera pose, … All
// idempotent and best-effort — invalid values were dropped during
// parsing.
applyUrlPresets();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

initPostContentHeight();
