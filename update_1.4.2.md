# Update 1.4.2 - Long-video HLS fMP4 Sidecar

## 상태

- 문서 상태: Code release complete - automated gates complete; real-device validation follow-up
- 계획 승인일: 2026-08-03
- 목표 버전: `1.4.2`
- 작성일: 2026-08-03
- 개발 시작일: 2026-08-04
- 코드 완료일: 2026-08-04
- 기준 릴리스: 검증 완료된 `1.4.1`
- 이전 계획: `update_1.4.0.md`, `update_1.4.1.md`
- 시작 조건: front-`moov` 대형 인덱스가 `1.4.0` 이후에도 주 병목이며
  faststart로 개선할 수 없음

## 목표

이미 front-`moov`지만 인덱스가 수십 MiB인 초장시간 H.264/AAC 영상을 원본
수정과 재인코딩 없이 HLS/fMP4 sidecar로 명시적으로 준비한다. Safari/PWA는
작은 manifest와 resume target 부근 segment부터 접근해 단일 MP4의 거대한
인덱스 선행 비용을 피한다.

`1.4.2`는 `1.4.1`의 explicit single-slot `videoopt` manager를 확장한다.
지원 조건을 만족하지 않는 파일은 기존 direct Range로 fallback한다.

## 적용 대상

초기 대상은 다음을 모두 만족하는 파일로 제한한다.

- MP4/MOV container
- H.264 video 1개
- AAC audio 0개 또는 1개
- embedded subtitle, alternate video/audio track 없음
- FFmpeg `-c copy` HLS/fMP4 packaging 가능
- `1.4.0` 진단에서 큰 front-`moov`가 시작/resume 병목으로 확인됨
- 충분한 free space와 사용자의 명시적 prepare 요청

다중 audio, subtitle, HEVC, incompatible codec은 원본 direct-play 가능 여부와
무관하게 첫 HLS cache 대상에서 제외한다. track을 조용히 누락시키지 않는다.

## 확정 계약

- 원본은 수정하거나 삭제하지 않는다.
- packaging은 명시적 prepare로만 시작한다.
- `videoopt` ready slot은 `kind=hls-fmp4`와 불변 `cacheKey`를 기록한다.
- temp directory 전체 검증 뒤 directory rename으로 atomic publish한다.
- 이전 ready slot은 새 package가 완성될 때까지 유지한다.
- manifest와 segment는 source fingerprint와 `cacheKey`에 종속된다. URL path에
  generation key를 포함해 이전 playlist와 새 segment가 섞이지 않게 한다.
- stale/incomplete package는 사용하지 않고 direct source로 fallback한다.
- playback/progress/activity identity는 원본 media ID를 유지한다.
- Safari native HLS를 우선하고 지원하지 않는 browser는 direct source를 유지한다.
- packaging이 현재 media stream, startup scan, thumbnail 작업과 경쟁하지 않게
  기존 quiet/background-work gate를 적용하고 새 media response가 시작되면 FFmpeg
  child process까지 취소한다.
- 교체된 HLS generation은 즉시 삭제하지 않는다. 이미 manifest를 받은 player가
  후속 segment를 계속 요청할 수 있으므로 generation별 active request와 playback
  lease를 추적하고, lease 만료와 quiet grace 뒤 retirement cleanup한다.

## 2026-08-04 코드 리뷰 반영

- 등록된 manifest/init/media segment가 없거나 크기가 달라지면 current metadata를
  제거하고 generation 전체를 invalid retired 상태로 전환한다. 이후 status는 ready를
  반환하지 않으며 같은 generation의 다른 asset도 새로 acquire하지 않는다.
- startup deep validation 결과의 asset 이름, 크기, 종류가 persisted `Assets`와
  정확히 일치해야 ready metadata를 복구한다.
- HLS 경로에도 transport/sample diagnostic cookie를 생성·삭제하고 server Range
  record와 연결한다.
- retired file/directory는 mutex 안에서 deleting 집합으로 분리한 뒤 mutex 밖에서
  삭제한다. 삭제 실패만 grace와 함께 retired 상태로 되돌린다.
- package asset sync는 writable handle로 수행하고 검증·sync가 끝난 뒤에만 progress
  100%를 보고한다.
- ffprobe eligibility는 H.264 profile/level/pixel format/codec tag와 AAC
  profile/sample rate/channel/codec tag를 포함한다. 초기 allowlist는 실기기 검증 전
  넓게 추정하지 않고 8-bit 4:2:0 H.264 Baseline/Main/High level 5.1 이하와
  mono/stereo LC/HE-AAC로 제한한다.
