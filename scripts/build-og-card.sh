#!/usr/bin/env bash
# Render scripts/og-card.svg → public/og-card.png at 1200x630 using
# headless Chrome. macOS-only (uses the system Chrome binary). Re-run
# after editing the SVG to refresh the social preview image.
set -euo pipefail

cd "$(dirname "$0")/.."

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ ! -x "$CHROME" ]; then
  echo "error: Google Chrome not found at $CHROME" >&2
  exit 1
fi

"$CHROME" \
  --headless \
  --disable-gpu \
  --hide-scrollbars \
  --window-size=1200,630 \
  --screenshot="$PWD/public/og-card.png" \
  "file://$PWD/scripts/og-card.svg" >/dev/null 2>&1

echo "wrote public/og-card.png"
