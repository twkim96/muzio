#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VLC_ROOT="$ROOT/ios_app/ThirdParty/VLCiOS/VLCKit.xcframework"
VLC_SLICE="$VLC_ROOT/ios-arm64_x86_64-simulator"
VLC_FRAMEWORK="$VLC_SLICE/VLCKit.framework"
BUNDLE_ID="com.twkim.muzio.vlc-pip-tests"
SIMULATOR_UDID="${MUZIO_IOS_SIMULATOR_UDID:-}"
LOG="${MUZIO_VLC_PIP_TEST_LOG:-/tmp/muzio-vlc-pip-tests.log}"

TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/muzio-vlc-pip.XXXXXX")"
APP="$TEST_DIR/VLCPictureInPictureTests.app"
BINARY="$APP/VLCPictureInPictureTests"
cleanup() {
  if [[ -n "$SIMULATOR_UDID" ]]; then
    xcrun simctl terminate "$SIMULATOR_UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
    xcrun simctl uninstall "$SIMULATOR_UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT INT TERM

: > "$LOG"
exec > >(tee "$LOG") 2>&1

command -v xcrun >/dev/null 2>&1 || { echo "xcrun is required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required for the timeout wrapper" >&2; exit 1; }
[[ -f "$VLC_ROOT/Info.plist" && -f "$VLC_FRAMEWORK/VLCKit" ]] || {
  echo "VLCKit iOS framework is not prepared: $VLC_ROOT" >&2
  exit 1
}

if [[ -z "$SIMULATOR_UDID" ]]; then
  SIMULATOR_UDID="$(xcrun simctl list devices available | sed -nE '/iPad .*\(Booted\)/s/.*\(([0-9A-F-]{36})\) \(Booted\).*/\1/p' | head -n 1)"
fi
[[ -n "$SIMULATOR_UDID" ]] || {
  echo "A booted iPad simulator is required (set MUZIO_IOS_SIMULATOR_UDID to select one)." >&2
  exit 1
}
xcrun simctl list devices available | rg -q "\($SIMULATOR_UDID\) \(Booted\)" || {
  echo "Simulator is not booted: $SIMULATOR_UDID" >&2
  exit 1
}

mkdir -p "$APP/Frameworks"
cp "$ROOT/ios_app/Info.plist" "$APP/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable VLCPictureInPictureTests" "$APP/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName VLCPictureInPictureTests" "$APP/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName VLCPictureInPictureTests" "$APP/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$APP/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :UIApplicationSceneManifest" "$APP/Info.plist"
cp -R "$VLC_FRAMEWORK" "$APP/Frameworks/VLCKit.framework"

architecture="$(uname -m)"
xcrun --sdk iphonesimulator swiftc -swift-version 5 -parse-as-library \
  -target "$architecture-apple-ios18.0-simulator" \
  -F "$VLC_SLICE" -framework VLCKit \
  -Xlinker -rpath -Xlinker '@executable_path/Frameworks' \
  "$ROOT/ios_app/Muzio/ServerPolicy.swift" \
  "$ROOT/ios_app/Muzio/VLCVideoPictureInPicture.swift" \
  "$ROOT/ios_app/Tests/VLCVideoPictureInPictureTests.swift" \
  -o "$BINARY"

xcrun simctl install "$SIMULATOR_UDID" "$APP"
python3 - "$SIMULATOR_UDID" "$BUNDLE_ID" <<'PY'
import subprocess
import sys

try:
    result = subprocess.run(
        ["xcrun", "simctl", "launch", "--console", sys.argv[1], sys.argv[2]],
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
    )
except subprocess.TimeoutExpired:
    print("VLC PiP adapter simulator test timed out after 45 seconds", file=sys.stderr)
    sys.exit(1)

output = result.stdout + result.stderr
print(output, end="")
if result.returncode != 0:
    sys.exit(result.returncode)
if "VLC PiP adapter regression passed" not in output:
    print("VLC PiP adapter simulator test did not report completion", file=sys.stderr)
    sys.exit(1)
PY