- cold 첫 touch의 status race는 확인했지만 click handler가 fetch를 기다려 Safari
  user activation을 잃는 변경은 하지 않는다. visible-row batch/observer prefetch는
  Phase 0 실기기 요청량·지연 측정 뒤 채택한다.

## 2026-08-04 재리뷰 반영

- HLS 진단 record는 manifest/init의 고정 이름 또는 allowlisted segment 이름에서
  파싱한 정수 index만 추가한다. R10/R50/R90에서 어떤 segment가 먼저 요청됐는지
  경로나 임의 문자열 노출 없이 판정할 수 있다.
- post-processing은 package validation 전후, probe/keyframe 검증 전후, 각 asset
  sync 직전, directory sync 전후에 context 취소를 확인한다. build용 manifest/asset
  validation 반복도 context를 받아 media playback 시작 시 중단된다.
- video eligibility에 field order와 average/nominal frame rate를 추가한다. 초기
  allowlist는 progressive, 60fps 이하, `avc1`로 제한하고 `avc3`는 실기기 증거 전까지
  거부한다.
- 초기 AAC allowlist는 LC/HE-AAC mono/stereo와 HE-AACv2 stereo로 제한한다.
  검증되지 않은 multichannel 조합은 direct playback에 남긴다.
- HLS manifest는 `application/vnd.apple.mpegurl`, init은 `video/mp4`, media
  segment는 `video/iso.segment`로 구분한다.
- FFmpeg/ffprobe process가 context 취소로 kill된 경우 `ExitError`보다 `ctx.Err()`를
  우선 반환한다. media stream에 의한 정상 background 취소는 failed 상태나 warning
  log로 남지 않는다.
- random-access boundary는 검증하지만 `independent_segments` flag/tag는 실기기
  검증 전에는 생성하지 않는다. 외부 도구가 미검증 tag를 만든 package도 거부한다.

## Phase 0 - prototype 승인 게이트

Status: Deferred to the consolidated real-device pass after 1.4.2 code review

사용자 결정에 따라 `1.4.0`~`1.4.2` 실기기 검증은 1.4.2 코드 리뷰가 끝난
뒤 한 번에 수행한다. 이 단계의 30% 성능 기준은 아직 충족된 것으로 간주하지
않으며, 현재 개발은 원본을 변경하지 않는 eligibility/package 기반부터 진행한다.

- [ ] `1.4.0` 파일군 C에서 큰 front-`moov` Range와 parsing 지연을 재확인한다.
- [ ] HTTP/2, resume target 조정, network gate 이후 남은 지연을 기록한다.
- [ ] 대표 H.264/AAC 파일 한 개를 별도 temp 경로에 수동 package한다.
- [ ] direct MP4와 HLS의 packaging 시간, output 크기, manifest 크기, segment
  개수/분포, first play, resume, seek를 비교한다.
- [ ] 원본 GOP 간격과 생성된 segment duration의 min/median/p95/max를 기록한다.
  stream-copy에서 `hls_time=6`은 정확한 6초 경계를 보장하지 않음을 전제로 한다.
- [ ] Safari 탭과 홈 화면 PWA에서 native HLS 재생을 각각 확인한다.

완료 기준:

- HLS prototype이 파일군 C의 N/R 모드 `선택 -> playing` 중앙값을 30% 이상
  개선하고 seek/progress 정확성을 유지한다.
- 기준을 넘지 못하면 구현하지 않고 `Rejected by measurement`로 종료한다.

## Phase 1 - eligibility와 package plan

Status: Completed (2026-08-04)

- [x] 기존 bounded MP4 atom inspector와 FFmpeg/ffprobe command 계약을 재사용한다.
  production detector wiring은 manager 통합 단계에서 수행한다.
- [x] bounded ffprobe 결과로 video/audio/subtitle/data/unknown track을 판정한다.
- [x] H.264 profile/level/pixel format/codec tag와 AAC profile/sample rate/channel/
  codec tag를 판정해 검증하지 않은 High 10·비 4:2:0 조합을 package 전에 거부한다.
- [x] H.264 field order와 average/nominal frame rate를 판정해 interlaced,
  over-60fps, 미검증 `avc3`를 거부한다. AAC는 검증 전 mono/stereo로 제한하고
  HE-AACv2는 stereo만 허용한다.
- [x] H.264 1개 + AAC 최대 1개 외의 track은 ineligible로 처리한다. chapter도
  초기 HLS sidecar에서 조용히 누락하지 않고 ineligible로 처리한다.
