import React from 'react';
import ReactDOM from 'react-dom/client';
import { injectSpeedInsights } from '@vercel/speed-insights';
import App from './App';
import { applyApiKeyFromUrl, initPostContentHeight } from './lib/embed';
import './styles.css';
import { useStore } from './store/useStore';

applyApiKeyFromUrl(window.location.search, (apiKey) =>
  useStore.getState().setEi({ apiKey }),
);

injectSpeedInsights();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

initPostContentHeight({
  log: (height) => console.log('posting', height),
});
