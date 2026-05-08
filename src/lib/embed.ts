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

export type ThemeParam = 'dark' | 'light';

/** Read `?theme=dark|light` from a search string. Case-insensitive; any
 * other value (or absence) returns `null` so the caller can fall back to
 * the persisted preference. */
export function readThemeFromSearch(search: string): ThemeParam | null {
  const v = new URLSearchParams(search).get('theme');
  if (!v) return null;
  const lower = v.trim().toLowerCase();
  if (lower === 'dark' || lower === 'light') return lower;
  return null;
}

/** Apply `?theme=…` from the current URL via `setTheme`. The setter is
 * passed in so this stays usable outside the React tree (e.g. in the
 * pre-paint bootstrap path). */
export function applyThemeFromUrl(
  search: string,
  setTheme: (theme: ThemeParam) => void,
): void {
  const theme = readThemeFromSearch(search);
  if (theme) setTheme(theme);
}

export type EiCategory = 'training' | 'testing' | 'split';

/** Read `?category=training|testing|split` from a search string. Other
 * values return `null`. Aliases: `train` → training, `test` → testing,
 * since those are the words people usually type. */
export function readEiCategoryFromSearch(search: string): EiCategory | null {
  const v = new URLSearchParams(search).get('category');
  if (!v) return null;
  const lower = v.trim().toLowerCase();
  if (lower === 'training' || lower === 'train') return 'training';
  if (lower === 'testing' || lower === 'test') return 'testing';
  if (lower === 'split') return 'split';
  return null;
}

/** Apply `?category=…` from the current URL to the EI config. */
export function applyEiCategoryFromUrl(
  search: string,
  setCategory: (category: EiCategory) => void,
): void {
  const cat = readEiCategoryFromSearch(search);
  if (cat) setCategory(cat);
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
