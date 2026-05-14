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

/** Post the current document height to the parent window. Caller is
 * responsible for supplying a concrete `targetOrigin` — broadcasting to
 * `'*'` leaks the message (and any future payload extension) to every
 * cross-origin frame that happens to receive it. We refuse to use `'*'`
 * unless explicitly asked. Hoisted so the iframe loop can call it
 * directly and tests can assert on the message payload. */
export function postContentHeight(
  parent: Pick<Window, 'postMessage'>,
  height: number,
  targetOrigin: string,
): void {
  const msg: IframeHeightMessage = { type: 'IFRAME_HEIGHT', height };
  parent.postMessage(msg, targetOrigin);
}

/** Derive the parent-frame origin the height pings should be addressed
 * to. Priority:
 *   1. Explicit `?embedOrigin=` URL param (lets multi-tenant embedders
 *      lock the channel without modifying the page).
 *   2. `document.referrer`, parsed for its origin — the standard way
 *      a top-level frame reveals itself to an iframe.
 * Falls back to `null` (caller decides whether to skip or use `'*'`). */
export function resolveEmbedTargetOrigin(win?: Window): string | null {
  const w = win ?? (typeof window !== 'undefined' ? window : undefined);
  if (!w) return null;
  try {
    const explicit = new URLSearchParams(w.location.search).get('embedOrigin');
    if (explicit) {
      const u = new URL(explicit);
      return `${u.protocol}//${u.host}`;
    }
  } catch {
    // fall through
  }
  try {
    const ref = w.document?.referrer;
    if (ref) {
      const u = new URL(ref);
      return `${u.protocol}//${u.host}`;
    }
  } catch {
    // fall through
  }
  return null;
}

/** Wire up the height-posting loop: post once now, then on `load`,
 * `resize`, and any `document.body` size change. Returns a teardown.
 * Tests can pass spies for `parent`, `win`, and a fake `ResizeObserver`.
 *
 * `targetOrigin` defaults to the resolved parent origin (see
 * `resolveEmbedTargetOrigin`); pass `'*'` only if you've considered the
 * cross-origin information disclosure and decided it's fine.
 *
 * When the target origin cannot be determined and the caller didn't
 * pass one, this function becomes a no-op (no posts) so we never
 * accidentally broadcast. */
export function initPostContentHeight(opts?: {
  win?: Window;
  parent?: Pick<Window, 'postMessage'>;
  doc?: Document;
  ResizeObserverImpl?: typeof ResizeObserver;
  log?: (height: number) => void;
  targetOrigin?: string;
}): () => void {
  const win = opts?.win ?? window;
  const parent = opts?.parent ?? win.parent;
  const doc = opts?.doc ?? win.document;
  const ROImpl =
    opts?.ResizeObserverImpl ??
    (typeof ResizeObserver !== 'undefined' ? ResizeObserver : undefined);
  const log = opts?.log;
  const targetOrigin = opts?.targetOrigin ?? resolveEmbedTargetOrigin(win);

  const post = () => {
    if (!targetOrigin) return;
    const height = doc.body.scrollHeight;
    log?.(height);
    postContentHeight(parent, height, targetOrigin);
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
