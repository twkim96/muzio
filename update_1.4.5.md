# Update 1.4.5 - Android Shared UI and Mobile Playback

## 상태

- 작성일: 2026-09-07
- 기준: 1.4.4 최종 웹 UI `c283d52` (PWA r32). 1.4.4 마감 유지.
- 작업 브랜치: `codex/android-shared-web-ui`
- 상태: **개발 마감 / Android 실기기 연결·설치 대기**. 최종 구현은 `ba8ac7b`, 문서 정리는 `52f3485`. versionCode13 빌드·에뮬레이터 검증 완료, Samsung 설치 확인은 versionCode11까지다. 사용자가 퇴근 후 연결하면 보관된 versionCode13 APK로 업데이트하고 실사용을 확인한다. 새 기능 개발은 1.4.6으로 이동한다.
- 제품/Web 버전: 1.4.5. Android 개발 APK: 1.4.5-web-dev / versionCode 13 (아래 추가 패치 포함).

## 최초 문서화 이후 추가 개발 요약

- 대조 범위: 최초 1.4.5 문서화 커밋 `02a50f0` 이후부터 `ba8ac7b`까지. 아래 상세 패치 기록을 현재 동작 기준으로 정리했다.
- 1.4.5 최종 웹 배포 기록: PWA `1.4.5-r8` (후속 운영 버전은 1.4.6 문서 참조). 최신 Android 산출물: versionCode 13. 실제 Samsung 설치 확인은 versionCode 11까지이며, 최신 APK 설치는 사용자가 퇴근 후 기기를 연결하면 진행한다.

| 패치 / 커밋 | 추가 개발 및 현재 동작 | 적용 범위 |
| --- | --- | --- |
| r2 / `26aba0b` | 곡 선택 UI를 먼저 갱신하고 네이티브 큐 중복 전달 제거. 로컬 폴더 연결, 네트워크·로컬 통합 목록. 저장소·Online/Offline·Artist 필터와 `#Artist` 검색, Artist 15개씩 더보기. | 곡 선택 최적화·폴더 연결은 앱, 필터·검색은 공통 UI |
| r3/r4 / `3a76f98` | 공유 UI를 운영 웹에도 배포. PC 필터 모달을 넓히고 태그를 축소. 설정에서는 비어 있는 필터 자리를 제거해 상단바를 줄임. | PC·모바일 웹 및 앱 공유 UI |
| r5 / `ec16eb0` | 검색창 아래에 Artist/Storage/Source 후보를 최대 8개 미리보기로 표시하고 결과 목록은 중앙에 유지. 로컬 음악 앨범아트 표시 및 캐시 추가. | 검색은 공통, 로컬 앨범아트는 앱 |
| r6 / `b060fe8` | 슬립타이머와 내부 버튼·입력을 공통 글래스로 통일. 누른 타이머 버튼 바로 위에 배치하고 화면 경계를 벗어나지 않도록 보정. | PC·모바일 웹 및 앱 공유 UI |
| r7 / `e676528` | 필터 헤더를 Queue와 같은 둥근 `Sort` 타이틀·X로 통일. 정렬 기준 6개와 오름/내림 토글을 아이콘 한 줄로 배치. | PC·모바일 웹 및 앱 공유 UI |
| r8 / `ba8ac7b` | 로컬 파일명 목록을 먼저 등록하고 곡 정보를 백그라운드에서 8곡씩 저장. 새 폴더만 탐색, 진행 수 표시, 홈 이동·재시작 후 미완료 작업 재개. | 앱 |

### 최신 동작과 검증 범위

