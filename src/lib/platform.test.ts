import { describe, expect, it } from 'vitest';
import { detectPlatform } from './platform';

const IPHONE_17 =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPHONE_16 =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const IPAD_17 =
  'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const IPADOS_AS_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

describe('detectPlatform', () => {
  it('identifies iPhone iOS 17 as Object-Capture eligible', () => {
    const p = detectPlatform(IPHONE_17, 5);
    expect(p.os).toBe('iphone');
    expect(p.iosMajor).toBe(17);
    expect(p.supportsObjectCaptureMobile).toBe(true);
    expect(p.isMobile).toBe(true);
  });

  it('rejects iPhone iOS 16 for the on-device pipeline', () => {
    const p = detectPlatform(IPHONE_16, 5);
    expect(p.os).toBe('iphone');
    expect(p.iosMajor).toBe(16);
    expect(p.supportsObjectCaptureMobile).toBe(false);
  });

  it('identifies iPad iOS 17', () => {
    const p = detectPlatform(IPAD_17, 5);
    expect(p.os).toBe('ipad');
    expect(p.iosMajor).toBe(17);
    expect(p.supportsObjectCaptureMobile).toBe(true);
  });

  it('disambiguates iPadOS-pretending-to-be-Mac via touch points', () => {
    const p = detectPlatform(IPADOS_AS_MAC, 5);
    expect(p.os).toBe('ipad');
    expect(p.isMobile).toBe(true);
  });

  it('treats a desktop Mac UA as macOS-12+ eligible', () => {
    const p = detectPlatform(MAC, 0);
    expect(p.os).toBe('mac');
    expect(p.supportsObjectCaptureMac).toBe(true);
    expect(p.supportsObjectCaptureMobile).toBe(false);
    expect(p.isMobile).toBe(false);
  });

  it('returns "other" for non-Apple platforms with no Object Capture support', () => {
    for (const ua of [WINDOWS, ANDROID]) {
      const p = detectPlatform(ua, 0);
      expect(p.os).toBe('other');
      expect(p.supportsObjectCaptureMac).toBe(false);
      expect(p.supportsObjectCaptureMobile).toBe(false);
    }
  });
});
