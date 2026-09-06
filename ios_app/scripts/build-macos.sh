#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/dist/apple/Muzio.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
xcrun swiftc -swift-version 5 -parse-as-library -O -target "$(uname -m)-apple-macosx13.0" \
  "$ROOT"/ios_app/Muzio/*.swift -o "$APP/Contents/MacOS/Muzio"
cp "$ROOT/ios_app/Mac-Info.plist" "$APP/Contents/Info.plist"
if [[ -f "$ROOT/ios_app/Muzio.icns" ]]; then cp "$ROOT/ios_app/Muzio.icns" "$APP/Contents/Resources/"; fi
codesign --force --sign - "$APP"
printf 'Built %s\n' "$APP"
