# Update 1.4.3 - Visible UI Completion

## 상태

- 문서 상태: Active - Phase 0 through Phase 6 completed; Phase 7 pending
- 목표 버전: `1.4.3`
- 작성일: 2026-08-11
- 기준 릴리스: `1.4.2.2` (`80ed081`)
- 이전 계획: `update_1.4.2.md` (closed)
- 원칙: 화면에 보이는 비활성·placeholder·부분 연결 기능을 하나씩 완성한다.

## 목표

현재 UI에 노출되지만 `Soon`, disabled, 잘못된 정렬, 또는 하위 저장소/API와
부분적으로만 연결된 기능을 실제 동작으로 닫는다. 한 phase마다 한 기능군만
구현하고 자동 검증 뒤 다음 phase로 이동한다.

`1.4.3`은 HLS/fMP4 알고리즘이나 cache 구조를 다시 설계하는 버전이 아니다.
`1.4.2`의 미실행 iPad/PWA 성능 측정은 통과로 간주하지 않지만 이 UI release의
완료를 막는 gate로 옮기지도 않는다.

## 2026-08-11 UI 전수 점검 결과

Status: Completed

### 확정된 미완성 항목

| 우선순위 | 보이는 표면 | 현재 코드 근거 | 실제 gap |
| --- | --- | --- | --- |
| Resolved | 음악 목록·mini/full player의 album artwork | 구 backend와 공유 video/audio worker queue가 요청형 artwork를 지연 | 현재 backend 재배포와 전용 audio worker로 production Edge 목록 표시 완료 |
| P1 | Image 메뉴의 Favorites / Recently Added / Screenshots / Downloads | `AppShell.tsx`가 네 항목을 disabled `Soon` 버튼으로 렌더 | collection 계산, count, drawer 연결, image favorite action이 없음 |
| P1 | Video 메뉴의 Recently Watching | `smartCollections.ts`가 `comparePlayCount`로 정렬 | 이름은 최근 시청인데 실제 결과는 재생횟수순 |
| P1 | 음악 전체 플레이어의 More actions | `FullPlayerScreen.tsx`에서 항상 disabled | 열리는 메뉴와 실행 action이 전혀 없음 |
| P2 | custom playlist Edit | repository에는 `moveItem`이 있지만 context/drawer는 delete만 노출 | 사용자가 저장된 재생 순서를 바꿀 수 없음 |
| P2 | 음악 metadata 표면 | scanner는 파일명/폴더 fallback과 M4A `artist`만 읽음 | MP3/FLAC/M4A title/artist/album 일관성이 없고 playback source/Media Session에 album이 없음 |
| P2 | Video description panel | 실제 행은 root/path/duration/progress/size/modified뿐 | 명칭과 내용이 맞지 않고 이미 indexed된 year/season/episode도 표시하지 않음 |
| P2 | OS Media Session 이전/다음 | action type과 queue 기능은 있으나 handler 등록을 의도적으로 생략 | 잠금화면/OS media UI에서 음악 queue 이동 불가 |
| P3 | volume / mute / shuffle / repeat | player store가 매 시작 시 `1/false/false/none`으로 초기화 | 화면에서 바꾼 재생 선호가 reload 후 사라짐 |

### 이미 연결되어 있어 다시 만들지 않을 항목

- Music의 Liked Music / Most Played와 Video의 Recently Watching drawer 연결
- custom playlist 생성, 이름 변경, 삭제, 항목 추가·일괄 삭제
- music queue 열기, 현재 항목 이동, 전체 clear, shuffle/repeat/stop-after-current
- sleep timer, volume/mute, seek와 네트워크 retry UI
- Settings의 Appearance, Backend Status, Media Folders, Runtime Notes anchor와 API
- 영상 Open stream / Share stream, fallback 상태와 faststart/HLS copy 관리 UI
- image viewer 열기/닫기와 `1.4.2.2` 내장 audio artwork 경로

### 실제 화면 검증 상태

