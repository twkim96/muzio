# Update 1.4.1 - End-moov Faststart Sidecar

## 상태

- 문서 상태: Release candidate complete - automated gates passed; real-device gate deferred
- 계획 승인일: 2026-08-03
- 목표 버전: `1.4.1`
- 작성일: 2026-08-03
- 코드 완료일: 2026-08-04
- 기준 릴리스: 검증 완료된 `1.4.0`
- 이전 계획: `update_1.4.0.md`
- 후속 계획: `update_1.4.2.md`
- 시작 조건: `1.4.0` 진단에서 end-`moov` 파일의 끝부분 탐색이 주 병목으로
  확인됨

## 목표

`moov` atom이 파일 끝에 있는 direct-play MP4/MOV를 원본 수정 없이
`+faststart` sidecar로 준비해, 이후 Safari/PWA 재생과 이어보기에서 파일 끝
metadata 탐색을 줄인다.

`1.4.1`은 명시적으로 준비한 한 영상만 보관하는 single-slot cache로 범위를
제한한다. 사용자가 선택하지 않은 대용량 파일을 자동으로 remux하지 않는다.

## 적용 대상

- top-level `moov`가 media payload 뒤에 있는 non-fragmented MP4/MOV
- 현재 브라우저에서 direct-play 가능한 video/audio codec
- FFmpeg stream-copy로 track을 보존할 수 있는 파일
- 원본 fingerprint와 충분한 free space를 확인한 파일

다음은 대상이 아니다.

- 이미 front-`moov`인 파일
- `moof` 기반 fragmented MP4
- codec 재인코딩이 필요한 파일
- stream-copy로 track 보존을 검증할 수 없는 파일
- 수십 MiB front-`moov` 자체가 병목인 초장시간 파일

## 확정 cache 계약

- cache는 설정 디렉터리 아래 versioned 경로에 저장한다.
- ready slot은 한 media ID만 가진다.
- build는 사용자의 명시적 prepare 요청으로만 시작한다.
- 새 build가 끝날 때까지 이전 ready slot을 유지한다.
- build 중에는 이전 ready 파일과 새 temp 파일이 함께 존재할 수 있다.
- free space는 최소 source size와 안전 여유분을 만족해야 한다.
- 성공 검증과 metadata publish가 끝난 뒤에만 새 slot을 활성화한다.
- 실패/취소/용량 부족은 temp만 정리하고 원본과 이전 slot을 유지한다.
- 원본 fingerprint가 바뀌거나 사라지면 sidecar를 사용하지 않는다.
- ready가 아니면 기존 `/api/media/{id}`로 즉시 fallback한다.
- cache kind와 불변 `cacheKey`를 metadata에 기록해 `1.4.2`의 HLS slot과
  구분한다.
- ready URL은 `cacheKey`를 포함해 교체 전후 응답과 browser cache가 섞이지
  않게 한다. media ID만 있는 오래된 URL은 현재 ready로 redirect하지 않고
  명시적으로 현재 상태를 다시 조회하게 한다.
- 교체된 generation은 즉시 삭제하지 않는다. 열린 sidecar response와 Windows
  file handle을 고려해 active request가 0이고 media quiet grace가 지난 뒤
  retirement cleanup하며, 삭제 실패 orphan은 다음 startup/reconcile에서 정리한다.

## storage gate

Status: Completed (2026-08-04)

권장 초기 정책은 explicit single-slot이다.

- [x] cache root는 config 파일과 같은 디렉터리 아래
  `video-optimization/v1/`, metadata는 `schemaVersion: 1`과
  `kind: faststart-mp4`를 사용하는 것으로 확정한다.
- [x] 예상 output 크기는 기본적으로 source size를 상한 추정으로 사용하고,
  prepare 시 필요한 **추가 free space**를
  `estimated output + max(estimated output의 5%, 512 MiB)`로 확인한다.
