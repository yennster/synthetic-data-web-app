import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { detectPlatform, type PlatformInfo } from '../lib/platform';

/**
 * Apple's RealityKit Object Capture turns a fan of photos of a real-world
 * object into a textured USDZ. There's no JavaScript surface for it: it
 * runs on-device on iPhone/iPad (iOS 17+, LiDAR) or on Mac via
 * `PhotogrammetrySession` (macOS 12+). So this card's job is to *route*
 * the user to the right native pipeline and let them re-import the
 * resulting USDZ via the existing import flow above.
 *
 * UX:
 *   - Desktop (or any non-iOS device): show a QR code that opens this
 *     same studio URL on their iPhone, plus an App Store link to a
 *     consumer Object Capture app (RealityScan).
 *   - iPhone/iPad on iOS 17+: skip the QR (they're already on the right
 *     device) and just show the app link + flow.
 *   - Older iOS / Android / nothing-detected: a brief explanation of the
 *     requirement, no QR code.
 */

// RealityScan (Epic Games) is free and built on Apple's Object Capture
// API on iOS 17+. We point users there rather than to a developer sample
// that has to be built from Xcode.
const REALITY_SCAN_APPSTORE_URL =
  'https://apps.apple.com/us/app/realityscan-3d-scan-by-capture/id1620511527';
const APPLE_DOC_URL =
  'https://developer.apple.com/documentation/realitykit/realitykit-object-capture';

function getStudioUrl(): string {
  if (typeof window === 'undefined') return '';
  const u = new URL(window.location.href);
  // Strip noisy query/hash so the QR-encoded URL stays compact (smaller =
  // easier to scan from a phone camera at arm's length).
  u.search = '';
  u.hash = '';
  u.searchParams.set('capture', '1');
  return u.toString();
}

export function ObjectCaptureCard() {
  const platform: PlatformInfo = useMemo(() => detectPlatform(), []);
  const [open, setOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const studioUrl = useMemo(() => getStudioUrl(), []);

  // Render the QR lazily — only when the user opens the panel — so we
  // don't pay the encoder cost on the cold path. Using toDataURL (PNG)
  // rather than inline SVG so we can size it predictably with an <img>;
  // the SVG output bakes in its own width/height attrs and overflows
  // narrow sidebars.
  useEffect(() => {
    if (!open || qrDataUrl || !studioUrl) return;
    let cancelled = false;
    QRCode.toDataURL(studioUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      color: { dark: '#e7e7ea', light: '#00000000' },
      width: 320,
    }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [open, qrDataUrl, studioUrl]);

  const showQr = !platform.isMobile;

  return (
    <div className="card">
      <h3>Capture from real life</h3>
      <p style={{ margin: 0, color: 'var(--muted)', fontSize: 12, lineHeight: 1.4 }}>
        Use Apple's{' '}
        <a href={APPLE_DOC_URL} target="_blank" rel="noreferrer">
          Object Capture
        </a>{' '}
        on iPhone (iOS 17+) or Mac (macOS 12+) to turn real-world photos
        of an object into a USDZ, then import it above.
      </p>

      <PlatformBadge platform={platform} />

      <button
        onClick={() => setOpen((b) => !b)}
        style={{ marginTop: 4 }}
      >
        {open ? 'Hide' : showQr ? '📷 Scan with iPhone' : '📷 Open capture guide'}
      </button>

      {open && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            paddingTop: 4,
          }}
        >
          {showQr && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 6,
                padding: 10,
              }}
            >
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="QR code linking to this studio"
                  title={studioUrl}
                  width={160}
                  height={160}
                  style={{ display: 'block', imageRendering: 'pixelated' }}
                />
              ) : (
                <div style={{ width: 160, height: 160, fontSize: 11 }}>
                  Generating…
                </div>
              )}
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--muted)',
                  lineHeight: 1.4,
                  textAlign: 'center',
                }}
              >
                Scan with your iPhone Camera to open this studio there,
                then follow the steps below.
              </div>
            </div>
          )}

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
              Install a free Object Capture app on iPhone —{' '}
              <a
                href={REALITY_SCAN_APPSTORE_URL}
                target="_blank"
                rel="noreferrer"
              >
                RealityScan
              </a>{' '}
              (Epic Games) is a good pick.
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
              <a
                href="https://developer.apple.com/documentation/realitykit/creating-a-photogrammetry-command-line-app"
                target="_blank"
                rel="noreferrer"
              >
                <code>HelloPhotogrammetry</code>
              </a>{' '}
              CLI on a folder of photos to produce a USDZ headlessly.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function PlatformBadge({ platform }: { platform: PlatformInfo }) {
  const supported =
    platform.supportsObjectCaptureMobile || platform.supportsObjectCaptureMac;
  const label = describePlatform(platform);
  return (
    <div
      style={{
        fontSize: 11,
        color: supported ? '#34d399' : 'var(--muted)',
        marginTop: -4,
      }}
    >
      {supported ? '✓' : 'ℹ'} {label}
    </div>
  );
}

function describePlatform(p: PlatformInfo): string {
  if (p.supportsObjectCaptureMobile) {
    return `Detected ${p.os === 'ipad' ? 'iPad' : 'iPhone'} on iOS ${p.iosMajor}+ — capture on this device.`;
  }
  if (p.supportsObjectCaptureMac) {
    return 'Detected Mac — Object Capture works here, or scan with your iPhone.';
  }
  if (p.isMobile && (p.iosMajor ?? 0) > 0) {
    return `Detected iOS ${p.iosMajor} — Object Capture needs iOS 17 or newer.`;
  }
  return 'Object Capture requires iOS 17+ (iPhone/iPad Pro) or macOS 12+.';
}
