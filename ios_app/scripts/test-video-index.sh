#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/muzio-video-index.XXXXXX")"
SERVER_PID=""
cleanup() { if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi; rm -rf "$TEST_DIR"; }
trap cleanup EXIT
python3 - "$TEST_DIR" <<'PY' &
import http.server,json,pathlib,sys,time,urllib.parse
root=pathlib.Path(sys.argv[1]); size=2098176
class Handler(http.server.BaseHTTPRequestHandler):
 def do_HEAD(self): self.serve(True)
 def do_GET(self): self.serve(False)
 def serve(self,head):
  parsed=urllib.parse.urlsplit(self.path); query=urllib.parse.parse_qs(parsed.query); ident=parsed.path.rsplit('/',1)[-1]
  with (root/'requests.log').open('a') as f: f.write(self.path+'\n')
  if self.headers.get('If-Match')=='reject-me' or self.headers.get('If-Unmodified-Since')=='reject-me':
   self.send_response(412);self.send_header('Content-Length','0');self.end_headers();return
  revision=('b' if (root/'revision').exists() else 'a')*64
  prefix=b'C' if (root/'revision').exists() else b'A'
  mode=query.get('index',[''])[0]
  if mode=='manifest':
   data=json.dumps(dict(eligible=ident!='unsupported',revision=revision,fileSize=size,indexBytes=1024,mimeType='video/mp4',modifiedAt='Mon, 07 Sep 2026 00:00:00 GMT')).encode()
   self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);return
  if mode=='data':
   self.send_response(200);self.send_header('Content-Length','1024');self.send_header('X-Muzio-Revision',revision);self.end_headers();self.wfile.write(prefix*1024);return
  if ident=='race' and 'index_revision' in query:
   self.send_response(409);self.send_header('Content-Length','0');self.end_headers();return
  start,end=0,size-1; status=200; requested=self.headers.get('Range')
  if requested and not self.headers.get('If-Range'):
   a,b=requested.removeprefix('bytes=').split('-');start=int(a) if a else size-int(b);end=min(int(b),size-1) if a and b else size-1;status=206
  self.send_response(status);self.send_header('Content-Length',str(end-start+1));self.send_header('Content-Type','video/mp4');self.send_header('X-Muzio-Revision',revision)
  if status==206:self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
  self.end_headers()
  if head:return
  try:
   for offset in range(start,end+1,32768):
    length=min(32768,end-offset+1); first=min(length,max(0,1024-offset));self.wfile.write(prefix*first+b'B'*(length-first));self.wfile.flush()
    if ident=='slow':time.sleep(.04)
  except (BrokenPipeError,ConnectionResetError): (root/'canceled').write_text('yes')
 def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);(root/'port').write_text(str(server.server_port));server.serve_forever()
PY
SERVER_PID=$!
for ((i=0;i<100;i++)); do [[ -s "$TEST_DIR/port" ]] && break; sleep .05; done
xcrun swiftc -swift-version 5 -parse-as-library "$ROOT/ios_app/Muzio/ServerPolicy.swift" "$ROOT/ios_app/Muzio/VideoIndexProxy.swift" "$ROOT/ios_app/Tests/VideoIndexProxyTests.swift" -o "$TEST_DIR/tests"
"$TEST_DIR/tests" "$TEST_DIR" "http://127.0.0.1:$(cat "$TEST_DIR/port")"
