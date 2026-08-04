# Muzio 1.4.1

Muzio는 개인 MacBook, mini PC, Linux/NAS의 음악, 비디오, 이미지를
브라우저에서 탐색하고 재생하는 경량 self-hosted 미디어 앱입니다.

## Current State

| Item | Current contract |
| --- | --- |
| Product/service name | `Muzio` |
| Version | `1.4.1` |
| Primary client | React + TypeScript web app |
| Backend | Go `1.22`, CGO-free |
| Normal runtime | Go server가 API, media, `web_app/dist`를 한 origin에서 제공 |
| Intended network | localhost, trusted LAN, Tailscale tailnet |
| Authentication | 없음 |
| Transcoding | 일반 fallback은 계획 API만 제공; AAC resume 및 명시적 video faststart에 stream-copy cache 사용 |
| Persistence | config, library index, progress는 backend config directory; UI data는 browser storage |

> **Security boundary:** 이 서버는 인증과 사용자 권한 분리가 없습니다.
> 공용 인터넷에 직접 노출하지 마십시오. localhost, 신뢰된 LAN 또는 Tailscale
> 내부에서만 사용합니다.

`1.4.1`은 end-`moov` MP4/MOV를 사용자가 명시적으로 요청했을 때만 FFmpeg
stream-copy `+faststart` sidecar로 준비합니다. 원본 파일은 수정하지 않으며,
검증된 단일 ready slot과 불변 `cacheKey` URL만 재생에 사용합니다. HTTP/2,
진단, direct Range 재생과 기존 AAC resume cache 계약은 그대로 유지됩니다.
Ready 선택은 브라우저에 한 slot만 지속되어 앱 재시작 뒤 첫 재생에도 사용할 수
있고, library row focus/pointer 진입 시 상태를 사전 갱신합니다.

## Source Of Truth

공개 저장소는 분석에 필요한 현재 코드와 이 README만 포함합니다.

1. 실제 코드와 통과하는 테스트가 동작의 최종 기준입니다.
2. `README.MD`는 현재 제품 계약, 실행법, 코드 지도를 설명합니다.

README와 코드가 충돌하면 코드와 통과하는 테스트를 우선하고 README를
수정합니다. 과거 계획, 작업 로그, 기기별 설정은 공개 저장소의 계약이 아닙니다.

## AI Task Routing

| Question or task | Start here |
| --- | --- |
| 서버 시작/종료, dependency wiring | `backend/cmd/server/main.go` |
| config path, media roots, appearance | `backend/internal/config/` |
| routes, JSON limits, SSE, handlers | `backend/internal/httpserver/` |
| scan, snapshot, watcher, persistent index | `backend/internal/library/` |
| Range streaming and file response | `backend/internal/streaming/` |
| path traversal and root safety | `backend/internal/mediapath/` |
| progress conflict/persistence | `backend/internal/progress/` |
| latest AAC resume remux cache | `backend/internal/audioresume/` |
| explicit video faststart sidecar | `backend/internal/videoopt/` |
| ffmpeg availability/fallback plan | `backend/internal/fallback/` |
| app routes and shell composition | `web_app/src/app/` |
| library state/live sync/virtual list | `web_app/src/features/library/` |
| playback state, queue, mounts, controls | `web_app/src/features/player/` |
| resume sync policy | `web_app/src/features/progress/` |
| localStorage repositories | `web_app/src/core/storage/` |
| HTMLMediaElement/session/source | `web_app/src/core/playback/` |
| shared icon wrapper | `web_app/src/core/ui/AppIcons.tsx` |
| playlists and smart collections | `web_app/src/features/playlists/` |
| settings and runtime diagnostics | `web_app/src/features/settings/` |

## Architecture

```text
Browser / installed PWA
  -> React feature stores and audio/Vidstack playback engines
  -> same-origin /api and /healthz

Go HTTP server
  -> config + media-root ownership
  -> persistent library index + in-memory snapshot
  -> filesystem watcher + SSE/delta updates
  -> HTTP Range media streaming
  -> single-slot AAC resume remux cache
  -> explicit single-slot video faststart sidecar
  -> persistent playback progress
```