- 2026-08-11 사용자가 열어 둔 Microsoft Edge의 production URL
  `https://mac.taila9af19.ts.net:5173`에 접속해 Music / Video / Image / Settings를
  실제 렌더 기준으로 순회했다.
- 최초 검사에서 Music 목록과 full player는 artwork 대신 음표 placeholder를 표시했다.
  full player의 `More actions`도 실제로 disabled였다.
- 최초 production `/api/library?type=audio`의 571개 항목은 모두
  `generated-fallback`이었지만 영상 thumbnail은 정상이라 FFmpeg 전체 장애를 제외했다.
- 실제 fixture `Caravan Palace - Suzy.mp3`는 ffprobe에서 attached MJPEG cover stream을
  가지고 있었고 현재 source와 같은 추출 명령으로 75,852 byte JPEG 생성에 성공했다.
- `scripts/deploy_local.sh`로 현재 backend를 설치하고 Control Server UI의 Muzio 재시작만
  사용했다. `../terminal`의 코드, config, health contract는 변경하지 않았다.
- 재시작 뒤 audio 571개가 `embedded-artwork/pending`으로 migration됐지만 paused media
  stream과 fallback video job이 공유 worker를 막아 visible artwork가 계속 대기했다.
- 요청형 artwork가 playback idle gate를 우회하고 전용 단일 audio worker를 사용하도록
  수정했다. production target은 두 번째 poll에서 `embedded-artwork/ready`가 됐고 Edge
  Music 목록에서 실제 cover image가 표시됐다.
- Video의 `Recently Watching` 11개 drawer는 Phase 1 배포 뒤 최근 재생 항목이 첫 줄로
  이동한 것을 production Edge에서 확인했다.
- Image의 Favorites / Recently Added / Screenshots / Downloads는 실제 화면에서도 모두
  disabled `Soon`으로 확인됐다.
- Settings의 Appearance / Backend Status / Media Folders / Runtime Notes가 production
  데이터와 함께 렌더됐고 화면 표시 버전은 `1.4.2.2`였다.
- 이전 자동 브라우저 실패는 `https://localhost:5173` 인증서 이름 불일치와 격리
  브라우저 CDP timeout이 원인이었다. Edge production desktop UI 확인으로 이 문서의
  desktop 화면 감사 blocker는 해소했으며 모바일·PWA 확인은 각 phase의 별도 gate다.

## 확정 계약

- disabled placeholder는 구현하거나 제거한다. 동작하지 않는 control을 완성된
  기능처럼 두지 않는다.
- label과 정렬/필터 의미가 일치해야 한다.
- 기존 content key, media ID, progress, playlist 문서와 cache 계약을 유지한다.
- 큰 library에서 전체 재계산·전체 렌더를 새로 유발하지 않는다.
- metadata 처리를 위해 파일마다 ffprobe process를 시작하지 않는다.
- 브라우저 API가 없는 경우 해당 action만 숨기거나 명확한 fallback을 제공한다.
- 기존 localStorage 문서 migration은 versioned·fail-closed·export/import 호환으로
  설계하며 정상 데이터의 조용한 초기화를 금지한다.

## Phase 0 - album artwork 배포와 lazy worker 복구

Status: Completed (2026-08-11)

작업:

- [x] 현재 source의 Go backend를 `scripts/deploy_local.sh`로 build/install했다.
- [x] production service는 Control Server UI의 `server-control--muzio` 경로로만 재시작했다.
- [x] 기존 `generated-fallback` audio thumbnail 571개가
  `embedded-artwork/pending`으로 migration됐다.
- [x] visible audio artwork는 playback idle을 기다리지 않고 전용 단일 worker에서
  추출되며, video/image thumbnail의 기존 quiet gate는 유지한다.
- [x] target item이 `embedded-artwork/ready`로 전환되고 production Edge 목록에서
  실제 cover가 표시됐다.
- [x] 내장 cover가 없는 audio는 fallback 처리하며 동일 cache key를 반복 enqueue하지
  않는 기존 계약과 테스트를 유지했다.

완료 기준:

