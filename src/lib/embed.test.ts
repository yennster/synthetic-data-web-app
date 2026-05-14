import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyApiKeyFromUrl,
  applyEiCategoryFromUrl,
  applyThemeFromUrl,
  initPostContentHeight,
  postContentHeight,
  readApiKeyFromSearch,
  readEiCategoryFromSearch,
  readThemeFromSearch,
} from './embed';

describe('readApiKeyFromSearch', () => {
  it('returns the apiKey when present', () => {
    expect(readApiKeyFromSearch('?apiKey=ei_abc123')).toBe('ei_abc123');
  });

  it('returns null when missing', () => {
    expect(readApiKeyFromSearch('')).toBeNull();
    expect(readApiKeyFromSearch('?other=1')).toBeNull();
  });

  it('returns null for empty / whitespace-only values', () => {
    expect(readApiKeyFromSearch('?apiKey=')).toBeNull();
    expect(readApiKeyFromSearch('?apiKey=%20%20')).toBeNull();
  });

  it('decodes URL-encoded values', () => {
    expect(readApiKeyFromSearch('?apiKey=ei%2Babc%3D')).toBe('ei+abc=');
  });

  it('picks the first apiKey when duplicated', () => {
    expect(readApiKeyFromSearch('?apiKey=first&apiKey=second')).toBe('first');
  });
});

describe('applyApiKeyFromUrl', () => {
  it('calls the setter with the parsed key', () => {
    const setApiKey = vi.fn();
    applyApiKeyFromUrl('?apiKey=ei_xyz', setApiKey);
    expect(setApiKey).toHaveBeenCalledExactlyOnceWith('ei_xyz');
  });

  it('does not call the setter when no apiKey is present', () => {
    const setApiKey = vi.fn();
    applyApiKeyFromUrl('?other=1', setApiKey);
    expect(setApiKey).not.toHaveBeenCalled();
  });
});

describe('readThemeFromSearch', () => {
  it('returns "dark" or "light" when explicitly set', () => {
    expect(readThemeFromSearch('?theme=dark')).toBe('dark');
    expect(readThemeFromSearch('?theme=light')).toBe('light');
  });

  it('is case-insensitive', () => {
    expect(readThemeFromSearch('?theme=DARK')).toBe('dark');
    expect(readThemeFromSearch('?theme=Light')).toBe('light');
  });

  it('trims surrounding whitespace', () => {
    expect(readThemeFromSearch('?theme=%20light%20')).toBe('light');
  });

  it('returns null for missing or empty values', () => {
    expect(readThemeFromSearch('')).toBeNull();
    expect(readThemeFromSearch('?other=1')).toBeNull();
    expect(readThemeFromSearch('?theme=')).toBeNull();
  });

  it('returns null for unknown values (rather than guessing)', () => {
    expect(readThemeFromSearch('?theme=sepia')).toBeNull();
    expect(readThemeFromSearch('?theme=auto')).toBeNull();
  });
});

describe('applyThemeFromUrl', () => {
  it('calls the setter with the parsed theme', () => {
    const setTheme = vi.fn();
    applyThemeFromUrl('?theme=light', setTheme);
    expect(setTheme).toHaveBeenCalledExactlyOnceWith('light');
  });

  it('does not call the setter when the param is absent or invalid', () => {
    const setTheme = vi.fn();
    applyThemeFromUrl('?other=1', setTheme);
    applyThemeFromUrl('?theme=sepia', setTheme);
    expect(setTheme).not.toHaveBeenCalled();
  });
});

describe('readEiCategoryFromSearch', () => {
  it('returns the canonical bucket for each accepted value', () => {
    expect(readEiCategoryFromSearch('?category=training')).toBe('training');
    expect(readEiCategoryFromSearch('?category=testing')).toBe('testing');
    expect(readEiCategoryFromSearch('?category=split')).toBe('split');
  });

  it('accepts the short aliases "train" and "test"', () => {
    expect(readEiCategoryFromSearch('?category=train')).toBe('training');
    expect(readEiCategoryFromSearch('?category=test')).toBe('testing');
  });

  it('is case-insensitive', () => {
    expect(readEiCategoryFromSearch('?category=TRAINING')).toBe('training');
    expect(readEiCategoryFromSearch('?category=Split')).toBe('split');
  });

  it('returns null for missing, empty, or unknown values', () => {
    expect(readEiCategoryFromSearch('')).toBeNull();
    expect(readEiCategoryFromSearch('?other=1')).toBeNull();
    expect(readEiCategoryFromSearch('?category=')).toBeNull();
    expect(readEiCategoryFromSearch('?category=validation')).toBeNull();
  });
});

describe('applyEiCategoryFromUrl', () => {
  it('calls the setter with the parsed category', () => {
    const setCategory = vi.fn();
    applyEiCategoryFromUrl('?category=testing', setCategory);
    expect(setCategory).toHaveBeenCalledExactlyOnceWith('testing');
  });

  it('normalizes "train" → "training"', () => {
    const setCategory = vi.fn();
    applyEiCategoryFromUrl('?category=train', setCategory);
    expect(setCategory).toHaveBeenCalledExactlyOnceWith('training');
  });

  it('does not call the setter when the param is absent or invalid', () => {
    const setCategory = vi.fn();
    applyEiCategoryFromUrl('?other=1', setCategory);
    applyEiCategoryFromUrl('?category=garbage', setCategory);
    expect(setCategory).not.toHaveBeenCalled();
  });
});

describe('postContentHeight', () => {
  it('posts an IFRAME_HEIGHT message to the parent with the given target origin', () => {
    const parent = { postMessage: vi.fn() };
    postContentHeight(parent, 812, 'https://embed.example.com');
    expect(parent.postMessage).toHaveBeenCalledExactlyOnceWith(
      { type: 'IFRAME_HEIGHT', height: 812 },
      'https://embed.example.com',
    );
  });
});