Important boundaries:

- Direct play over HTTP Range is the primary playback path.
- ffmpeg is optional. `/api/fallback/{mediaId}` does not launch general
  remux/transcode jobs. When ffmpeg is available, video thumbnails use one
  bounded background frame worker and raw AAC can use one latest-track M4A
  resume-cache job.
- Local filesystem roots use watchers. Network/FUSE roots may require manual
  refresh because reliable low-idle notifications cannot be guaranteed.
- The PWA service worker caches the app shell only. It does not cache
  `/api/*`, `/api/media/*`, or `/healthz`.
- Global HTTP `WriteTimeout` stays disabled for streaming and SSE.
  `ReadHeaderTimeout` is `5 s`, `IdleTimeout` is `90 s`.
- Backend HTTPS uses Go's standard `ServeTLS` path so compatible clients can
  negotiate HTTP/2 while explicit HTTP/1.1 and non-TLS fallback remain valid.

## Implemented Capabilities

- Separate audio, video, and image roots.
- Stable media IDs and sorted library snapshots.
- Persistent `library-index.v1.log` with background verification.
- Local watcher updates, typed revisions, SSE, and delta fetch.
- Shared server-side video thumbnail and bounded image-preview cache with live
  row refresh.
- Offline-root hiding with persistent index restoration after reconnection.
- Immediate confirmed-file removal and delayed offline thumbnail cleanup.
- Audio/video playback, seek, queue modes, likes, playlists, smart collections.
- Native M4A `©ART` artist metadata without per-file ffprobe processes.
- `Recently Watching` from video activity.
- Local and backend-synced playback resume progress.
- Opt-in bounded video startup/resume diagnostics with client/server Range
  correlation; normal playback does not add diagnostic query parameters.
- Single-slot latest AAC M4A cache after 30 seconds of playback; uncached
  progress records retain the existing temporal-fragment resume fallback.
- Explicit single-slot end-`moov` MP4/MOV faststart sidecar with bounded atom
  inspection, free-space gating, FFmpeg stream-copy validation, and immutable
  Range URLs. Eligibility probing and builds both wait for the shared media-quiet
  gate and stop when normal media playback begins.
- Replaced or cleared video sidecars remain addressable by immutable cache key
  for a renewable 30-minute playback lease. A sidecar load failure retries the
  original media once at the same resume position without changing media identity,
  then invalidates that browser's stale ready hint.
- Direct and faststart Range endpoints use the same opt-in diagnostic cookies and
  bounded request/byte/timing record, so A/B samples remain comparable.
- Persistent backend `progress.v1.json` with timestamp conflict resolution.
- Atomic config/progress writes with backup recovery.
- Queue virtualization for large music queues.
- Installable app-shell PWA.
- Phosphor-based shared icon wrapper with glyph-first music transport controls.
- A CGO-free Go server that can serve the built web application from one origin.

Known limitations:

- No authentication, multi-user isolation, or public-internet hardening.
- No general-purpose fallback remux/transcode worker. Remux is limited to the
  bounded AAC resume cache and a user-requested single video faststart copy.
- Video thumbnail extraction requires ffmpeg; SVG fallback artwork remains
  available when ffmpeg is missing or a source cannot be decoded.
- Browser codec support still determines direct-play success.
- Backend metadata is file/index based; no SQLite dependency is linked.
- Browser/PWA local-device file playback is intentionally not part of the
  current web/PWA release.
  A browser can persist a text list of selected filenames, sizes, and modified
  times, but that metadata does not preserve permission to read the files after
  reload or app restart. Cross-mobile direct playback without copying media
  still requires the user to reselect files, while persistent filesystem handle
  APIs are not reliable across Android and iOS PWAs.

## Quick Start

Prerequisites:

- Go `1.22+`
- Node.js `22+` and npm

### 1. Backend only

Use a non-conflicting development port:

```sh
cd backend
VMA_PORT=9030 \
VMA_MEDIA_ROOTS="/path/to/music:/path/to/video:/path/to/images" \
go run ./cmd/server
```