- 음악 원본은 복사하지 않는다. 앱에는 폴더 접근 권한, 곡 목록·메타데이터, 필요할 때 추출한 썸네일을 보관한다. 폴더 제거는 연결 해제이며 원본 파일을 삭제하지 않는다.
- r8부터 새 파일도 메타데이터 스캔 중 커버를 일괄 추출하지 않는다. 화면에 보이거나 선택된 곡의 커버를 필요할 때 읽는다. r5의 일괄 추출 설명은 당시 기록이다.
- r7부터 모바일도 정렬 아이콘 7개가 한 줄이다. r3/r4의 모바일 3열 설명은 당시 기록이며 현재 배치가 아니다.
- 로컬 스캔의 중단·재개는 구현됐지만 재생 큐 전체의 앱 프로세스 종료 후 복구는 후속 범위다. OS가 앱을 종료하면 스캔은 다음 실행에서 이어가며 강제 종료 중 실행을 보장하지 않는다.
- 검증은 아래 패치별 기존 결과를 재사용했다. 최신 r8은 웹 관련 9 tests·Android JVM 13 tests, 웹/APK 빌드, 에뮬레이터 1,001곡 등록·Home·강제 종료 후 재개·처리 중 재생을 확인했다. 이번 문서 정리로 테스트를 다시 실행하지 않았다.
- 1,001곡 기본 목록 저장 1.221초는 합성 파일을 사용한 에뮬레이터 측정이다. 개인 휴대폰의 폴더 선택 후 화면 표시 시간과 대형 라이브러리 사용성은 설치 후 확인할 항목으로 남긴다.
- 웹 배포와 APK 설치는 별개다. 앱은 UI를 APK에 포함하므로 웹 배포만으로 이미 설치된 앱의 UI가 갱신되지 않는다.

## 이번 세션의 변경

### Android와 웹 UI 공유 (`24d78f0`)

- Android branch와 현재 소스를 비교했다. 별도 Compose 화면 대신 현재 React/Tailwind UI를 빌드해 APK에 포함한다. 목록·메뉴·모달·설정·음악·영상·이미지의 UI 소스를 웹과 공유한다.
- 기존 패키지/서버 설정/저장소/ExoPlayer 서비스를 재사용한다. Android 음악은 네이티브 오디오 bridge로 재생하며 큐·반복·슬립타이머·MediaSession/알림 제어를 연결했다.
- 서버 연결 화면, origin 제한, WebView assets 라우팅과 기존 설정 migration을 추가했다. Android Back은 가장 위에 열린 UI부터 닫는다.
- 초기 개발 APK를 기존 앱 삭제 후 설치했고 이후 업데이트는 설정을 유지한 설치로 전환했다.

### 모바일 스크롤과 패널 (`e8b120e` 및 후속)

- 영상 정보창의 첫 위쪽 터치를 JS 스크롤과 혼용하지 않고 브라우저에 맡겨 초기 스크롤 충돌을 해소했다.
- 모바일 영상 화면은 영상만 sticky 처리한다. 제목·정보·목록은 페이지와 함께 스크롤된다. Desktop 배치는 유지한다.
- 1차 sidebar/Queue/playlist/플레이어 패널에 X를 추가하고 2차 패널의 뒤로가기를 유지한다.
- 좌우 swipe는 Music ↔ Video ↔ Image로 이동한다. 최종 패치는 shell 전체로 감지 영역을 넓혀 가장자리·상단 빈 공간·목록 행에서 작동한다. 세로 스크롤, 행의 짧은 탭 및 좋아요/더보기 등 별도 액션을 보존한다.
- 모바일 바텀시트의 제목 pill과 X/뒤로가기, 목록 선택 상태의 Add to Playlist/X 버튼을 20% 줄인다. Desktop 크기는 유지한다.

### 미니바와 슬립타이머 최종 UI

- 제목 metadata를 우선 표시하며 확인된 가수 접두어를 제거한다. 시간 옆에는 가수가 있을 때만 `| 가수명`을 표시한다.
- 제목/진행바 공간을 넓히고 진행바 손잡이가 시작점에서 제목보다 왼쪽으로 넘치지 않도록 한다.
- 모바일 미니바의 타이머는 제거하고 플레이리스트 → 다음 곡 → 재생/일시정지의 세 아이콘을 키운다. 중간 패치의 시계/Queue 순서는 이 최종 배치로 대체한다.
- 플레이리스트 버튼은 저장/자동 재생목록이 있는 탐색 패널을 연다. Queue는 기존 메뉴를 통해 접근할 수 있다.
- 슬립타이머는 전체 플레이어와 desktop 미니바에서 설정하며 공통 반투명 glass 재질을 적용한다.

### Android 자동 PiP

- 실제 재생 중인 web video 상태를 Android에 전달한다. Android 12+는 autoEnter, 이전 버전은 user-leave 이벤트에서 PiP로 진입한다.
- 음악/일시정지된 영상은 자동 PiP 대상에서 제외한다. PiP에는 기존 영상 요소만 표시하고 복귀하면 원래 화면으로 되돌린다.
- PiP가 보이는 동안 재생을 유지하고 보이지 않게 종료되면 web video를 정지한다. 네이티브 음악 background 서비스는 유지한다.

