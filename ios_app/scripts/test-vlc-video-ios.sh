#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VLC_ROOT="$ROOT/ios_app/ThirdParty/VLCiOS/VLCKit.xcframework"
VLC_SLICE="$VLC_ROOT/ios-arm64_x86_64-simulator"
VLC_FRAMEWORK="$VLC_SLICE/VLCKit.framework"
BUNDLE_ID="com.twkim.muzio.vlc-video-ios-tests"
SIMULATOR_UDID="${MUZIO_IOS_SIMULATOR_UDID:-42DE4366-F1BE-4165-8003-7560F100C70A}"
SERVER_PID=""
ORIGIN="${1:-${MUZIO_VIDEO_TEST_ORIGIN:-}}"
MEDIA_URL="${2:-${MUZIO_VIDEO_TEST_MEDIA_URL:-}}"
LOG="${MUZIO_VLC_IOS_TEST_LOG:-/tmp/muzio-vlc-video-ios-tests.log}"

TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/muzio-vlc-video-ios.XXXXXX")"
APP="$TEST_DIR/VLCVideoPlayerIOSTests.app"
BINARY="$APP/VLCVideoPlayerIOSTests"
cleanup() {
  if [[ -n "$SIMULATOR_UDID" ]]; then
    xcrun simctl terminate "$SIMULATOR_UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
    xcrun simctl uninstall "$SIMULATOR_UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; fi
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

if [[ -z "$ORIGIN" && -z "$MEDIA_URL" ]]; then
  command -v ffmpeg >/dev/null || { echo "ffmpeg is required for the local fixture"; exit 1; }
  mkdir -p "$TEST_DIR/media/api/media"
  ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=640x360:rate=24 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 35 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 24 -c:a aac -movflags +faststart -f mp4 "$TEST_DIR/media/api/media/fixture"
  python3 - "$TEST_DIR/media" "$TEST_DIR/port" <<'PY_SERVER' &
import functools, http.server, pathlib, re, sys
class RangeHandler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        path = pathlib.Path(self.translate_path(self.path))
        if not path.is_file():
            return super().send_head()
        size = path.stat().st_size
        value = self.headers.get("Range")
        match = re.fullmatch(r"bytes=(\d+)-(\d*)", value or "")
        if value and not match:
            self.send_error(416)
            return None
        start = int(match[1]) if match else 0
        end = min(int(match[2]), size - 1) if match and match[2] else size - 1
        if start > end:
            self.send_error(416)
            return None
        self.send_response(206 if match else 200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if match:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        source = path.open("rb")
        source.seek(start)
        self.remaining = end - start + 1
        return source
    def copyfile(self, source, outputfile):
        try:
            while self.remaining:
                chunk = source.read(min(self.remaining, 65536))
                if not chunk:
                    break
                outputfile.write(chunk)
                self.remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(RangeHandler, directory=sys.argv[1]))
pathlib.Path(sys.argv[2]).write_text(str(server.server_port))
server.serve_forever()
PY_SERVER
  SERVER_PID=$!
  for attempt in {1..50}; do [[ -s "$TEST_DIR/port" ]] && break; sleep 0.1; done
  ORIGIN="http://127.0.0.1:$(cat "$TEST_DIR/port")"
  MEDIA_URL="$ORIGIN/api/media/fixture"
fi
[[ -n "$ORIGIN" && -n "$MEDIA_URL" ]] || { echo "Supply both origin and media URL"; exit 2; }
mkdir -p "$APP/Frameworks"
cp "$ROOT/ios_app/Info.plist" "$APP/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable VLCVideoPlayerIOSTests" "$APP/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName VLCVideoPlayerIOSTests" "$APP/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName VLCVideoPlayerIOSTests" "$APP/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$APP/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :UIApplicationSceneManifest" "$APP/Info.plist"
cp -R "$VLC_FRAMEWORK" "$APP/Frameworks/VLCKit.framework"

architecture="$(uname -m)"
xcrun --sdk iphonesimulator swiftc -swift-version 5 -parse-as-library \
  -target "$architecture-apple-ios18.0-simulator" \
  -F "$VLC_SLICE" -framework VLCKit \
  -Xlinker -rpath -Xlinker '@executable_path/Frameworks' \
  "$ROOT/ios_app/Muzio/ServerPolicy.swift" \
  "$ROOT/ios_app/Muzio/NativeVideoSourcePolicy.swift" \
  "$ROOT/ios_app/Tests/VideoNowPlayingTests.swift" \
  "$ROOT/ios_app/Muzio/VideoNowPlaying.swift" \
  "$ROOT/ios_app/Muzio/VLCVideoPlayer.swift" \
  "$ROOT/ios_app/Muzio/VLCVideoPictureInPicture.swift" \
  "$ROOT/ios_app/Tests/VLCVideoPlayerIOSTests.swift" \
  -o "$BINARY"

xcrun simctl install "$SIMULATOR_UDID" "$APP"
SIMCTL_CHILD_MUZIO_VIDEO_DIAGNOSTICS=1 python3 - "$SIMULATOR_UDID" "$BUNDLE_ID" "$ORIGIN" "$MEDIA_URL" <<'PY'
import re
import subprocess
import sys

try:
    result = subprocess.run(
        ["xcrun", "simctl", "launch", "--console", sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]],
        capture_output=True,
        text=True,
        timeout=150,
        check=False,
    )
except subprocess.TimeoutExpired as error:
    for output in (error.stdout, error.stderr):
        if output:
            print(output.decode(errors="replace") if isinstance(output, bytes) else output, end="")
    print("VLC iOS native video simulator test timed out after 150 seconds", file=sys.stderr)
    sys.exit(1)

output = result.stdout + result.stderr
print(output, end="")
if result.returncode != 0:
    sys.exit(result.returncode)
if "VLC iOS native video regression passed" not in output:
    print("VLC iOS native video simulator test did not report completion", file=sys.stderr)
    sys.exit(1)

frames = [int(value) for value in re.findall(r"VLC state=.*?frames=(\d+)", output)]
if not frames or max(frames) == 0:
    print("VLC iOS test did not demonstrate displayed frames", file=sys.stderr)
    sys.exit(1)
PY