describe('initPostContentHeight', () => {
  /** Build a minimal fake window/doc/parent and a controllable
   * ResizeObserver so we can assert on emitted height messages without
   * touching the global window in test order. */
  function makeHarness(initialHeight: number) {
    const listeners = new Map<string, Set<EventListener>>();
    const fakeBody = { scrollHeight: initialHeight };
    const doc = { body: fakeBody } as unknown as Document;
    const parent = { postMessage: vi.fn() };

    let roCallback: (() => void) | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn(() => {
      roCallback = null;
    });
    class FakeRO {
      constructor(cb: () => void) {
        roCallback = cb;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
    }

    const win = {
      addEventListener: (type: string, cb: EventListener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(cb);
      },
      removeEventListener: (type: string, cb: EventListener) => {
        listeners.get(type)?.delete(cb);
      },
    } as unknown as Window;
    const ResizeObserverImpl = FakeRO as unknown as typeof ResizeObserver;

    function fire(type: string) {
      listeners.get(type)?.forEach((cb) => cb(new Event(type)));
    }
    function triggerResizeObserver() {
      roCallback?.();
    }
    function setHeight(h: number) {
      fakeBody.scrollHeight = h;
    }

    return {
      win,
      doc,
      parent,
      ResizeObserverImpl,
      fire,
      triggerResizeObserver,
      setHeight,
      observe,
      disconnect,
    };
  }

  it('posts the initial height immediately to the supplied target origin', () => {
    const h = makeHarness(500);
    initPostContentHeight({
      win: h.win,
      parent: h.parent,
      doc: h.doc,
      ResizeObserverImpl: h.ResizeObserverImpl,
      targetOrigin: 'https://embed.example.com',
    });
    expect(h.parent.postMessage).toHaveBeenCalledExactlyOnceWith(
      { type: 'IFRAME_HEIGHT', height: 500 },
      'https://embed.example.com',
    );
  });

  it('observes document.body with a ResizeObserver', () => {
    const h = makeHarness(400);
    initPostContentHeight({
      win: h.win,
      parent: h.parent,
      doc: h.doc,
      ResizeObserverImpl: h.ResizeObserverImpl,
      targetOrigin: 'https://embed.example.com',
    });
    expect(h.observe).toHaveBeenCalledExactlyOnceWith(h.doc.body);
  });

  it('posts again on load, resize, and ResizeObserver ticks', () => {
    const h = makeHarness(100);
    initPostContentHeight({
      win: h.win,
      parent: h.parent,
      doc: h.doc,
      ResizeObserverImpl: h.ResizeObserverImpl,
      targetOrigin: 'https://embed.example.com',
    });
    h.parent.postMessage.mockClear();

    h.setHeight(200);
    h.fire('load');
    h.setHeight(300);
    h.fire('resize');
    h.setHeight(400);
    h.triggerResizeObserver();

    expect(h.parent.postMessage.mock.calls.map((c) => c[0])).toEqual([
      { type: 'IFRAME_HEIGHT', height: 200 },
      { type: 'IFRAME_HEIGHT', height: 300 },
      { type: 'IFRAME_HEIGHT', height: 400 },
    ]);
  });

  it('teardown unsubscribes listeners and disconnects the observer', () => {
    const h = makeHarness(100);
    const teardown = initPostContentHeight({
      win: h.win,
      parent: h.parent,
      doc: h.doc,
      ResizeObserverImpl: h.ResizeObserverImpl,
      targetOrigin: 'https://embed.example.com',
    });
    h.parent.postMessage.mockClear();

    teardown();
    h.fire('load');
    h.fire('resize');
    h.triggerResizeObserver();

    expect(h.disconnect).toHaveBeenCalled();
    expect(h.parent.postMessage).not.toHaveBeenCalled();
  });

  it('invokes the optional log callback for each post', () => {
    const h = makeHarness(123);
    const log = vi.fn();
    initPostContentHeight({
      win: h.win,
      parent: h.parent,
      doc: h.doc,
      ResizeObserverImpl: h.ResizeObserverImpl,
      targetOrigin: 'https://embed.example.com',
      log,
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(123);
  });

  it('is a no-op when no target origin can be resolved', () => {
    const h = makeHarness(500);
    // No targetOrigin, no referrer-bearing win — should refuse to post
    // rather than fall back to '*'.
    initPostContentHeight({
      win: h.win,
      parent: h.parent,
      doc: h.doc,
      ResizeObserverImpl: h.ResizeObserverImpl,
    });
    expect(h.parent.postMessage).not.toHaveBeenCalled();
  });
});

describe('embed integration in happy-dom', () => {
  /** Smoke test against the real happy-dom window: confirms the helper
   * still wires up to globals correctly without our test fakes. */
  let teardown: (() => void) | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div style="height: 600px"></div>';
  });

  afterEach(() => {
    teardown?.();
    teardown = null;
  });

  it('posts to window.parent on init when given an explicit target origin', () => {
    const post = vi.spyOn(window.parent, 'postMessage');
    // happy-dom enforces real postMessage targetOrigin matching, so we
    // address the parent's actual origin here (a hostile cross-origin
    // target would be rejected — which is exactly the property we want).
    const target = window.location.origin;
    teardown = initPostContentHeight({ targetOrigin: target });
    expect(post).toHaveBeenCalled();
    const [msg, origin] = post.mock.calls[0];
    expect(msg).toMatchObject({ type: 'IFRAME_HEIGHT' });
    expect(origin).toBe(target);
  });
});
