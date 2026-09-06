# Update 1.4.5 - Android Shared UI and Mobile Playback

## 상태

- 작성일: 2026-09-07
- 기준: 1.4.4 최종 웹 UI `c283d52` (PWA r32). 1.4.4 마감 유지.
- 작업 브랜치: `codex/android-shared-web-ui`
- 상태: 개발 브랜치 구현·자동 검증·에뮬레이터 동작 검증 완료. Samsung 설치/실행 완료. 운영 웹 배포 및 실제 개인 라이브러리 사용성 검증은 별도.
- 제품/Web 버전: 1.4.5. Android 개발 APK: 1.4.5-web-dev / versionCode 7.

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

## 검증

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

- `dist/android-shared-web-ui/Muzio-1.4.5-web-dev.apk`
- SHA-256: `ed885d978a52326f278b493212af38f6e13cfedb8534af25129453c16bcf6a78`

## 후속 범위

- 로컬 미디어 재생/접근, 위젯, 더 풍부한 알림 제어, 네이티브 영상 surface, 완전한 process-death 복구는 후속 작업이다.
- 실제 개인 라이브러리의 장시간 재생/배터리 정책/헤드셋·Bluetooth/HLS·seek 사용성은 별도 기기 점검으로 남긴다.
- 이 문서는 현재 세션의 개발 브랜치와 Android APK를 기록한다. main 병합/원격 push/운영 웹 배포 완료를 의미하지 않는다.