Default address without overrides is `127.0.0.1:7777`.

### 2. Frontend dev server

```sh
cd web_app
npm install
VMA_DEV_BACKEND=http://127.0.0.1:9030 npm run dev
```

Vite serves port `5173` and proxies `/api/*` and `/healthz` to the Go backend.

### 3. Integrated production-style local run

Build the web bundle and let the Go server serve it from the same origin:

```sh
cd web_app
npm ci
npm run build

cd ../backend
VMA_HOST=127.0.0.1 \
VMA_PORT=9030 \
VMA_MEDIA_ROOTS="/path/to/music:/path/to/video:/path/to/images" \
VMA_WEB_DIST="../web_app/dist" \
go run ./cmd/server
```

## Configuration And Persistence

If `VMA_CONFIG` is omitted, the config path is:

```text
<OS user config dir>/videio_music_app/config.json
```

The `videio_music_app` directory name is a legacy compatibility identifier.
It remains unchanged in `1.4.1` so existing config, library index, and playback
progress are reused without migration risk. The workspace directory path and
`VMA_*` environment variables are also compatibility surfaces; new public
names, package names, binaries, health identifiers, and control-server entries
use `Muzio`.

Backend files beside the resolved config:

| File | Purpose |
| --- | --- |
| `config.json` | host, port, split media roots, web dist, appearance |
| `library-index.v1.log` | last-known library and revision journal |
| `progress.v1.json` | versioned playback progress records |
| `audio-resume-cache/v1/` | latest raw-AAC M4A resume cache and slot metadata |
| `video-optimization/v1/` | one validated faststart sidecar, metadata, and temporary build files |

Video optimization estimates the output at the source size and requires that
much additional free space plus `max(5%, 512 MiB)`. During replacement, the
previous ready file, a new temporary output, and a retired generation can
coexist. Source bytes are not counted as cache usage. Temp and final outputs
are created in the same versioned directory so publish uses an atomic rename.
The free-space gate runs both at prepare time and immediately before background
work, and the safety margin is checked again before publish. The UI peak cache
estimate reports cache bytes plus expected output, separately from required
free space and its safety margin.
Retired generations use one resettable cleanup timer; active Range requests
defer deletion, later Range requests renew the playback lease, and sharing-
violation deletion failures remain retired for a bounded retry.
If the original disappears, changes fingerprint, or becomes ineligible, its
current sidecar is removed from metadata and retired for bounded cleanup.

`progress.v1.json` writes are coalesced with a `2 s` quiet window and flushed
on shutdown with a bounded deadline. Corrupt JSON starts with an empty progress
store and a warning; filesystem permission errors remain fatal.

Browser storage owns likes, playlists, activity analytics, appearance fallback,
and local resume state. Playback activity is memory-cached and writes progress
at most every `10 s`, plus terminal/lifecycle flushes.

Do not treat saved browser metadata as local-file read permission. For mobile
PWAs, a stored filename/path-like label can be used only as display or
reselection aid; it cannot reopen the device file for playback by itself.

Environment variables:

| Variable | Purpose |
| --- | --- |
| `VMA_CONFIG` | Explicit config JSON path |
| `VMA_THUMBNAIL_WORKERS` | Video thumbnail workers (`1` default, bounded to `4`) |
| `VMA_HOST` | Bind host override |
| `VMA_PORT` | Bind port override |
| `VMA_MEDIA_ROOTS` | OS path-list separated seed roots |
| `VMA_MEDIA_ROOTS_OVERRIDE` | Force environment roots for this run |
| `VMA_WEB_DIST` | Static web bundle served by Go |
| `VMA_HTTPS` | Enable backend TLS with `1` or `true` |
| `VMA_TLS_CERT` | TLS certificate path |
| `VMA_TLS_KEY` | TLS private key path |
| `VMA_DEV_BACKEND` | Vite proxy target |

Saved split roots (`audioRoots`, `videoRoots`, `imageRoots`) take precedence
over seeded `VMA_MEDIA_ROOTS` unless `VMA_MEDIA_ROOTS_OVERRIDE=1`.

