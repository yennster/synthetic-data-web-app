import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'sds-theme';

// useTheme.ts holds module-scoped state (the cached `current` value plus the
// listener set), so tests need a fresh import each time. `vi.resetModules()`
// drops the cache; every `await import(...)` below grabs a clean copy.

describe('useTheme module', () => {
  beforeEach(() => {
    localStorage.clear();
    delete (document.documentElement.dataset as Record<string, string | undefined>).theme;
    vi.resetModules();
  });
  afterEach(() => {
    localStorage.clear();
  });

  describe('readStored / initial value', () => {
    it('defaults to dark when nothing is stored', async () => {
      const m = await import('./useTheme');
      // No public `getCurrent`, but setTheme→toggleTheme reflects the cached value.
      // Toggle from default should land on light.
      m.toggleTheme();
      expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
    });

    it('reads "light" from localStorage on module init', async () => {
      localStorage.setItem(STORAGE_KEY, 'light');
      const m = await import('./useTheme');
      // From light, toggle → dark.
      m.toggleTheme();
      expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
    });

    it('reads "dark" from localStorage on module init', async () => {
      localStorage.setItem(STORAGE_KEY, 'dark');
      const m = await import('./useTheme');
      m.toggleTheme();
      expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
    });

    it('treats unrecognised stored values as dark', async () => {
      localStorage.setItem(STORAGE_KEY, 'sepia' as unknown as string);
      const m = await import('./useTheme');
      m.toggleTheme();
      expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
    });
  });

  describe('setTheme', () => {
    it('persists the theme to localStorage', async () => {
      const m = await import('./useTheme');
      m.setTheme('light');
      expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
      m.setTheme('dark');
      expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
    });

    it('applies the theme to documentElement.dataset.theme', async () => {
      const m = await import('./useTheme');
      m.setTheme('light');
      expect(document.documentElement.dataset.theme).toBe('light');
      m.setTheme('dark');
      expect(document.documentElement.dataset.theme).toBe('dark');
    });

    it('updates the dataset attribute on every call (so subscribers re-render)', async () => {
      const m = await import('./useTheme');
      const seen: string[] = [];
      m.setTheme('light');
      seen.push(document.documentElement.dataset.theme!);
      m.setTheme('dark');
      seen.push(document.documentElement.dataset.theme!);
      m.setTheme('light');
      seen.push(document.documentElement.dataset.theme!);
      expect(seen).toEqual(['light', 'dark', 'light']);
    });

    it('survives a localStorage write that throws (private mode)', async () => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = () => {
        throw new Error('quota');
      };
      try {
        const m = await import('./useTheme');
        // Should not throw.
        expect(() => m.setTheme('light')).not.toThrow();
        // And should still apply to the document.
        expect(document.documentElement.dataset.theme).toBe('light');
      } finally {
        Storage.prototype.setItem = orig;
      }
    });
  });

  describe('toggleTheme', () => {
    it('flips dark→light', async () => {
      localStorage.setItem(STORAGE_KEY, 'dark');
      const m = await import('./useTheme');
      m.toggleTheme();
      expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
      expect(document.documentElement.dataset.theme).toBe('light');
    });

    it('flips light→dark', async () => {
      localStorage.setItem(STORAGE_KEY, 'light');
      const m = await import('./useTheme');
      m.toggleTheme();
      expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
      expect(document.documentElement.dataset.theme).toBe('dark');
    });

    it('is idempotent across an even number of calls', async () => {
      localStorage.setItem(STORAGE_KEY, 'dark');
      const m = await import('./useTheme');
      m.toggleTheme();
      m.toggleTheme();
      m.toggleTheme();
      m.toggleTheme();
      expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
    });
  });
});
