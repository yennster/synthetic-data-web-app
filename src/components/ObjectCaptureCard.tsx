import { useMemo, useState } from 'react';
import { detectPlatform, type PlatformInfo } from '../lib/platform';

/**
 * Apple's RealityKit Object Capture turns a fan of photos of a real-world
 * object into a textured USDZ. There's no JavaScript surface for it: it
 * runs on-device on iPhone/iPad (iOS 17+, LiDAR) or on Mac via
 * `PhotogrammetrySession` (macOS 12+). So this card's job is just to
 * point users at the right native pipeline; they re-import the resulting
 * USDZ via the import card below.
 */

// RealityScan (Epic Games) is free and built on Apple's Object Capture
// API on iOS 17+. We point users there rather than to a developer sample
// that has to be built from Xcode.
const REALITY_SCAN_APPSTORE_URL =
  'https://apps.apple.com/us/app/realityscan-mobile/id1584832280';
const APPLE_DOC_URL =
  'https://developer.apple.com/documentation/realitykit/realitykit-object-capture';
const HELLO_PHOTOGRAMMETRY_URL =
  'https://developer.apple.com/documentation/realitykit/creating-a-photogrammetry-command-line-app';

export function ObjectCaptureCard() {
  const platform: PlatformInfo = useMemo(() => detectPlatform(), []);
  const [open, setOpen] = useState(false);

  return (
    <div className="card">
      <h3>Capture from real life</h3>

      <p style={{ margin: 0, color: 'var(--muted)', fontSize: 12, lineHeight: 1.4 }}>
        Use Apple's{' '}
        <a href={APPLE_DOC_URL} target="_blank" rel="noreferrer">
          Object Capture
        </a>{' '}
        to turn real-world photos of an object into a USDZ, then drop it
        into the import box above.
      </p>

      <PlatformBadge platform={platform} />

      <button
        type="button"
        onClick={() => setOpen((b) => !b)}
        aria-expanded={open}
        style={{ alignSelf: 'center' }}
      >
        {open ? 'Hide instructions ↑' : 'How to capture ↓'}
      </button>

      {open && (
        <>
      <ol
        style={{
          margin: 0,
          paddingLeft: 18,
          fontSize: 12,
          lineHeight: 1.5,
          color: 'var(--muted)',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <li>
          On iPhone (iOS 17+), install{' '}
          <a href={REALITY_SCAN_APPSTORE_URL} target="_blank" rel="noreferrer">
            RealityScan
          </a>{' '}
          (Epic Games) — it's free and built on Object Capture.
        </li>
        <li>
          Walk around the object taking ~50–200 overlapping photos. Even
          lighting, no shiny / transparent surfaces.
        </li>
        <li>
          Export as <code>USDZ</code>.{' '}
          {platform.isMobile
            ? 'Tap the import box above to bring it into the studio.'
            : 'AirDrop the file to this machine, then drop it into the import box above.'}
        </li>
      </ol>

      {platform.supportsObjectCaptureMac && (
        <p style={{ margin: 0, fontSize: 11, color: 'var(--muted)' }}>
          On Mac you can also run Apple's{' '}
          <a href={HELLO_PHOTOGRAMMETRY_URL} target="_blank" rel="noreferrer">
            <code>HelloPhotogrammetry</code>
          </a>{' '}
          CLI on a folder of photos to produce a USDZ headlessly.
        </p>
      )}
        </>
      )}
    </div>
  );
}

function PlatformBadge({ platform }: { platform: PlatformInfo }) {
  const supported =
    platform.supportsObjectCaptureMobile || platform.supportsObjectCaptureMac;
  return (
    <div
      style={{
        fontSize: 11,
        color: supported ? '#34d399' : 'var(--muted)',
        marginTop: -4,
      }}
    >
      {supported ? '✓' : 'ℹ'} {describePlatform(platform)}
    </div>
  );
}

function describePlatform(p: PlatformInfo): string {
  if (p.supportsObjectCaptureMobile) {
    return `Detected ${p.os === 'ipad' ? 'iPad' : 'iPhone'} on iOS ${p.iosMajor}+ — capture on this device.`;
  }
  if (p.supportsObjectCaptureMac) {
    return 'Detected Mac — Object Capture works here, or capture on iPhone and AirDrop the USDZ over.';
  }
  if (p.isMobile && (p.iosMajor ?? 0) > 0) {
    return `Detected iOS ${p.iosMajor} — Object Capture needs iOS 17 or newer.`;
  }
  return 'Object Capture requires iOS 17+ (iPhone/iPad Pro) or macOS 12+.';
}