- [x] source size/mtime fingerprint와 예상 output/additional free space/cache peak를
  구분해 계산한다. manager source fingerprint와 기존 slot 사용량을 연결하고 source 파일 크기를 cache
  사용량에 중복 합산하지 않는다.
- [x] front-`moov` size threshold와 최대 GOP는 bounded environment 설정으로
  조정 가능하며 잘못된 값은 거부한다. 기본 16 MiB/12초는 코드 리뷰와 통합
  실기기 측정을 위한 보수적 gate이며 최종 성능 채택값은 Phase 0에서 확정한다.
- [x] already fragmented/CMAF-compatible 파일의 불필요한 repackaging을 피한다.
- [x] bounded keyframe probe로 GOP interval min/median/p95/max를 계산한다.
  keyframe 간격이 너무 길어 target segment 또는 startup latency 기준을
  만족하지 못하는 파일은 `copy-packaging unsuitable`로 판정한다. 재인코딩 없이
  임의의 6초 독립 segment를 만들 수 있다고 가정하지 않으며, 최대 허용 GOP도
  실측값이 주입되지 않으면 실행을 거부한다.

완료 기준:

- eligible/ineligible reason이 API와 UI에서 동일하게 설명된다.
- unsupported track을 버린 채 package하는 경로가 없다.

현재 구현 및 검증 증거:

- `backend/internal/videoopt/hls_plan.go`
- `backend/internal/videoopt/hls_plan_test.go`
- 실제 FFmpeg/ffprobe H.264 front-moov fixture에서 bounded keyframe probe 통과
- 현재 Go toolchain과 Go `1.22.12` focused test 통과
- `go test -race`, `go vet`, Windows/amd64 compile surface 통과

manager/API/UI가 같은 reason/storage/GOP contract를 사용한다.

## Phase 2 - fMP4 HLS packager

Status: Completed (2026-08-04)

초기 command 방향:

```bash
ffmpeg -i <source> \
  -map 0:v:0 -map 0:a:0? -c copy \
  -f hls -hls_segment_type fmp4 \
  -hls_time 6 -hls_playlist_type vod \
  <temp-dir>/index.m3u8
```

실제 option은 representative GOP와 Safari validation 결과로 확정한다.

- [x] segment는 기존 keyframe boundary를 존중하고 실제 random access point로
  시작하는지 검증한다. `independent_segments` flag와 playlist tag는 실기기 검증
  전에는 표시하지 않으며, 미검증 tag가 포함된 package는 거부한다.
- [x] `hls_time`은 target duration일 뿐 강제 절단값이 아니므로 segment duration
  p95/max와 resume target 오차를 acceptance 기준에 포함한다.
- [x] init segment, media segments, VOD manifest를 temp directory에 생성한다.
- [x] timeout/cancel, bounded stderr와 FFmpeg progress를 적용한다.
- [x] FFmpeg 종료 뒤 validation/probe/keyframe/asset sync/directory sync 전체가
  background context 취소를 준수한다.
- [x] faststart FFmpeg, 일반 ffprobe, HLS keyframe ffprobe, HLS FFmpeg가 context
  취소로 종료되면 process exit error를 `context.Canceled`로 정규화한다.
- [x] segment filename은 server-generated safe name만 사용한다.
- [x] manifest의 absolute/local filesystem path 노출을 금지한다.
- [x] package duration, codec, segment count, init/segment 존재와 packaged
  random-access boundary를 검증한다.
- [x] publish 직전에 source fingerprint를 다시 확인한다.
- [x] temp directory 전체가 유효할 때만 ready directory로 교체한다. temp와
  ready가 같은 filesystem인지 확인하고 file/directory sync 및 atomic rename
  순서를 명시한다.
- [x] asset은 writable handle로 sync하며 validate/sync/directory sync가 완료되기
  전에는 build progress를 100%로 표시하지 않는다.

완료 기준:

- interrupted build, invalid manifest, missing segment, source 변경은 publish되지
  않는다.
- 성공 package는 Safari가 첫/중간/끝 segment에서 재생할 수 있다.

## Phase 3 - HLS HTTP surface

Status: Completed (2026-08-04)

제안 API:

| Method and path | 용도 |
| --- | --- |
| `GET /api/video-optimization/{id}` | HLS eligibility와 slot 상태 |
| `PUT /api/video-optimization/{id}?kind=hls-fmp4` | 명시적 package 요청 |
| `DELETE /api/video-optimization/{id}/build` | 해당 build 취소 |
| `DELETE /api/video-optimization/{id}/cache` | 해당 ready cache retirement 요청 |
| `GET /api/video-optimization/hls/{id}/{cacheKey}/index.m3u8` | immutable VOD manifest |
| `GET/HEAD /api/video-optimization/hls/{id}/{cacheKey}/{asset}` | init/media segment |

