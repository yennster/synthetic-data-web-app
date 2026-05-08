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

const search = window.location.search;
applyApiKeyFromUrl(search, (apiKey) =>
  useStore.getState().setEi({ apiKey }),
);
applyEiCategoryFromUrl(search, (category) =>
  useStore.getState().setEi({ category }),
);
applyThemeFromUrl(search, setTheme);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

initPostContentHeight({
  log: (height) => console.log('posting', height),
});
