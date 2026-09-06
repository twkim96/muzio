#!/bin/bash
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
ios_dir="$(cd "$script_dir/.." && pwd)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/muzio-audio-test.XXXXXX")"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$test_dir"
}
trap cleanup EXIT INT TERM
python3 - "$test_dir" <<'PY' &
import functools, http.server, pathlib, re, sys, wave
root = pathlib.Path(sys.argv[1])
media = root / 'api' / 'media'
media.mkdir(parents=True)
with wave.open(str(media / 'fixture'), 'wb') as out:
    out.setnchannels(1)
    out.setsampwidth(2)
    out.setframerate(44100)
    out.writeframes(b'\0\0' * 44100 * 12)
class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/api/media/fixture':
            self.send_error(404)
            return
        data = (media / 'fixture').read_bytes()
        start, end = 0, len(data) - 1
        requested = self.headers.get('Range')
        if requested:
            match = re.fullmatch(r'bytes=(\d+)-(\d*)', requested)
            if not match:
                self.send_error(416)
                return
            start = int(match[1])
            end = min(int(match[2]) if match[2] else end, end)
            if start > end:
                self.send_error(416)
                return
        self.send_response(206 if requested else 200)
        self.send_header('Content-Type', 'audio/wav')
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        if requested:
            self.send_header('Content-Range', f'bytes {start}-{end}/{len(data)}')
        self.end_headers()
        self.wfile.write(data[start:end + 1])
    def log_message(self, *args):
        pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(root)))
(root / 'port').write_text(str(server.server_port))
server.serve_forever()
PY
server_pid=$!
for ((attempt=0; attempt<100; attempt++)); do
  [[ -s "$test_dir/port" ]] && break
  kill -0 "$server_pid" 2>/dev/null || { echo 'Fixture server failed' >&2; exit 1; }
  sleep 0.05
done
[[ -s "$test_dir/port" ]] || { echo 'Fixture server startup timed out' >&2; exit 1; }
architecture="$(uname -m)"
swiftc -swift-version 5 -target "$architecture-apple-macosx13.0" \
  "$ios_dir/Muzio/NativeAudioPlayer.swift" "$ios_dir/Tests/NativeAudioTests.swift" -o "$test_dir/native-audio-tests"
python3 - "$test_dir/native-audio-tests" "http://127.0.0.1:$(cat "$test_dir/port")" <<'PYRUN'
import subprocess, sys
try:
    result = subprocess.run(sys.argv[1:], timeout=45)
    sys.exit(result.returncode)
except subprocess.TimeoutExpired:
    print('Native audio test process timed out after 45 seconds', file=sys.stderr)
    sys.exit(1)
PYRUN
