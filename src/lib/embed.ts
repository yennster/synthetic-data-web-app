// Helpers for embedding the app in an iframe. Kept in lib/ so they can be
// unit-tested in happy-dom without booting React or pulling in main.tsx.

/** Read `?apiKey=…` from a search string. Returns the trimmed value, or
 * `null` if absent or empty. Pure — takes the search explicitly so it's
 * easy to test. */
export function readApiKeyFromSearch(search: string): string | null {
  const v = new URLSearchParams(search).get('apiKey');
  if (!v) return null;
  const trimmed = v.trim();
  return trimmed ? trimmed : null;
}

/** Apply `?apiKey=…` from the current URL to the EI config via `setApiKey`. */
export function applyApiKeyFromUrl(
  search: string,
  setApiKey: (key: string) => void,
): void {
  const key = readApiKeyFromSearch(search);
  if (key) setApiKey(key);
}

export type IframeHeightMessage = { type: 'IFRAME_HEIGHT'; height: number };

/** Post the current document height to the parent window with the same
 * shape iframe embedders expect. Hoisted so the iframe loop can call it
 * directly and tests can assert on the message payload. */
export function postContentHeight(
  parent: Pick<Window, 'postMessage'>,
  height: number,
): void {
  const msg: IframeHeightMessage = { type: 'IFRAME_HEIGHT', height };
  parent.postMessage(msg, '*');
}

/** Wire up the height-posting loop: post once now, then on `load`,
 * `resize`, and any `document.body` size change. Returns a teardown.
 * Tests can pass spies for `parent`, `win`, and a fake `ResizeObserver`. */
export function initPostContentHeight(opts?: {
  win?: Window;
  parent?: Pick<Window, 'postMessage'>;
  doc?: Document;
  ResizeObserverImpl?: typeof ResizeObserver;
  log?: (height: number) => void;
}): () => void {
  const win = opts?.win ?? window;
  const parent = opts?.parent ?? win.parent;
  const doc = opts?.doc ?? win.document;
  const ROImpl =
    opts?.ResizeObserverImpl ??
    (typeof ResizeObserver !== 'undefined' ? ResizeObserver : undefined);
  const log = opts?.log;

  const post = () => {
    const height = doc.body.scrollHeight;
    log?.(height);
    postContentHeight(parent, height);
  };

  win.addEventListener('load', post);
  win.addEventListener('resize', post);

  const ro = ROImpl ? new ROImpl(() => post()) : null;
  ro?.observe(doc.body);

  post();

  return () => {
    win.removeEventListener('load', post);
    win.removeEventListener('resize', post);
    ro?.disconnect();
  };
}