- [x] manifest MIME은 HLS playlist type으로 제공한다.
- [x] fMP4 init/segment MIME과 Content-Length를 정확히 제공한다.
- [x] init/segment GET/HEAD와 Range를 지원한다.
- [x] ETag/Last-Modified와 immutable `private, no-transform`을 적용한다.
- [x] manifest는 gzip을 허용하고 `Vary: Accept-Encoding`을 적용할 수 있다.
  init/media segment와 모든 Range 응답은 gzip하지 않는다.
- [x] media ID, generation key와 asset name을 allowlist하고 traversal을 거부한다.
- [x] stale slot, missing/corrupt asset, source 변경은 새 source 선택에서 direct fallback
  상태로 전환한다. manifest/segment 응답 body를 시작한 뒤에는 원본 MP4로 중간
  전환하지 않는다.
- [x] HLS manifest/init/segment 요청에도 diagnostic transport/sample cookie가
  전달되어 client sample과 server Range record를 연결한다.
- [x] HLS 진단에 fixed manifest/init identity 또는 bounded numeric segment index를
  기록해 resume target request order를 판정할 수 있다.
- [x] init과 media segment를 각각 `video/mp4`, `video/iso.segment` MIME으로 제공한다.
- [x] 현재 ready가 아닌 `cacheKey`도 active playback lease가 남아 있는 retired
  generation이면 계속 제공한다. lease가 끝난 뒤에는 404/410으로 종료한다.

완료 기준:

- manifest가 존재하지 않는 asset을 참조하지 않는다.
- 다른 media ID의 segment나 temp directory에 접근할 수 없다.

## Phase 4 - player source selection과 resume

Status: Code complete; real-device request-order evidence pending

- [x] ready `kind=hls-fmp4`와 Safari native HLS capability가 모두 있을 때만 HLS
  source를 선택한다.
- [x] HLS MIME을 정확히 제공하고 Vidstack HLS source type을 검증한다.
- [x] 원본 media ID를 progress/activity/queue identity로 유지한다.
- [x] 저장된 seconds를 HLS timeline의 동일 위치로 적용한다.
- [ ] N/R10/R50/R90에서 target 부근 segment가 먼저 요청되는지 진단한다.
- [ ] persisted hint가 없는 cold 첫 touch에서 direct가 먼저 선택되는 비율과 visible-row
  prefetch의 요청 수를 측정한 뒤 bounded prefetch 채택 여부를 결정한다.
- [x] HLS error 또는 stale package는 동일 play attempt에서 최대 한 번만 direct
  MP4로 명시적으로 retry한다. direct failure가 다시 HLS를 선택하는 loop를 막는다.
- [x] fallback이 progress를 0초로 덮어쓰지 않게 한다.
- [x] Safari가 아닌 browser의 기존 direct source 선택을 유지한다.

완료 기준:

- resume가 manifest 뒤 target segment로 진행되고 거대 MP4 `moov` Range를 먼저
  요구하지 않는다.
- direct/HLS/fallback 전환에서 source generation과 progress identity가
  안전하다.

## Phase 5 - single-slot lifecycle과 UI

Status: Completed (2026-08-04)

- [x] `1.4.1` single-slot manager가 file output과 directory output을 구분한다.
- [x] 새 HLS build 중 이전 faststart/HLS ready slot을 유지한다.
- [x] HLS ready가 교체되거나 다른 media/kind가 single slot을 차지해도 active
  HLS playback의 manifest generation은 lease 종료 전까지 유지한다.
- [x] 성공 뒤 이전 slot은 retired로 표시하고 active request=0, playback lease
  만료, quiet grace를 모두 만족한 뒤 file/directory를 정리한다.
- [x] recursive file/directory 삭제는 manager mutex 밖에서 수행하고, 삭제 중에도
  current generation asset acquire가 지연되지 않는다.
- [x] startup에서 orphan temp directory와 incomplete/corrupt package를 정리한다.
- [x] 예상 output/peak storage와 free space를 prepare 전에 표시한다.
- [x] building progress, cancel, ready clear를 제공한다. cancel과 clear는 서로
  다른 명시적 action이며 상태에 따라 다른 대상을 지우지 않는다.
- [x] ineligible reason과 direct fallback을 사용자에게 과장 없이 표시한다.

완료 기준:

- file-to-directory, directory-to-file, directory-to-directory 교체가 crash-safe하다.
- clear/cancel/restart가 원본과 현재 ready slot을 손상시키지 않는다.

