/**
 * Apple-platform detection used to gate the "capture from real life"
 * affordance. Apple's Object Capture pipeline has two halves:
 *
 *   - On-device `ObjectCaptureSession` (iOS 17+, requires LiDAR — iPhone
 *     Pro / iPad Pro). Captures photos and produces a USDZ on the device.
 *   - `PhotogrammetrySession` on macOS 12+ (Monterey+). Takes a folder
 *     of photos and produces a USDZ via a sample app or CLI.
 *
 * We can't see LiDAR or whether the user has an Object Capture-using app
 * installed; we just check OS family / version from the user-agent and
 * leave the rest to the user. The macOS UA was frozen at "10_15_7" with
 * Big Sur, so anything reporting Mac is treated as macOS 12+ candidate.
 */

export type AppleOS = 'iphone' | 'ipad' | 'mac' | 'other';

export type PlatformInfo = {
  os: AppleOS;
  /** iOS major version parsed from UA, or null on non-iOS. */
  iosMajor: number | null;
  /** macOS major as best we can determine (UA is unreliable post-Big Sur). */
  macosMajor: number | null;
  /** iOS 17+ on iPhone or iPad — eligible for on-device Object Capture
   * (assuming a LiDAR-capable Pro device, which we can't probe from JS). */
  supportsObjectCaptureMobile: boolean;
  /** macOS 12+ — eligible for PhotogrammetrySession. */
  supportsObjectCaptureMac: boolean;
  /** True for iPhone or iPad. */
  isMobile: boolean;
};

export function detectPlatform(
  ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  maxTouchPoints: number = typeof navigator !== 'undefined'
    ? (navigator.maxTouchPoints ?? 0)
    : 0,
): PlatformInfo {
  const isIPhone = /iPhone|iPod/.test(ua);
  // iPadOS 13+ reports as "Macintosh" — disambiguate via touch points.
  const isIPad =
    /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
  const isMac = /Macintosh/.test(ua) && !isIPad;

  let iosMajor: number | null = null;
  if (isIPhone || isIPad) {
    const m = ua.match(/OS (\d+)[_\.](\d+)/);
    if (m) iosMajor = parseInt(m[1], 10);
  }

  let macosMajor: number | null = null;
  if (isMac) {
    // UA freezes at "Mac OS X 10_15_7" on macOS 11+; treat 10_15+ as a
    // proxy for "modern enough" (≥ 12 in practice for any current user).
    const m = ua.match(/Mac OS X (\d+)[_\.](\d+)/);
    if (m) {
      const major = parseInt(m[1], 10);
      const minor = parseInt(m[2], 10);
      macosMajor = major === 10 && minor >= 15 ? 12 : major;
    } else {
      macosMajor = 12;
    }
  }

  let os: AppleOS = 'other';
  if (isIPhone) os = 'iphone';
  else if (isIPad) os = 'ipad';
  else if (isMac) os = 'mac';

  const isMobile = os === 'iphone' || os === 'ipad';

  return {
    os,
    iosMajor,
    macosMajor,
    supportsObjectCaptureMobile: isMobile && (iosMajor ?? 0) >= 17,
    supportsObjectCaptureMac: os === 'mac' && (macosMajor ?? 0) >= 12,
    isMobile,
  };
}