- [x] 이전 ready와 retired generation은 이미 사용 중인 공간으로 별도 표시하고,
  새 temp까지 포함한 cache 전체 peak 사용량을 UI에 표시한다. source 파일 크기를
  cache 사용량에 다시 더하지 않는다.
- [x] cache root와 temp/final output이 같은 filesystem인지 확인해 rename의 atomic
  전제를 보장한다.
- [x] 사용자가 build 전 예상 출력 크기와 현재 free space를 볼 수 있게 한다.
- [x] cache clear와 build cancel을 명시적으로 제공한다.

size-bounded LRU와 자동 library-wide prepare는 이 버전에 포함하지 않는다.

## Phase 0 - `1.4.0` 증거 인수

Status: Deferred to the consolidated real-device pass after `1.4.2` code review

사용자 결정에 따라 `1.4.0`~`1.4.2`의 실기기 검증을 한 번에 수행한다.
따라서 이 단계의 성능 채택 기준은 아직 통과한 것으로 간주하지 않으며,
현재 구현은 원본을 변경하지 않는 bounded inspection 기반 작업만 먼저 진행한다.

- [ ] 파일군 B에서 end-`moov` Range 순서가 반복 재현된다.
- [ ] HTTP/2와 이어보기 정책 조정 뒤에도 끝부분 탐색이 주 병목이다.
- [ ] 대표 파일의 direct-play codec, track 수, duration, size를 기록한다.
- [ ] 원본과 수동 `+faststart` 복사본의 Safari/PWA A/B를 먼저 수행한다.

완료 기준:

- 수동 faststart 복사본이 cold start 또는 resume 중앙값을 20% 이상 개선하고
  track/seek 회귀가 없다.
- 기준을 넘지 못하면 `1.4.1`을 구현하지 않고 `Rejected by measurement`로
  종료한다.

## Phase 1 - bounded MP4 atom inspection

Status: Completed (2026-08-03)

- [x] top-level atom header만 random-read하는 inspector를 추가한다.
- [x] 32-bit size, extended 64-bit size, size-to-EOF를 안전하게 처리한다.
- [x] 계산 결과가 header보다 작은 크기, overflow, 파일 범위 초과,
  truncated header를 거부한다. encoded size `0`은 ISO BMFF의 합법적인
  size-to-EOF 표현으로만 처리하고 실제 계산 크기는 header 이상이어야 한다.
- [x] `ftyp`, `moov`, media payload, `moof` 위치와 크기를 판정한다.
- [x] atom payload 전체나 거대 `moov`를 eligibility 검사 중 읽지 않는다.
- [x] 파일별 ffprobe process를 eligibility 조회마다 실행하지 않는다.

완료 기준:

- front/end/fragmented/truncated/extended-size fixture가 분류된다.
- 16 GiB급 sparse fixture에서도 검사량은 atom header 수에 비례한다.

구현 및 검증 증거:

- `backend/internal/videoopt/mp4_inspector.go`
- `backend/internal/videoopt/mp4_inspector_test.go`
- 16 GiB sparse end-`moov` fixture에서 atom 3개를 판정하며 총 32 bytes만
  읽는 회귀 테스트 통과
- `go test ./...` 통과
- `go vet ./...` 통과
- `go test -race ./internal/videoopt` 통과
- Go `1.22.12`에서 `go test ./internal/videoopt` 통과

## Phase 2 - single-slot manager

Status: Completed (2026-08-04)

- [x] 새 `backend/internal/videoopt/` single-slot manager를 추가한다.
- [x] media ID, cache kind, source size/mtime, output size, createdAt을 저장한다.
- [x] metadata와 ready 파일을 crash-safe하게 publish한다. temp file close와
  validation 뒤 file sync, metadata atomic replace와 directory sync 순서를
  문서화하고 지원 OS에서 검증한다.
