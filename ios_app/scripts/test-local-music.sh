#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/muzio-local-music.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT
swiftc -swift-version 5 "$ROOT/ios_app/Muzio/LocalMusicLibrary.swift" "$ROOT/ios_app/Tests/LocalMusicLibraryTests.swift" -o "$TEST_DIR/tests"
if command -v ffmpeg >/dev/null; then
  python3 - "$TEST_DIR/cover.ppm" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_bytes(b'P6\n320 320\n255\n' + bytes([255, 54, 95]) * 320 * 320)
PY
  ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=44100:cl=mono -i "$TEST_DIR/cover.ppm" -map 0:a -map 1:v -t 0.2 -c:a libmp3lame -c:v mjpeg -frames:v 1 -id3v2_version 3 -metadata title='Local fixture' -metadata artist='Muzio test' -metadata:s:v comment='Cover (front)' "$TEST_DIR/fixture.mp3"
  "$TEST_DIR/tests" "$TEST_DIR/fixture.mp3"
else
  "$TEST_DIR/tests"
  echo 'Artwork fixture skipped: ffmpeg not installed.'
fi
