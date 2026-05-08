import { useEffect, useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'sds-theme';

function readStored(): Theme {
  if (typeof window === 'undefined') return 'dark';
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

const listeners = new Set<() => void>();
let current: Theme = readStored();

function emit() {
  for (const l of listeners) l();
}

function apply(theme: Theme) {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme;
  }
}

export function setTheme(theme: Theme) {
  current = theme;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // ignore — private mode / quota
  }
  apply(theme);
  emit();
}

export function toggleTheme() {
  setTheme(current === 'dark' ? 'light' : 'dark');
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): Theme {
  return current;
}

function getServerSnapshot(): Theme {
  return 'dark';
}

/** Reactive theme value. The inline bootstrap script in index.html sets
 * the data-theme attribute before paint; this hook keeps the React tree
 * in sync after hydration and on toggles. */
export function useTheme(): Theme {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // If something else (devtools, a stale tab) clobbered the attribute,
  // restore it on mount so the rendered tree matches the stored value.
  useEffect(() => {
    apply(theme);
  }, [theme]);
  return theme;
}