- production target cover가 Edge 목록에 표시되고 API는 ready artwork URL을 반환한다.
- mini/full player와 Media Session의 동일 artwork URL 전달은 기존 frontend 자동 테스트로
  검증했으며, 사용자의 현재 재생곡을 바꾸는 실화면 검사는 수행하지 않았다.
- service 재시작 후 Control Server health가 `OK`이고 기존 재생 선택을 변경하지 않았다.
- thumbnail package test/race와 전체 Go test/vet가 통과한다.

추가 회귀 수정 (2026-08-11):

- 기존 `library.snapshot.audio.v2`가 thumbnail을 제외한 채 ETag를 저장해, reload 뒤
  서버가 `embedded-artwork/ready`여도 boot-time resume source가 filename/root fallback에
  머무는 결함을 Suzy fixture로 재현했다.
- audio snapshot을 v3로 올리고 immutable `embedded-artwork/ready`만 보존하며, 기존 v1/v2
  cache는 한 번 폐기한다. library가 로드되면 active source의 metadata/artwork presentation만
  갱신하고 media element, 재생 위치, URL은 다시 로드하지 않는다.
- production Edge에서 `Caravan Palace - Suzy.mp3`가 기존 `1:03 / 4:07` 위치를 유지한 채
  실제 640x640 cover와 `Caravan Palace · Caravan Palace`를 표시하는 것을 확인했다.

## Phase 1 - Recently Watching 의미 수정

Status: Completed (2026-08-11)

작업:

- `Recently Watching`을 `lastPlayedAt` 내림차순으로 정렬한다.
- 동일 시각은 play count와 안정적인 content key로 tie-break한다.
- 현재 library에 없는 activity record는 계속 제외한다.
- `Most Played`의 play-count 정렬은 변경하지 않는다.

완료 기준:

- 재생횟수가 적어도 더 최근에 본 영상이 먼저 나온다.
- smart collection unit test와 AppShell drawer test가 label/순서/count를 고정한다.

검증:

- 동일 `lastPlayedAt`은 play count와 content key로 안정적으로 tie-break한다.
- focused 22/22와 frontend 전체 47 files / 507 tests가 통과했다.
- production Edge의 11-item drawer에서 최근 재생 항목이 첫 줄로 이동했다.

## Phase 2 - Image smart collections와 Favorites

Status: Completed (2026-08-11)

작업:

- Image sidebar의 네 `Soon` 버튼을 실제 collection entry로 교체한다.
- Favorites는 image content key 기반 like 상태를 사용하고 image row와 viewer에
  명시적인 favorite toggle을 제공한다.
- Recently Added는 `modifiedAt` 내림차순으로 제한된 항목을 제공한다.
- Screenshots는 root/path의 `Screenshots` directory와 macOS screenshot filename을
  대소문자·Unicode 정규화 후 판정한다.
- Downloads는 configured root의 안정적인 identity를 사용하며 사용자 경로 문자열을
  UI storage key로 복제하지 않는다.
- 네 collection 모두 count, empty state, drawer open, image viewer 이동을 지원한다.

완료 기준:

- Image 메뉴에 `Soon`과 영구 disabled 항목이 남지 않는다.
- favorite가 reload 후 유지되고 경로가 바뀌어도 잘못된 다른 이미지와 합쳐지지 않는다.
- 10k image fixture에서 collection 계산과 drawer 렌더가 bounded임을 검증한다.

검증:

- image identity는 root identity, filename, size, modified time을 조합해 directory 이동 시
  raw path key를 저장하지 않으며 같은 이름의 다른 자산이 단순 병합되지 않게 했다.
- 네 collection은 최대 100개 항목으로 drawer 작업량을 제한하고 10,000-item fixture로
  Recently Added 정렬, Unicode screenshot 판정, hashed Downloads root를 검증했다.
- production Edge에서 `Favorites 0`, `Recently Added 100`, `Screenshots 100`,
  `Downloads 100`이 disabled 없이 표시됐다. Recently Added drawer의 `Open` 항목에서
  image viewer로 이동하고 viewer의 `Add to favorites` toggle까지 확인했다.

