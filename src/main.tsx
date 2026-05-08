import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { useStore } from './store/useStore';

function applyApiKeyFromUrl() {
  const apiKey = new URLSearchParams(window.location.search).get('apiKey');
  if (apiKey) useStore.getState().setEi({ apiKey });
}

function initPostContentHeight() {
  function postHeight() {
    const height = document.body.scrollHeight;
    console.log('posting', height);
    window.parent.postMessage({ type: 'IFRAME_HEIGHT', height }, '*');
  }

  window.addEventListener('load', postHeight);
  window.addEventListener('resize', postHeight);

  const ro = new ResizeObserver(() => postHeight());
  ro.observe(document.body);

  postHeight();
}

applyApiKeyFromUrl();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

initPostContentHeight();
