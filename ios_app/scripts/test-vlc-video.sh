#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
THIRDPARTY="$ROOT/ios_app/ThirdParty"
VLC_SLICE="$THIRDPARTY/VLCKit.xcframework/macos-arm64_x86_64"
VLC_FRAMEWORK="$VLC_SLICE/VLCKit.framework"
LOG="${MUZIO_VLC_TEST_LOG:-/tmp/muzio-147-vlc-native-tests.log}"
ORIGIN="${MUZIO_VIDEO_TEST_ORIGIN:-}"
MEDIA_URL="${MUZIO_VIDEO_TEST_MEDIA_URL:-}"
if [[ $# -ge 1 ]]; then ORIGIN="$1"; fi
if [[ $# -ge 2 ]]; then MEDIA_URL="$2"; fi
[[ -n "$ORIGIN" && -n "$MEDIA_URL" ]] || { echo "Usage: $0 <server-origin> <video-url>" >&2; exit 2; }

TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/muzio-vlc-native-test.XXXXXX")"
APP="$TEST_DIR/VLCVideoPlayerTests.app"
BINARY="$APP/Contents/MacOS/VLCVideoPlayerTests"
cleanup() { rm -rf "$TEST_DIR"; }
trap cleanup EXIT INT TERM

: > "$LOG"
exec > >(tee "$LOG") 2>&1

[[ -f "$VLC_FRAMEWORK/VLCKit" ]] || {
  echo "VLCKit macOS framework is not prepared: $VLC_FRAMEWORK" >&2
  exit 1
}
command -v xcrun >/dev/null 2>&1 || { echo "xcrun is required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required for the timeout wrapper" >&2; exit 1; }

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Frameworks"
cp "$ROOT/ios_app/Mac-Info.plist" "$APP/Contents/Info.plist"
ln -s "$VLC_FRAMEWORK" "$APP/Contents/Frameworks/VLCKit.framework"

architecture="$(uname -m)"
xcrun swiftc -swift-version 5 -parse-as-library -target "$architecture-apple-macosx13.0" \
  -F "$VLC_SLICE" -framework VLCKit \
  -Xlinker -rpath -Xlinker '@loader_path/../Frameworks' \
  "$ROOT/ios_app/Muzio/ServerPolicy.swift" \
  "$ROOT/ios_app/Muzio/NativeVideoSourcePolicy.swift" \
  "$ROOT/ios_app/Tests/VideoNowPlayingTests.swift" \
  "$ROOT/ios_app/Muzio/VideoNowPlaying.swift" \
  "$ROOT/ios_app/Muzio/VLCVideoPlayer.swift" \
  "$ROOT/ios_app/Tests/VLCVideoPlayerTests.swift" \
  -o "$BINARY"

MUZIO_VIDEO_DIAGNOSTICS=1 python3 - "$BINARY" "$ORIGIN" "$MEDIA_URL" <<'PY'
import subprocess
import sys

try:
    result = subprocess.run(sys.argv[1:], timeout=45, check=False)
except subprocess.TimeoutExpired:
    print("VLC native video test process timed out after 45 seconds", file=sys.stderr)
    sys.exit(1)
sys.exit(result.returncode)
PY