## 최초 공유 UI·모바일 패치 검증

- 공유 UI 초기 검증: 54 files / 575 tests, 후속 native audio/player store 81 tests, Android JVM 7 tests 및 APK build 통과 (`android_app/VALIDATION.md`).
- 1차 모바일 수정: 전체 웹 584 tests, 최종 App 28 tests, APK build 통과. 에뮬레이터 첫 touch scroll 0→133.71px 및 영상 top=0px 확인. Samsung SM-S936N에 1.2.1-web-dev 설치/실행 확인.
- 최종 UI/PiP 전체 웹 검증: 55 files / 592 tests 통과. Android JVM 7 tests, TypeScript/Vite 포함 APK build 통과.
- PiP 창의 visualViewport/layout viewport scale 차이로 발생한 흰 여백을 보정했다. 영향받는 PiP 4 tests 및 최종 APK build 재통과. 이 마지막 보정 외의 검증 입력은 동일하다.
- API 36 에뮬레이터: 영상 재생 → Home에서 실제 pinned PiP 진입. 최종 영상/표면/visualViewport 크기 모두 228.19×128px, 불필요한 여백 없음. PiP 안에서 1.78→12.42초 재생 지속, 앱 복귀 및 PiP 드래그 종료 시 pause 확인.
- 충분히 반영된 일시정지 상태 및 네이티브 음악 재생 중 Home에서는 자동 PiP가 열리지 않는다. 음악은 background에서 playing/82.05초로 계속 재생됨을 확인했다.
- 모바일 412px: mini title/time/track/thumb 시작 x=70.76px 일치, `0:00 : 1:30 | Sample artist` 확인. 버튼은 40px, 아이콘24/24/28px, 타이머 없음. 실제 playlist 버튼으로 navigation 진입 확인.
- 바텀시트 title/X 높이 37.12px 확인 (기존46.4px 대비80%). 실제 행 길게 누르기로 선택 모드 진입 후 Add to Playlist/X 높이32px 확인 (기존40px 대비80%). 상단 바깥쪽 x=18/396px에서 실제 touch swipe로 Music/Video 전환 확인.
- 슬립타이머 computed background rgba(255,255,255,0.24), backdrop blur1.5px/saturate0.9/contrast0.82와 화면 표시 확인.
- 버전 표면 1.4.5 및 diff whitespace 검사 통과. Samsung SM-S936N에 `adb install -r` Success, versionCode7/1.4.5-web-dev와 Activity 실행/프로세스 확인. 개인 미디어 상태를 변경하는 PiP 검증은 Samsung에서 수행하지 않았다.

## 설치 산출물

- 최신: `dist/android-shared-web-ui/Muzio-1.4.5-web-dev-vc13.apk` (24,923,753 bytes).
- SHA-256: `975cd09f0bcb28f64d6ec9dde08083bed99822cf25461c0aa28fbee958c9b1d8`.
- 상태: 빌드·에뮬레이터 설치 완료. 사용자 휴대폰 설치는 퇴근 후 연결 시 진행.
- 최초 1.4.5 산출물(이력): `dist/android-shared-web-ui/Muzio-1.4.5-web-dev.apk` / SHA-256 `ed885d978a52326f278b493212af38f6e13cfedb8534af25129453c16bcf6a78`.
- 패치별 APK와 검증 이력은 아래 기록 및 [Android 검증 문서](android_app/VALIDATION.md)에 보존한다.

## 후속 범위

- 로컬 영상/이미지 재생·자동 감시, 위젯, 더 풍부한 알림 제어, 네이티브 영상 surface, 재생 큐 전체의 process-death 복구는 후속 작업이다. 로컬 목록/메타데이터 스캔의 재개는 r8에서 구현했다.
- 실제 개인 라이브러리의 장시간 재생/배터리 정책/헤드셋·Bluetooth/HLS·seek 사용성은 별도 기기 점검으로 남긴다.
- 이 문서는 현재 세션의 개발 브랜치, Android APK와 아래 운영 웹 배포를 기록한다. main 병합/원격 push 완료를 의미하지 않는다.


## 추가 패치 - 빠른 곡 선택, 로컬 음악 및 통합 필터 (1.4.5-r2)