- [x] 시작 시 temp, orphan, 불완전 metadata를 정리한다.
- [x] 동일 fingerprint/ready 요청은 no-op 처리한다.
- [x] 새 요청은 이전 미완성 build를 취소하고 bounded cleanup한다. 같은 media/
  kind/fingerprint 요청은 기존 build에 합류하고 restart하지 않는다.
- [x] media stream과 startup verification 중 build가 경쟁하지 않게 기존
  `WaitForMediaQuiet`/`BackgroundWorkContext` 계약을 재사용한다. 새 media response가
  시작되면 FFmpeg child process까지 취소되는지 검증한다.
- [x] ready/retired generation별 active request 수를 추적하고 cleanup은 active=0과
  quiet grace 이후에만 시도한다.
- [x] cancel은 실패 횟수나 원본 상태를 손상시키지 않는다.

완료 기준:

- 성공 전 이전 slot 보존, 성공 후 교체, 실패/cancel/restart 복구가 테스트된다.
- manager가 원본 파일을 수정하거나 삭제하는 경로가 없다.

## Phase 3 - FFmpeg faststart build

Status: Completed (2026-08-04)

기본 command 계약:

```bash
ffmpeg -hide_banner -loglevel error -i <source> \
  -map 0 -map_metadata 0 -map_chapters 0 \
  -c copy -movflags +faststart -f mp4 -y <temp-output>
```

- [x] FFmpeg availability를 기존 detector로 확인한다.
- [x] source와 output을 같은 파일로 지정하지 못하게 한다.
- [x] bounded timeout/cancel context를 사용한다.
- [x] stdout/stderr를 무제한 보관하지 않는다. `CombinedOutput` 전체 보관 대신
  bounded tail 또는 streaming logger를 사용한다.
- [x] MP4가 수용하지 못하는 data/attachment track은 eligibility에서 거부하거나
  명시적 보존 정책을 정한다. `-map 0` 실패를 track 누락 fallback으로 바꾸지 않는다.
- [x] output의 stream 수, codec, duration, size와 front-`moov`를 검증한다.
- [x] source fingerprint를 publish 직전에 다시 확인한다.
- [x] 검증 실패 시 temp만 삭제한다.

완료 기준:

- video/audio/subtitle track 보존이 대표 fixture에서 확인된다.
- output이 front-`moov`이고 원본과 duration/stream 계약이 일치한다.

## Phase 4 - HTTP API와 Range stream

Status: Completed (2026-08-04)

제안 API:

| Method and path | 용도 |
| --- | --- |
| `GET /api/video-optimization/{id}` | eligibility와 ready/building 상태 |
| `PUT /api/video-optimization/{id}` | 명시적 faststart prepare |
| `DELETE /api/video-optimization/{id}/build` | 해당 build 취소 |
| `DELETE /api/video-optimization/{id}/cache` | 해당 ready cache retirement 요청 |
| `GET/HEAD /api/video-optimization/media/{id}?v={cacheKey}` | immutable ready sidecar Range stream |

- [x] media ID를 strict lookup/resolve한다.
- [x] ready fingerprint와 URL `cacheKey`가 모두 일치할 때만 sidecar를 제공한다.
  stale/missing key는 다른 generation으로 암묵 전환하지 않는다.
- [x] GET/HEAD, Range 206/416, ETag, Last-Modified, MIME을 지원한다.
- [x] media response gzip을 제외한다.
- [x] status/source 선택 단계의 non-ready/stale slot은 원본 direct URL로
  fallback한다. 이미 sidecar body를 쓰기 시작한 응답은 중간에 원본으로 전환하지
  않는다.
- [x] cancel/clear는 대상 media ID와 현재 generation을 확인하고 idempotent하게
  처리한다. 다른 media의 active build/ready를 상태 의존적으로 지우지 않는다.
- [x] extra path segment와 traversal을 거부한다.

완료 기준:

- sidecar와 fallback 모두 first/middle/end Range test가 통과한다.
- stale cache가 다른 media ID나 변경된 원본에 제공되지 않는다.