## Phase 3 - 음악 More actions 완성

Status: Completed (2026-08-11)

작업:

- disabled `More actions`를 실제 popover/menu로 교체한다.
- 첫 범위는 Add to Playlist, Open stream, Share/Copy stream URL, Track information이다.
- video의 existing open/share fallback을 공통 helper로 재사용한다.
- Web Share/clipboard가 없는 브라우저는 action을 숨기거나 정확한 unavailable 상태를
  표시한다.
- menu focus, Escape, outside click, player dismiss gesture 충돌을 테스트한다.

완료 기준:

- 전체 플레이어 action rail에 이유 없는 disabled control이 없다.
- 각 action이 현재 source만 대상으로 하며 playback을 reload하지 않는다.

검증:

- video와 music이 동일한 open/share-copy helper를 사용하며 Web Share가 없으면 clipboard,
  둘 다 없으면 `Sharing is not available.` 상태를 표시한다.
- Escape와 outside pointer가 popover를 닫고 action rail의 dismiss gesture 차단 계약을
  유지한다. 기존 FullPlayer 40-test suite가 통과했다.
- production Edge full player에서 More actions가 enabled toggle로 렌더되고 Open stream,
  Share or copy stream URL, Track information이 노출되는 것을 확인했다. playlist가 없을
  때는 Music 메뉴에서 먼저 만들라는 정확한 안내를 표시한다.
- mobile full player는 desktop/iPad와 동일하게 content column을 세로 중앙 정렬해
  긴 portrait 화면에서 상단으로 붙고 하단만 비는 회귀를 수정했다. artwork 크기와
  tablet/desktop breakpoint 계약은 변경하지 않았다.
- full/mini player의 like, timer, volume, queue, more, stop, shuffle, repeat 선택 상태는
  터치 영역 전체의 배경·테두리를 칠하지 않고 아이콘 자체만 accent red로 표시한다.

## Phase 4 - Playlist 순서 편집 연결

Status: Completed (2026-08-11)

작업:

- `PlaylistContext`에 repository `moveItem`을 연결한다.
- custom playlist edit mode에서 위/아래 이동 또는 접근 가능한 reorder control을
  제공한다. automatic collection에는 편집 control을 노출하지 않는다.
- 이동 후 drawer item 순서와 실제 `playMusicQueue` seed 순서가 즉시 일치해야 한다.
- 첫/마지막 항목 경계, 중복 방지, 삭제와 이동의 연속 동작을 테스트한다.

완료 기준:

- 저장소에만 존재하던 reorder 기능을 마우스·키보드·터치 UI에서 사용할 수 있다.
- reload 후 저장 순서가 유지된다.

검증:

- custom drawer의 Edit mode에 keyboard 접근 가능한 위/아래 버튼을 추가하고 첫/마지막
  경계는 disabled 처리했다. automatic collection에는 reorder control이 없다.
- 이동 직후 repository 결과를 content-key index로 다시 resolve해 drawer snapshot을
  갱신하므로 이어서 누른 항목의 `playMusicQueue` seed도 같은 순서를 사용한다.
- repository의 중복 방지, 이동, 삭제 후 유지 순서 테스트와 frontend 전체 suite가
  통과했다.

## Phase 5 - 표시 metadata 계약 완성

Status: Completed (2026-08-11)

작업:

- bounded native reader로 우선 M4A title/artist/album/year, MP3 ID3v2
  title/artist/album/year, FLAC Vorbis comment의 같은 필드를 읽는다.
- tag가 없거나 손상되면 현재 filename/path fallback을 유지한다.
- `PlaybackSource`에 album을 전달하고 전체 플레이어, queue, playlist drawer,
  Media Session에서 동일한 title/artist/album 우선순위를 사용한다. 미니 플레이어는
  기존의 제목+재생시간 2줄 계약을 유지하고 album text를 추가하지 않는다.