### Opt-in video playback diagnostics

Video startup and resume diagnostics are disabled during normal playback. For
one controlled Safari/PWA run, use Web Inspector console:

```js
window.muzioPlaybackDiagnostics.enable()
window.muzioPlaybackDiagnostics.clear()
// Select and play one video, then export before starting another run.
window.muzioPlaybackDiagnostics.export()
window.muzioPlaybackDiagnostics.disable()
```

The export is bounded to 400 entries and separates a per-sample `sampleId` from
a diagnostic-session `transportCorrelationId`. A same-origin cookie carries
the transport ID and a second path-scoped cookie carries the sample ID to
`/api/media/`; `clear()` rotates only the sample cookie without changing the
media URL or its cache identity. In-flight requests retain the sample ID they
started with. The backend emits matching `media stream` records at Info level.
Normal requests stay out of Info logs, and diagnostics do not include
filesystem paths, Tailscale addresses, certificate data, or arbitrary query
values.

## HTTP Surface

| Method and path | Purpose |
| --- | --- |
| `GET /healthz` | Process health |
| `GET /api/library?type=audio|video|image` | Library list |
| `GET /api/library/changes` | Revision delta |
| `GET /api/library/events` | SSE revision events |
| `GET/PUT/POST /api/settings/media-roots` | Read/update/rescan roots |
| `GET/PUT/DELETE /api/settings/appearance` | Appearance settings |
| `GET /api/media/{id}` | Range-friendly media stream |
| `HEAD /api/media/{id}` | Media headers |
| `GET /api/thumbnails/{id}` | Thumbnail response |
| `GET /api/fallback/{id}` | Direct/remux/transcode plan status |
| `GET /api/audio-resume-cache` | Latest AAC resume-cache status |
| `PUT /api/audio-resume-cache/{id}` | Queue the latest AAC cache candidate |
| `GET/HEAD /api/audio-resume-cache/media/{id}` | Range-friendly cached M4A stream |
| `GET /api/video-optimization/{id}` | Eligibility, space, build, and ready status |
| `PUT /api/video-optimization/{id}` | Explicitly prepare one faststart sidecar |
| `DELETE /api/video-optimization/{id}/build` | Cancel that media's active build |
| `DELETE /api/video-optimization/{id}/cache?v={cacheKey}` | Retire that immutable ready generation |
| `GET/HEAD /api/video-optimization/media/{id}?v={cacheKey}` | Immutable Range-friendly MP4 sidecar |
| `GET /api/progress` | Progress list |
| `GET/PUT/DELETE /api/progress/{id}` | Progress record |

JSON PUT bodies are limited to `64 KiB`, reject unknown fields, and reject
trailing JSON values.

Examples:

```sh
curl http://127.0.0.1:9030/healthz
curl 'http://127.0.0.1:9030/api/library?type=video'
curl -H 'Range: bytes=0-1023' \
  http://127.0.0.1:9030/api/media/<id>
curl -X POST http://127.0.0.1:9030/api/settings/media-roots
```

## Verification

Backend:

```sh
cd backend
go test -count=1 ./...
go test -race -count=1 \
  ./internal/fallback ./internal/httpserver ./internal/library ./internal/progress
go vet ./...
```

Frontend:

```sh
cd web_app
npm test
npm run build
```

Focused library benchmark:

```sh
cd backend
go test ./internal/library -run '^$' \
  -bench 'BenchmarkSnapshotReconciled' -benchmem -count=3
```

## Change Rules

- Preserve direct-play and low-idle behavior before adding features.
- Keep handlers thin; filesystem, snapshot, progress, and playback policy stay
  in their owning packages.
- Do not add polling where watcher/event behavior exists.
- Do not make localStorage writes or broad React subscriptions part of
  `timeupdate`.
- Do not cache media streams in the service worker.
- Do not add mobile local-file playback by storing only path text or metadata;
  it must either require explicit reselection or use a proven cross-browser file
  permission surface.
- Add focused tests first, then run full release gates for cross-boundary work.
- Update `README.MD` when runtime contracts or the code map change.
