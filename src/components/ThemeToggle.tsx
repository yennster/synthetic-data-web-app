import { toggleTheme, useTheme } from '../lib/useTheme';

/** Quiet sun/moon button. Lives in the sidebar header next to the Mode
 * heading; clicking flips between dark and light. The persisted choice
 * is applied before paint via the inline script in index.html.
 *
 * The toggle never modifies the scene environment — env follows the
 * theme only on the very first load (see `applyInitialThemeAndEnv`),
 * after which the user's choice persists across theme switches. */
export function ThemeToggle() {
  const theme = useTheme();
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-pressed={!isDark}
      title={isDark ? 'Light mode' : 'Dark mode'}
      onClick={toggleTheme}
    >
      {isDark ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