- video panel은 `Video information`으로 명칭을 바로잡고 현재 indexed year/season/
  episode를 표시한다. 실제 description tag를 읽기 전에는 description이 있다고
  가장하지 않는다.

완료 기준:

- 지원 format마다 동일한 metadata fixture와 corrupt/oversized boundary test가 있다.
- scan 시간과 memory benchmark가 기존 대형 library 계약을 유의미하게 악화시키지 않는다.
- metadata 변경이 content identity, likes, playlists와 activity를 조용히 분리하지 않는다.

검증:

- M4A atom, MP3 ID3v2, FLAC Vorbis comment를 process spawn 없이 읽고 값은 64 KiB,
  전체 tag block은 4 MiB로 제한했다. 각 포맷 title/artist/album/year fixture와 corrupt,
  oversized fallback test가 통과했다.
- current tag key와 과거 filename/artist key를 alias index로 함께 resolve해 기존 likes,
  playlists, activity record가 새 metadata 때문에 사라지지 않게 했다.
- album은 full player, queue, playlist drawer, Media Session에 전달되며 Mini Player에는
  추가하지 않았다. video panel은 `Video information` 의미로 year/season/episode를
  표시한다.
- production 재시작 뒤 실제 대형 library가 정상 로드되고 health가 즉시 OK였으며,
  bounded reader 외 전체 파일 read나 per-file ffprobe는 추가하지 않았다.

## Phase 6 - 재생 선호와 OS queue actions

Status: Completed (2026-08-11)

작업:

- volume, mute, shuffle, repeat preference를 versioned local repository로 저장한다.
- sleep timer와 stop-after-current는 session-only로 유지한다.
- 잘못된/legacy preference는 clamp 후 안전한 default로 복구한다.
- 음악 queue에서 가능한 경우에만 Media Session `previoustrack` / `nexttrack` handler를
  등록하고 queue/source 전환 시 즉시 갱신·정리한다.
- video active 상태에서는 지원하지 않는 queue action을 노출하지 않는다.

완료 기준:

- reload 후 volume/mute/shuffle/repeat가 복원되고 attached audio/video element에
  일관되게 적용된다.
- OS 이전/다음과 앱 queue 버튼이 같은 경계·repeat·stop 정책을 따른다.

검증:

- `music.playback-preferences.v1` repository가 volume/mute/shuffle/repeat만 저장하며
  invalid 값은 clamp/default로 복구한다. sleep timer와 stop-after-current는 저장 문서에
  포함하지 않았다.
- player element attach 시 복원된 volume/mute를 audio와 video 양쪽에 적용한다.
- Media Session 이전/다음은 `previousQueueIndex`와 `explicitNextQueueIndex`로 앱 버튼과
  같은 정책을 사용하며 audio queue 경계와 video 전환 시 handler를 정리한다.
- preferences repository, player store, Media Session focused test와 frontend 전체
  48 files / 511 tests가 통과했다.

## Phase 7 - 검증과 릴리스

Status: Pending

자동 검증:

- Go 전체 test/vet와 변경 package race test
- frontend 전체 test, TypeScript, production build, `git diff --check`
- package/lockfile/settings/PWA cache/README/document `1.4.3` version surface
- 10k music/image와 긴 playlist fixture의 bounded render/collection test

브라우저 검증:

- production Chrome desktop: Music/Video/Image/Settings 전체 navigation
- mobile viewport: image collection drawer, image favorite, More actions, playlist reorder
- Media Session 지원 desktop/Android에서 metadata와 이전/다음
- Web Share/clipboard 지원·미지원 fallback
- reload 뒤 preference와 playlist order 복원

## 범위 제외

- `1.4.2` HLS/fMP4 cache 또는 eligibility 재설계
- codec 재인코딩, adaptive bitrate와 새 video queue
- authentication/public-internet exposure
- playlist/activity의 cross-device server sync 또는 IndexedDB migration
- browser local-file permission persistence
- download 기능 복구
- 실제 tag가 없는 media에 artist/album/description 추정값 생성
