#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/dist/apple/Muzio.app"
"$ROOT/ios_app/scripts/prepare-vlckit.sh"
VLC_SLICE="$ROOT/ios_app/ThirdParty/VLCKit.xcframework/macos-arm64_x86_64"
VLC_FRAMEWORK="$VLC_SLICE/VLCKit.framework"
VLC_LICENSE="$ROOT/ios_app/ThirdParty/licenses/VLCKit-COPYING.txt"
[[ -f "$VLC_FRAMEWORK/VLCKit" ]] || { echo "VLCKit macOS framework is not prepared" >&2; exit 1; }
[[ -f "$VLC_LICENSE" ]] || { echo "VLCKit LGPL notice is not prepared" >&2; exit 1; }

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
xcrun swiftc -swift-version 5 -parse-as-library -O -target "$(uname -m)-apple-macosx13.0" \
  -F "$VLC_SLICE" -framework VLCKit \
  -Xlinker -rpath -Xlinker '@loader_path/../Frameworks' \
  "$ROOT"/ios_app/Muzio/*.swift -o "$APP/Contents/MacOS/Muzio"
cp "$ROOT/ios_app/Mac-Info.plist" "$APP/Contents/Info.plist"
if [[ -f "$ROOT/ios_app/Muzio.icns" ]]; then cp "$ROOT/ios_app/Muzio.icns" "$APP/Contents/Resources/"; fi
mkdir -p "$APP/Contents/Resources/licenses"
cp "$VLC_LICENSE" "$APP/Contents/Resources/licenses/"

rm -rf "$APP/Contents/Frameworks/VLCKit.framework"
if command -v ditto >/dev/null 2>&1; then
  ditto "$VLC_FRAMEWORK" "$APP/Contents/Frameworks/VLCKit.framework"
else
  cp -R "$VLC_FRAMEWORK" "$APP/Contents/Frameworks/VLCKit.framework"
fi
VLC_BINARY="$APP/Contents/Frameworks/VLCKit.framework/Versions/A/VLCKit"
VLC_INSTALL_NAME='@loader_path/../Frameworks/VLCKit.framework/Versions/A/VLCKit'
if command -v otool >/dev/null 2>&1 && command -v install_name_tool >/dev/null 2>&1; then
  if [[ "$(otool -D "$VLC_BINARY" | tail -n 1)" != "$VLC_INSTALL_NAME" ]]; then
    install_name_tool -id "$VLC_INSTALL_NAME" "$VLC_BINARY"
  fi
fi
codesign --force --sign - "$APP/Contents/Frameworks/VLCKit.framework"
codesign --force --sign - "$APP"
printf 'Built %s\n' "$APP"