## Phase 6 - 검증과 릴리스

Status: Automated verification complete; real-device validation deferred

### 자동 검증

- [x] `GOCACHE=/private/tmp/muzio-go-cache go test -count=1 ./...` - 현재 workspace
  sandbox에서는 listener 2개가 bind 제한을 받았지만, 독립 리뷰 환경의 같은
  checkout에서 HTTP/2/HTTP/1.1 listener를 포함한 전체 test 통과가 확인됐다.
- [x] `GOCACHE=/private/tmp/muzio-go-cache go vet ./...`
- [x] videoopt/httpserver/streaming/config `go test -race -count=1`
- [x] `npm test`
- [x] `npm run build`
- [x] `VMA_VERSION=1.4.2 bash scripts/verify_version.sh`
- [x] `git diff --check`

### package와 HTTP

- [x] temp/ready atomic publish와 restart recovery
- [x] missing/corrupt manifest와 segment fallback
- [x] current/retired 중간 segment 손상 시 generation invalidation과 ready 해제
- [x] HLS diagnostic cookie 생성·삭제와 server correlation
- [x] HLS manifest/init/segment identity와 segment index 진단
- [x] post-processing sync 도중 background context 취소
- [x] 실행 중 FFmpeg/ffprobe 취소의 정상 cancellation 분류와 manager 상태 복귀
- [x] progressive/60fps/avc1 및 stereo AAC eligibility
- [x] init/segment MIME 구분
- [x] 느린 retired directory 삭제 중 current asset 비차단
- [x] Range, ETag, MIME, manifest gzip/segment no-gzip, traversal test
- [x] playlist generation 교체 중 active segment 연속 요청과 retired cleanup
- [x] HLS 실패 후 direct one-shot fallback 및 retry loop 방지
- [x] source fingerprint 변경과 media 삭제
- [x] disk 부족, cancel, FFmpeg failure

### 실기기

- [ ] iPad Safari/PWA N/R10/R50/R90 cold/warm 각 5회
- [ ] target segment 최초 요청과 `선택 -> playing` 측정
- [ ] seek, pause/resume, source 교체, fullscreen/PiP
- [ ] 장시간 재생 waiting/rebuffer, segment 연속성, ready slot 교체 중 재생 유지
- [ ] segment duration min/median/p95/max와 resume target 오차
- [ ] direct fallback과 nPlayer HTTPS/SMB 비교

### 버전 표면

- [x] package/lockfile/settings/PWA cache `1.4.2`
- [x] README HLS cache path, API, eligibility, storage 설명
- [x] 실제 지원 codec/track 제한만 release note에 기록

### 코드 리뷰 전달 증거

- 현재 Go와 Go `1.22.12`에서 전체 `./internal/...` test 통과
- Go `1.22.12`에서 변경된 server dependency/config wiring focused test 통과
- `go vet ./...`, 변경 package race test, Windows/amd64 videoopt/server compile 통과
- 실제 FFmpeg/ffprobe `8.0.1` H.264/AAC fixture로 fMP4 VOD manifest, init,
  segment, codec/duration, random-access boundary와 segment 통계 검증
- Node `22.18.0`과 Node `26.4.0`에서 47 files, 499 tests 및 production build 통과
- `VMA_VERSION=1.4.2` version surface와 `git diff --check` 통과
- HTTP/2 listener를 포함한 전체 `go test ./...`는 독립 리뷰 환경에서 통과했다.
  현재 workspace sandbox에서는 loopback bind 제한이 유지된다.

## 전체 완료 기준

- eligible 초장시간 파일에서 거대 단일 `moov` 선행 다운로드를 피한다.
- 파일군 C의 시작/이어보기 중앙값이 direct MP4보다 30% 이상 개선된다.
- original, direct fallback, media ID, progress와 cache crash-safety가 유지된다.
- unsupported codec/track 파일을 조용히 변환하거나 누락하지 않는다.
- Safari/PWA 실제 기기 증거 없이는 완료로 표시하지 않는다.

## 범위 제외

- codec 재인코딩과 adaptive bitrate ladder
- HEVC 및 비 H.264 video 지원 확대
- multi-audio와 embedded subtitle HLS rendition
- live HLS
- multi-entry LRU와 전체 library 자동 packaging
- DRM/FairPlay
- Android ExoPlayer HLS 최적화

## 공식 근거

- Safari video delivery와 HLS:
  <https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari>
- FFmpeg MOV/MP4 fragmentation과 HLS:
  <https://ffmpeg.org/ffmpeg-formats.html>