- Android 큐 선택 시 전체 큐를 queue/load 명령으로 두 번 보내던 경로를 한 번으로 합친다. 선택한 곡/loading UI를 먼저 반영하고 브라우저의 paint 기회를 준 뒤 native 준비를 시작한다. 빠르게 다른 곡을 누른 경우 오래된 play/error가 최신 선택을 덮지 않도록 selection generation을 확인한다.
- 앱 설정 Local Music에서 로컬 전용 SAF 폴더 선택기로 음악 위치를 추가하고 재스캔/제거할 수 있다. 권한과 목록 cache는 기기에 보관하고 메타데이터 스캔은 IO thread에서 수행한다. 파일 삭제 없이 위치만 제거하며 권한 해제/접근 불가 상태를 표시한다.
- 네트워크 snapshot/revision/delta/cache와 로컬 목록을 분리한 뒤 화면에서 합친다. 서버 연결 실패/새로고침 중에도 로컬 목록은 남는다. 기기 파일은 native registry의 ID로만 재생하고 임의 URI를 신뢰하지 않는다. 로컬 진행 상태를 서버 API로 전송하지 않는다.
- Web Reader `src/components/shelf/ShelfFilterModal.tsx`를 읽기 전용 레퍼런스로 사용한다. 정렬을 위쪽, 저장소 그룹/Online·Offline/Artist 태그를 아래쪽에 배치하고 초기화/결과 수 적용 footer를 제공한다.
- Song·Artist·Size·Modified·Library 열 버튼은 보조 정렬/활성 정렬 표시로 유지하고 새 패널과 같은 상태를 사용한다. 같은 facet 안에서는 OR, 서로 다른 facet 간에는 AND를 적용한다. Online은 서버 음악, Offline은 기기 음악이다.
- Artist 태그는 전체 목록을 기준으로 만들고 15개씩 더보기로 확장한다. 검색의 `#Artist`, 알려진 여러 단어 가수명 또는 `#"공백 있는 가수"`를 태그 필터로 해석하며 패널/chip 수정과 동기화한다.
- PWA shell cache 1.4.5-r2, Android versionCode8 / 1.4.5-web-dev. 위젯·로컬 영상/이미지·로컬 커버/자동 감시는 후속 범위로 유지한다.
- 검증: 웹 57 files / 605 tests, Android JVM 10 tests 통과. 진행 상태 test fixture의 TypeScript 필수 필드를 보완한 뒤 해당 7 tests 및 TypeScript/Vite 포함 APK build 통과. 마지막 320px 탭 글자 보정은 App 32 tests와 APK rebuild로 확인했다.
- API 36 에뮬레이터에서 실제 SAF 폴더 추가 → 네트워크 3곡/로컬 1곡 통합 표시 → Offline 필터 → 서버 종료/앱 재시작 후 로컬 재생을 확인했다. 폴더 제거 후 목록에서만 빠지고 원본 MP3는 유지됐다. `#Sample artist` 검색은 해당 로컬/서버 2곡과 Artist 선택 chip에 동기화됐다.
- 합성 4곡 큐의 터치 측정에서 loading UI가 27.4ms, native load 전달이 48.3ms에 발생했고 중복 queue 전달은 없었다. 이는 에뮬레이터 테스트 수치이며 개인 대형 라이브러리의 실측 성능을 뜻하지 않는다.
- 최종 320px 화면에서 Image 탭 끝 213.96px / 필터 버튼 시작 215.96px로 겹침이 없고 문서 폭은 320px이었다.
- Samsung SM-S936N에 최종 APK 업데이트 설치/Activity 실행/프로세스 및 versionCode8을 확인했다. 개인 폴더 선택과 실제 라이브러리 반응 속도는 사용자 기기 사용성 확인으로 남긴다.
- 추가 패치 산출물: `dist/android-shared-web-ui/Muzio-1.4.5-web-dev-vc8.apk` (23,157,603 bytes).
- SHA-256: `32d657ec20bcd532c4336e39dd23e2503d679f52e1a80654096240f3fdd2e0fa`.


## 웹 공통 반영 및 PC 필터·설정 상단바 보정 (1.4.5-r3/r4)