## Phase 5 - 웹 UI와 playback selection

Status: Completed (2026-08-04)

- [x] video details에 eligibility, 예상 크기, ready/building 상태를 표시한다.
- [x] 사용자가 명시적으로 `Prepare faster playback`을 실행한다.
- [x] building cancel과 ready cache clear를 서로 다른 명시적 action으로 제공한다.
  하나의 `DELETE`가 상태에 따라 다른 대상을 지우는 모호한 계약은 사용하지 않는다.
- [x] ready fingerprint가 일치하는 media ID만 sidecar URL로 재생한다.
- [x] source와 progress identity는 원본 media ID를 유지한다.
- [x] cache unavailable/error는 기존 direct source를 즉시 사용한다.
- [x] 앱 시작 시 seeded resume source도 load 전에 ready 상태를 조회해 sidecar를
  선택하며, 조회 실패 시 direct seed를 유지한다.
- [x] sidecar 404/410/network/provider error는 현재 위치와 원본 MIME을 보존해
  direct source로 한 번만 fallback하고 재시도 loop를 만들지 않는다.
- [x] MOV sidecar의 `Use original`은 원본 `video/quicktime` MIME을 복원한다.
- [x] 이미 front-`moov`인 파일에는 prepare를 권하지 않는다.
- [x] 초장시간 front-`moov` 파일에는 `1.4.2` 후보임을 오인 없이 표시한다.

완료 기준:

- cache 준비 실패가 재생 버튼, progress, queue, recently watching을 막지 않는다.
- ready/cache/fallback 전환 뒤에도 이어보기 target이 동일하다.

## 1차 리뷰 보완

Status: Completed (2026-08-04)

- [x] FFmpeg, ffprobe 또는 cache manager가 비활성인 환경에서 typed-nil interface를
  노출하지 않아 optimization route가 등록되거나 panic하지 않는다. 기존 audio
  resume cache도 같은 nil 계약으로 정리했다.
- [x] prepare 요청은 ready/building과 저장공간을 확인한 뒤 building을 등록하고
  즉시 반환한다. ffprobe eligibility와 FFmpeg build는 모두
  `WaitForMediaQuiet`/`BackgroundWorkContext` 안에서 같은 취소 수명을 사용한다.
- [x] data/attachment 등 보존 불가능 판정은 source fingerprint별로 기억하며,
  원본 fingerprint가 바뀔 때만 다시 probe한다.
- [x] retired generation도 불변 `cacheKey`로 Acquire할 수 있고 새 Range마다
  30분 playback lease를 갱신한다. active response가 끝난 뒤 grace를 적용한다.
- [x] cleanup은 manager당 reset 가능한 timer 하나만 사용한다. 삭제 실패는 retired
  entry를 유지해 grace 뒤 재시도한다.
- [x] seeded resume, MOV `Use original`, sidecar provider error의 one-shot direct
  fallback을 회귀 테스트로 고정했다.

## 2차 리뷰 보완

Status: Completed (2026-08-04)

- [x] prepare 시점뿐 아니라 media-quiet 통과 직후에도
  `estimated output + safety margin`을 다시 확인한다. FFmpeg output이 생긴 뒤
  publish 직전에는 safety margin을 다시 확인하며, 공간이 줄었으면 builder 또는
  publish를 시작하지 않는다.
- [x] builder 반환 직후, output sync 전, 검사/rename/publish 전에 background
  context 취소를 확인한다. build 완료 시 timeout cancel을 명시적으로 해제한다.
- [x] 원본 삭제, fingerprint 변경, front-moov 전환 등으로 current가 stale이면
  metadata에서 즉시 제외하고 active response가 끝난 뒤 짧은 grace로 회수한다.
- [x] `PeakCacheBytes`는 `cache used + estimated output`, `RequiredFreeBytes`는
  `estimated output + safety margin`으로 의미를 분리한다.