- 운영 웹이 1.4.4-r32 빌드에 머물러 있던 것을 확인하고 현재 공유 React UI를 웹용으로 빌드/배포했다. 필터·태그 검색·모바일 미니바·스크롤/스와이프·패널 변경은 PC/모바일 웹과 앱이 같은 코드를 사용한다. 네이티브 폴더 연결은 앱에서만 표시한다.
- PC 필터 버튼의 상단 섬 위치는 유지한다. Web Reader의 최대 36rem/82dvh 필터 모달을 기준으로 기존 24rem의 좁은 PC 모달을 넓히고, 정렬 6개를 한 줄에 배치하며 태그를 12px/최소32px 칩으로 줄였다. 모바일 시트에는 이 PC 전용 CSS를 적용하지 않는다.
- 이전 605개 웹 테스트 결과 중 변경 없는 기능의 검증은 재사용했다. 상단바 조건 변경 후 App 32 tests, 웹 TypeScript/Vite와 운영 Go build, 버전 표면 검증을 통과했다.
- 배포 후 PC 1440px에서 필터 표시, Artist 더보기 15→30개, Maroon 5 필터 81곡, Song 열의 정렬 상태 동기화 및 #Maroon 5 검색 chip을 확인했다. 412px 모바일 웹에서도 동일한 필터와 검색 선택 상태를 확인했고 가로 overflow가 없었다. 웹 Settings에는 Local Music/로컬 폴더 추가가 표시되지 않는다.
- 최종 PC 모달은 1440×1000 화면에서 576×700px로 표시됐다 (기존384×968px). 기본 15개 태그에서 본문 높이와 scrollHeight가 모두556px로 불필요한 내부 스크롤이 없었다. 모바일412px에서는 기존372px 폭/3열 정렬을 유지한다.
- 운영 HTTPS의 health 정상, PWA cache 1.4.5-r3 및 실제 제공 JS/CSS와 배포 산출물 일치를 확인했다. 같은 공유 UI 소스의 웹 배포이며 앱 전용 네이티브 큐 최적화/자동 PiP는 Android host에서 처리한다.
- 설정 등 라이브러리가 아닌 화면에서는 필터 host를 렌더링하지 않아 빈 자리 없이 상단바가 줄어든다. 실제 웹 측정에서 Music 396.19px → Settings 352.19px이며, 검색 버튼은 유지되고 Music 복귀 시 필터가 다시 나타났다. 최종 PWA cache는1.4.5-r4다.
- Android versionCode9 최종 APK build 및 Samsung 업데이트 설치/Activity 실행을 확인했다. 산출물: `dist/android-shared-web-ui/Muzio-1.4.5-web-dev-vc9.apk` / SHA-256: `802a0c04ddedeb1dc43454aed08d0f1307c7030c4cc0b047d8ace503f8e83d2d`.


## 검색 필터 미리보기·로컬 앨범아트 (1.4.5-r5)

- Web Reader `ShelfSearchModal.tsx`/`shelf/tagSearch.ts`의 태그 후보 구조를 참고했다. 검색창 아래에는 Artist/Storage/Source 필터 후보와 전체 목록 기준 개수만 최대8개 표시하며 음악 결과는 중앙 목록에 남긴다.
- 일반 검색어 및 #부분태그를 지원하고 완전 일치→접두어→부분 일치와 곡 수로 정렬한다. 태그 선택 시 입력 중인 토큰을 완성하고 앞선 검색어/태그와 다른 필터를 유지한다. 검색창을 닫고 중앙 목록에 적용한다. 설정 검색에는 필터 미리보기를 넣지 않는다.
- 검색 후보는 이미 불러온 라이브러리의 facet을 재사용하며 검색할 때마다 서버 요청이나 곡별 추가 조회를 하지 않는다. 새 미리보기3 tests와 기존 LibraryScreen/App을 포함한69 tests, 마지막 통합 App33 tests를 통과했다.
- Android 로컬 음악의 embedded artwork를 최대1024px JPEG로 추출해 앱 내부에 cache한다. 기존 목록은 파일 재등록 없이 썸네일 URL을 보완하고 처음 보일 때 필요한 커버만 추출한다. 새/변경 파일은 metadata scan에서 함께 추출하며 커버가 없는 파일은 기본 아이콘을 유지한다.
- 로컬 커버 요청은 같은 origin/등록된 로컬 ID/현재 폴더 권한을 확인한다. 경로를 웹에서 직접 지정할 수 없고, 폴더 제거·파일 변경 시 오래된 cache를 정리한다. 선택한 곡의 커버는 native Media3 metadata에도 연결한다.
- Native Kotlin compile/JVM10 tests 통과. 웹 PWA cache1.4.5-r5, Android versionCode10.
- 실 웹 PC/412px에서 #부분 Artist 후보, 최대8개 제한, 선택 후 검색창 닫힘/중앙 필터 적용을 확인했다. 모바일 미리보기 x=12..400px로 가로 overflow가 없었다.
- 이전 APK에서 등록한 로컬 폴더를 보존한 업데이트 후 서버를 끈 상태에서 목록/미니바 모두240×240 커버를 표시했고11.38초 재생을 확인했다. 없는 커버/미등록 ID는404, 폴더 제거 후 기존 커버 URL도404이며 원본 MP3는 유지됐다.
- 최종 APK build 및 Samsung versionCode10 업데이트 설치/Activity 실행 확인. 산출물 `dist/android-shared-web-ui/Muzio-1.4.5-web-dev-vc10.apk`, SHA-256 `a8a823503a907ad50ec333f0fef0743323582a0c43eed8195ab2af5f0c06cf69`. 개인 파일의 커버 형식별 호환성은 사용 중 추가 확인한다.


## 버튼 위 슬립타이머 및 글래스 컨트롤 (1.4.5-r6)

- 미니바와 전체 플레이어의 중복 타이머 UI를 공통 패널로 통일했다. 패널뿐 아니라 preset/Cancel/Set/분 입력/X도 공통 글래스 재질을 사용하며 이전 흰색 Set 버튼 스타일을 제거했다.
- 화면 중앙 고정 배치 대신 누른 버튼의 실제 위치를 기준으로12px 위에 표시한다. backdrop-filter가 있는 미니바의 좌표/글래스 중첩 영향을 피하도록 body portal에 표시한다. resize/scroll/visual viewport 변화에 맞춰 위치를 조정하며 위 공간이 부족할 때만 아래쪽으로 배치한다.
- 바깥 클릭/Escape/Android Back 닫기를 유지한다. Escape는 전체 플레이어를 닫지 않고 타이머만 닫고 버튼에 초점을 돌려준다.
- 기존 MiniPlayer/FullPlayer68 tests + 버튼 위치/scroll/내부 동작/Escape 회귀1 test 통과. 공통화 후 남은 미사용 import를 정리하고 TypeScript/Vite/운영 배포 및 APK build 통과.
- 실제 웹1280×900 미니바: panel x837..1173px, button 중심x1005px, 수직 간격12px. 모바일412px 전체 플레이어: panel x12..348px, 수직 간격12px, Escape 후 전체 플레이어 유지. 배경/blur와 반투명 Set 버튼을 computed style 및 화면으로 확인했다.
- 웹 cache1.4.5-r6와 제공 JS/CSS 산출물 일치 확인. Samsung versionCode11 업데이트 설치/Activity 실행 확인.
- 산출물 `dist/android-shared-web-ui/Muzio-1.4.5-web-dev-vc11.apk`, SHA-256 `d2948d0e90953f656f8668cd0a94427e1a5e4d7ee456c8c5f3e1c05778aa9a8d`.


## 필터 헤더 통일 및 한 줄 정렬 아이콘 (1.4.5-r7)

- 필터 상단 제목을 Queue와 같은 둥근 글래스 `Sort` 타이틀과 원형 X 버튼으로 통일했다. 기존 모바일 헤더20% 축소 규칙도 공유한다.
- Latest/Song(또는 Video·Image)/Artist/Size/Modified/Library를 작은 아이콘6개로 바꾸고 오름·내림차순은 같은 줄의 단일 토글 아이콘으로 합쳤다. 선택된 기준은 강조색, 각 아이콘은 접근성 이름과 툴팁을 제공한다. Latest의 최신순 고정 동작은 유지한다.
- 저장소/Source/Artist 필터,15개 더보기, Reset/적용과 중앙 목록의 보조 정렬 표시는 유지한다. PC·모바일 웹 및 Android 번들에 같은 UI를 적용한다.
- LibraryScreen/App68 tests 통과. 방향 토글의 실제 목록 오름/내림 결과와 패널 재진입을 회귀 검증했다. TypeScript/Vite, 운영 웹 배포, APK assembleDebug, 버전 표면 검사 통과.
- 실제 웹412px 화면과 PC1280px 화면 확인.320px에서도7개 버튼의 y좌표가 같고 document 폭320px로 가로 넘침이 없었다. PC 모달576×635px. 웹 cache1.4.5-r7 및 제공 JS/CSS와 배포 산출물 일치 확인.
- Android versionCode12 APK 생성 완료. 현재 adb 연결 기기가 없어 이번 APK의 Samsung 설치/터치 확인은 미실시. 기존 설정과 로컬 폴더는 변경하지 않았다.
- 산출물 `dist/android-shared-web-ui/Muzio-1.4.5-web-dev-vc12.apk`, SHA-256 `155bd8fd127e57ca0e34f291d6a5256ee7477539499ce02ba601df5220391208`.