- [x] ready hint 한 slot을 browser storage에 보존해 앱 재시작 뒤 첫 일반 재생에도
  사용할 수 있게 하고, library row focus/pointer에서 상태를 미리 조회한다.
  sidecar error fallback은 ready hint를 폐기해 다음 재생의 반복 실패를 막는다.
- [x] direct와 faststart sidecar가 같은 transport/sample cookie, Range 종류,
  status, bytes, first-write, duration 진단 계약을 사용한다. cookie query로 media
  cache identity를 변경하지 않는다.

## Phase 6 - 검증과 릴리스

Status: Automated verification complete; real-device validation deferred

### 자동 검증

- [x] `GOCACHE=/private/tmp/muzio-go-cache go test -count=1 ./...`
- [x] `GOCACHE=/private/tmp/muzio-go-cache go vet ./...`
- [x] videoopt/httpserver/streaming/config `go test -race -count=1`
- [x] `npm test`
- [x] `npm run build`
- [x] `VMA_VERSION=1.4.1 bash scripts/verify_version.sh`
- [x] `git diff --check`

### 실파일과 실기기

- [x] FFmpeg `8.0.1`로 생성한 end-`moov` MP4와 MOV remux/검증
- [x] front-`moov`/fragmented/ineligible fallback
- [x] build cancel, restart, source 변경, disk 부족
- [ ] iPad Safari/PWA cold/warm N/R10/R50/R90
- [x] 원본과 sidecar의 video/audio/subtitle/data/attachment/chapters/metadata
  보존 또는 명시적 ineligible 판정 확인
- [x] active Range response 중 cache 교체/clear 뒤 retired generation의 후속
  first/middle/end/seek Range와 Windows sharing-violation 형태의 delete failure retry
  (결정적 주입 회귀 테스트)
- [ ] 실제 Windows host의 열린 file handle 삭제 복구 확인
- [x] build 중 기존 media playback 경쟁 여부를 media gate 회귀 테스트로 확인

### 버전 표면

- [x] package/lockfile/settings/PWA cache `1.4.1`
- [x] README cache path, API, capability, storage peak 설명
- [x] 실제 검증된 대상과 제한만 release note에 기록

### 코드 리뷰 전달 증거

- 현재 Go toolchain과 Go `1.22.12`에서 전체 `go test -count=1 ./...` 통과
- `go vet ./...`와 변경 package race test 통과
- macOS와 Windows/amd64 `videoopt` 및 server compile surface 확인
- Node `22.18.0`과 Node `26.4.0`에서 47 files, 492 tests 통과 및
  production build 통과
- 실제 FFmpeg/ffprobe `8.0.1`로 MP4/MOV front-`moov`, stream/codec/duration,
  video/audio/subtitle, metadata를 검증하고 data/attachment/chapter track은
  보존 가능할 때만 통과하거나 명시적으로 ineligible 처리
- 실기기 Safari/PWA 성능과 실제 Windows host file-handle 검증은 사용자 결정에
  따라 `1.4.2` 코드 리뷰 이후 통합 검증하며, 그 전에는 릴리스 완료로 판정하지
  않는다.

## 전체 완료 기준

- 사용자 요청 전 대용량 remux가 자동 시작되지 않는다.
- 새 ready가 검증되기 전 이전 cache와 원본 fallback이 유지된다.
- end-`moov` 대표 파일에서 Safari/PWA 시작 또는 이어보기가 20% 이상 개선된다.
- front-`moov`/fragmented/ineligible 파일은 불필요하게 복제되지 않는다.
- 원본, progress identity, Range, audio resume cache가 보존된다.

## 범위 제외

- 원본 in-place faststart
- 자동 전체-library remux
- multi-entry LRU
- codec 재인코딩
- front-`moov` 대형 인덱스 해결
- HLS/fMP4 packaging

## 공식 근거

- FFmpeg MOV/MP4 `faststart`:
  <https://ffmpeg.org/ffmpeg-formats.html>