## 로컬 음악 목록 우선 등록 및 백그라운드 곡 정보 (1.4.5-r8)

- 폴더 선택 시 파일명·크기·수정일·재생 위치를 먼저 등록해 전체 곡 정보/앨범아트 추출이 끝날 때까지 기다리지 않는다. 폴더 추가는 선택한 폴더만 탐색하고 다시 스캔은 등록된 전체 폴더를 탐색한다. 변경되지 않은 파일의 기존 메타데이터는 재사용한다. 음악 원본은 복사하지 않는다.
- 곡 정보는 Activity와 분리한 앱 프로세스 작업에서 순차적으로 읽고, 파일 사이에 쉬면서 8곡씩 저장한다. 남은 항목과 미완료 폴더 탐색을 디스크에 기록해 홈 이동·Activity 재생성·앱 프로세스 종료 후 다음 실행에서 이어간다. 이전 버전에서 폴더 등록만 남은 빈 목록도 최초 한 번 복구 대상으로 처리한다.
- 썸네일은 화면에 표시되거나 선택한 곡에서 필요할 때 추출한다. 메타데이터/썸네일 파일 읽기를 목록 변경용 잠금 밖으로 옮기고, 결과 반영 전 파일 세대와 폴더 권한을 확인해 제거·재등록·재스캔 이후 오래된 결과가 복원되지 않도록 한다.
- 설정에 곡 정보 처리 수와 즉시 재생 가능 안내를 표시한다. 앱 화면이 보이는 동안 미완료 작업이 있으면 2초 간격으로 목록을 갱신하고 완료되면 멈춘다. 다시 화면에 돌아올 때도 최신 상태를 읽는다. 백그라운드 갱신 중 폴더 버튼을 막지 않으며 오래된 응답이 제거된 폴더를 되살리지 않는다.
- 웹 로컬 라이브러리/설정 9 tests와 Android JVM 13 tests 통과. TypeScript/Vite, 웹 배포, Android APK build, 버전 표면 검사 통과. 통합 동시성 검토에서 추가 차단 문제 없음.
- API 36 에뮬레이터의 합성 MP3 1,001개 폴더: 권한 허용 입력 후 1.221초에 기본 목록 1,001곡 저장, 그 시점 pending 1,001 / Artist 완료 0. 이는 목록 저장 시점이며 사용자 기기 UI 표시 시간의 실측은 아니다.
- Home 후 4초에 56곡 처리됨. 강제 종료 동안 pending 945가 유지되고 재실행 후 945부터 처리 재개, 총 73.011초 시점에 1,001곡 모두 Artist 정보 완료. 중간에 pending 233 상태에서 native PLAYING/재생 위치 진행도 확인했다. 테스트 서버 연결이 없는 상태에서 로컬 곡을 재생했다.
- 폴더 파일명 탐색 자체는 여전히 완료를 기다리며, 느린 저장소/문서 공급자에서는 이 단계 지연이 남을 수 있다. OS가 앱 프로세스를 종료하면 다음 앱 실행 시 이어가며 강제 종료 중 실행을 보장하지 않는다.
- 웹 cache 1.4.5-r8 및 제공 JS/CSS와 산출물 일치 확인. Android versionCode13 APK 생성/에뮬레이터 설치 완료. 사용자 요청에 따라 실제 휴대폰 설치는 퇴근 후 연결 시 진행한다.
- 산출물 `dist/android-shared-web-ui/Muzio-1.4.5-web-dev-vc13.apk`, SHA-256 `975cd09f0bcb28f64d6ec9dde08083bed99822cf25461c0aa28fbee958c9b1d8`.
