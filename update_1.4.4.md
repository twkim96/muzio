# Update 1.4.4 - Video Theater Layout and Infinite Scroll

## 상태

- 상태: Closed - 구현, 자동 검증, desktop/mobile viewport 브라우저 검증과 웹 배포 완료
- 작성일: 2026-09-06
- 기준: `1.4.3` (`3dbc3c6`), 이전 릴리스 마감 유지

## 변경

- 영화관 모드의 상단 padding을 제거한다. 접기 버튼은 영상 위에 겹쳐 표시한다.
- 영상 영역을 화면 높이 안에 맞추고 원본 비율을 유지하는 contain으로 가로·세로 한도 안에서 최대화한다. 하단 재생바가 화면 밖으로 밀리지 않는다.
- 영상 정보와 Videos는 아래로 스크롤해 접근한다. 영화관 모드를 끄면 기존 레이아웃과 스크롤 시작 위치로 복원하며 재생 요소를 유지한다.
- Videos는 전체 library snapshot 중 처음 24개를 표시한 후, 끝이 보이면 24개씩 이어서 표시한다. 마지막 항목까지 접근하며 지원되지 않는 브라우저에서도 Load more videos 버튼으로 이어 볼 수 있다.
- 일반 desktop sidebar와 mobile 하단 목록의 실제 스크롤 경계를 관찰한다. backend pagination/API와 재생 source 계약은 변경하지 않는다.
- package/lockfile/settings/service worker/README 버전을 1.4.4로 올린다.

## 검증

- Videos 24 → 48 → 60, observer 종료/뒤늦은 callback 방지, 목록 증가와 fallback 회귀 테스트 통과 (hook 5 tests).
- 영화관 전환·복원, 재생 요소 유지와 목록의 마지막 항목 접근 회귀 테스트 통과 (FullPlayerScreen 41 tests).
- frontend 50 files / 530 tests, TypeScript/Vite production build, Go tests 11 packages, version surfaces, diff check 통과.
- 실제 브라우저에서 발견한 inline-flex baseline의 6.5px 내부 overflow를 영화관 전용 flex/border 보정으로 제거했다. 보정 후 영향받는 41 tests와 production build를 재검증했다.
- 실제 Edge 1920×800 viewport에서 영상 top=0 / bottom=800, seek bar top=715 / bottom=760, object-fit=contain 확인. 상단 padding과 내부 clipping이 없다.
- desktop sidebar 스크롤로 24 → 48, 390×844 mobile viewport의 하단 목록 스크롤로 48 → 72 자동 추가 확인.
- mobile 390×844 영화관 모드에서 영상 top=0 / bottom=844 확인. 작은 layout의 마지막 controls-group 음수 margin을 제거해 seek hitbox까지 화면 안에 유지한다. 보정 후 영향받는 41 tests와 build를 재검증했다.
- 검증된 웹 build를 web_app/dist에 반영했고 production sw.js가 muzio-shell-v1.4.4를 반환한다. backend 변경·재시작 없이 적용했으며 기존 웹 build는 dist/web-backup-1.4.3-*에 보존했다.

## 남은 실기기 점검

- 1.4.3에서 남긴 iPad Safari/PWA 장시간 재생·seek 및 모바일 다음 곡 사용성 확인은 기존 후속 점검으로 유지한다.

## 추가 패치 - 페이지 스크롤과 낮은 창 높이 (동일 1.4.4)

- 일반 모드와 영화관 모드 모두 영상·제목·정보가 페이지와 함께 위로 스크롤된다. 모바일 Videos도 페이지 흐름에 포함하며 일반 desktop Videos의 독립 목록 스크롤은 유지한다.
- 제목, 소스 설명과 Open stream·Share stream의 실제 높이를 ResizeObserver로 측정한다. 창 크기나 제목 줄바꿈에 맞춰 영상 높이를 제한하므로 낮은 창에서도 요약과 액션 공간을 확보한다.
- 영상은 contain 비율로 표시되며 화면 높이가 줄면 영상의 실제 가로폭도 함께 줄어든다. 영화관 모드 상단 padding 제거와 하단 controls clipping 보정은 유지한다.
- 모바일 제목의 위쪽 드래그는 전체 페이지를 스크롤한다. 페이지를 내려 본 상태의 드래그는 접기 제스처가 가로채지 않는다.
- 제품 버전은 1.4.4로 유지하며 PWA shell cache만 1.4.4-r2로 갱신한다.
- 검증 완료: frontend 50 files / 531 tests, TypeScript/Vite build, 1.4.4 version surfaces 통과. Backend는 변경하지 않아 최초 패치의 Go 검증을 재사용한다.
- 실제 Edge 일반 모드 1920×360에서 영상 높이 160px, 제목·액션 마지막 bottom=344px를 확인했다. 영상 위에서 wheel 280px 후 video top=-216px, 정보 panel top=170px로 함께 스크롤된다.
- 실제 Edge 영화관 모드 1920×300에서 영상 높이 164px, 제목 top=180px, 두 액션 bottom=284px로 모두 화면 안에 표시된다. wheel 220px 후 video top=-220px로 자연스럽게 올라간다.
- mobile viewport 390×400에서 3줄 제목을 포함한 summary 높이 172px, 액션 bottom=382.94px로 줄바꿈 후에도 보인다. 목록은 페이지 스크롤로 24 → 48, desktop sidebar에서도 다음 batch로 증가한다.
- 검증된 웹 bundle 배포 완료, 실제 서비스 sw.js에서 muzio-shell-v1.4.4-r2 확인. 기존 최초 패치의 100svh 전체 영상 높이 측정은 이 추가 패치의 최종 크기 계약으로 대체한다.

## 추가 패치 - 페이지 전체 너비 (동일 1.4.4)

- 일반 모드의 96rem 최대 너비 제한을 제거한다. 페이지 스크롤 영역은 화면 전체 폭을 사용하며 오른쪽 스크롤바가 브라우저 콘텐츠 영역 끝에 위치한다.
- 기본 좌우 padding과 Videos 목록 폭은 유지하며 늘어난 폭은 영상 영역에 배분한다. 기존 영상 높이 제한, 제목·액션 공간 확보와 페이지 스크롤 동작을 유지한다.
- 제품 버전은 1.4.4를 유지하고 PWA cache revision을 1.4.4-r3로 갱신한다.
- 검증 완료: FullPlayerScreen 42 tests와 TypeScript/Vite build 통과. 실제 Edge 1720px 화면에서 scroll container left=0 / right=1720 / max-width=none, scrollbar width=15px 확인. 배포된 service worker cache는 1.4.4-r3.

## 추가 패치 - ui-kit 글래스 테마와 상단 탐색 (동일 1.4.4)

- Web Reader ui-kit의 glass 재질, grain 배경과 Pretendard 로컬 폰트를 적용했다. 기존 사용자 지정 색상은 유지한다.
- 상단 Music/Video/Image 바의 왼쪽에 메뉴 아이콘, 오른쪽에 돋보기 검색을 배치했다. 검색 팝업은 입력 포커스, Escape/외부 클릭 닫기, 필터 유지 표시와 초기화를 지원한다.
- 사이드바는 기본 숨김이며 아이콘으로 연다. Settings는 메뉴 하단의 기존 Refresh 자리에 있고 실제 새로고침은 설정 Media Folders에 남아 있다.
- 설정, 재생목록 생성/수정/삭제/추가, Queue, 플레이어 컨트롤/팝오버, 이미지 뷰어 버튼과 비디오 정보까지 공통 재질을 연결했다.
- 메뉴 키보드 포커스 순환, 작은 화면의 상단바, 미니 플레이어 중앙 정렬을 보완했다.
- 검증: frontend 50 files / 530 tests, TypeScript/Vite staging build, version surfaces 통과. Backend는 변경하지 않았다.
- 브라우저: 320px 상단바 horizontal overflow 없음, 390px 검색/메뉴와 desktop 설정/재생목록 생성/음악 플레이어 확인. 1920×360 비디오 페이지 width=1920, 액션 bottom=344, wheel 후 video top=-235로 기존 크기/스크롤 계약 유지.
- 제품 버전 1.4.4, PWA shell revision 1.4.4-r4.
- 배포 완료: 실제 서비스 sw.js는 1.4.4-r4이며 상단바/검색 팝업의 blur(1.5px), saturate(0.9), contrast(0.82)와 로컬 Pretendard 적용을 확인했다. 이전 build는 dist/web-backup-1.4.4-r3-20260906-095638에 보존했다.

## 추가 보정 - 플로팅바와 개별 요소 테두리 제거

- 개별 버튼/행/설정 패널에 새로 추가한 글래스 박스 클래스를 제거해 원래의 컨트롤 표현을 복원했다. 도크, 팝업과 메뉴의 공통 글래스 재질은 유지한다.
- 전체 너비 상단 배경을 없애고 메뉴·Music/Video/Image·검색을 중앙의 플로팅 섬에 배치했다. 메뉴 아이콘은 사이드바 형태로 변경했다.
- 제품 버전은 1.4.4, PWA shell revision은 1.4.4-r5.
- 검증/배포: App·MiniPlayer 39 tests와 production build 통과. 실제 서비스 desktop 중앙 bar width=338px, 320px viewport의 bar width=286px·검색 팝업 좌우 경계 8~296px 확인. 미니 재생 버튼의 border=0px/background=transparent/shadow=none 확인. 1.4.4-r5 웹 배포 완료.

## 추가 보정 - 상단 글래스와 설정 배치

- 상단 플로팅 섬을 kit의 반투명 glass surface, layered shadow와 곡면 edge highlight로 복원했다. 개별 버튼의 박스는 추가하지 않는다.
- 설정 페이지를 중앙 정렬한 반응형 컨테이너로 정리하고 제목과 섹션의 좌우 시작점을 맞췄다.
- 모든 테마에서 grain 배경을 끄고 페이지 및 플레이어의 점무늬 CSS를 제거했다. 저장된 사용자 색상은 유지한다.
- 제품 버전은 1.4.4, PWA shell revision은 1.4.4-r6.
- 검증/배포: Settings·theme 10 tests, TypeScript/Vite build와 버전 검사 통과. 실제 서비스에서 body background-image=none, 상단 blur/반투명/edge highlight 확인. 설정은 desktop 1200px 본문 중앙 정렬, 320px viewport 전체 section 좌우 16~304px 및 horizontal overflow 없음. 1.4.4-r6 배포 완료.

## 추가 보정 - 작은 라이브러리 제목과 검색 섬

- Music/Video/Image 제목을 작은 상단 제목으로 옮겼다. Desktop에서는 탐색 섬과 같은 행의 왼쪽에, 좁은 모바일에서는 겹치지 않게 섬 위에 표시한다.
- 검색은 탐색 섬 아래 약 12px 간격으로 같은 중심선에 표시한다. 높이는 동일한 58px, 폭은 섬보다 약 96px 넓되 화면 여백 안으로 제한하며 둥근 glass 재질과 하나의 입력 면을 사용한다.
- 기존 검색 열기/닫기, 입력 포커스, 필터 유지와 초기화 동작은 유지한다. 제품 버전은 1.4.4, PWA shell revision은 1.4.4-r7.
- 검증/배포: App·LibraryScreen 50 tests, TypeScript/Vite build와 버전 검사 통과. 실제 desktop 제목 20px·탐색 섬/검색창 높이 58px·동일 중심선 확인. 320px 검색창 좌우 12~308px, 가로 넘침 없음 및 Escape 닫기 확인. 1.4.4-r7 배포 완료.

## 추가 보정 - 설정 바로가기와 검색, 미니바 액션

- 상단 오른쪽에 독립된 원형 glass 설정 버튼을 추가하고 Settings도 같은 행의 작은 제목으로 표시한다. 설정 페이지의 큰 제목과 부제는 제거했다.
- 공통 검색 섬을 라이브러리와 설정에서 공유한다. 설정은 한글/영문 메뉴 키워드 검색과 결과 없음/초기화를 지원하며 숨겨진 메뉴의 입력 중 값은 유지한다.
- 미니바 오른쪽 보조 액션은 desktop/mobile 모두 좋아요 → 시계 → Queue로 정렬한다. Desktop 볼륨 및 모바일 다음 곡은 제거하고 기존 desktop 이전/다음과 모바일 재생/일시정지는 유지한다.
- 제품 버전은 1.4.4, PWA shell revision은 1.4.4-r8.
- 검증/배포: App 20, Settings 3, LibraryScreen 31, MiniPlayer 21 tests와 TypeScript/Vite build 통과. 실제 desktop 우측 설정 버튼 58×58px, 폴더 검색 시 Media Folders만 표시 확인. 320px에서 가로 넘침 없음, 미니바 좋아요→시계→Queue→재생 순서 및 PC 볼륨/모바일 다음 곡 제거 확인. 1.4.4-r8 배포 완료.

## 추가 보정 - 컨테이너 폭과 플로팅 곡률

- 하단 미니바는 높이에 비례한 캡슐형 곡률로 변경해 상단 섬과 비슷한 둥근 정도를 적용한다.
- 상단 제목을 별도의 glass 캡슐에 넣고 desktop 설정 버튼을 58px에서 40px로 줄였다.
- 라이브러리와 상단 행을 설정과 같은 max-w-7xl 중앙 컨테이너에 맞췄다. 제목/설정 버튼도 같은 좌우 경계에 놓고 사이드바의 화면 기준 위치와 영상 몰입 화면은 유지한다.
- 제품 버전 1.4.4, PWA shell revision 1.4.4-r9.
- 검증/배포: App·MiniPlayer 41 tests, TypeScript/Vite build와 버전 검사 통과. 실제 desktop 상단/본문 width=1280px 및 같은 좌우 경계, 설정 버튼 40×40px 확인. 사이드바 left=8px 유지, 모바일 390px 넘침 없음과 미니바 캡슐 형태 확인. 1.4.4-r9 배포 완료.

## 추가 보정 - 제목 크기 통일

- 상단 및 사이드바 제목 박스를 상단 섬 높이 58px의 99%인 57.42px로 비율 확대했다. 내부 글자는 확대를 상쇄해 기존 크기를 유지한다.
- 설정 버튼은 desktop 40→44px, mobile 32→36px로 소폭 키웠다. 좁은 화면에서는 확대된 제목과 탐색 섬이 겹치지 않도록 행을 나눈다.
- 사이드바 제목도 같은 크기/재질로 맞추고 편집 버튼은 아래 행에 배치했다. 제품 버전 1.4.4, PWA revision 1.4.4-r10.
- 검증/배포: TypeScript/Vite build 통과. 상단/사이드바 제목 높이 약57.42px와 동일 너비, 텍스트 실측 폭 유지 확인. 320px에서 제목/탐색 섬 겹침과 가로 넘침 없음. 1.4.4-r10 배포 완료.

## 추가 보정 - 제목과 설정 버튼 80% 크기

- 상단/사이드바 제목 박스와 설정 버튼을 탐색 섬 높이 58px의 80%인 46.4px로 통일했다. 제목 글자 크기는 유지하며 설정 아이콘도 버튼에 비례해 조정했다.
- 제품 버전 1.4.4, PWA shell revision 1.4.4-r11.
- 검증/배포: TypeScript/Vite build와 버전 검사 통과. 실제 브라우저 섬 58px, 제목/사이드바 제목/설정 버튼 약46.4px 확인. 1.4.4-r11 배포 완료.

## 추가 보정 - 타이틀로 사이드바 열기

- Music/Video/Image/Settings 상단 타이틀을 버튼으로 만들어 클릭과 키보드로 사이드바를 열 수 있게 했다. 닫을 때 열었던 타이틀 또는 메뉴 버튼으로 포커스를 복원한다.
- 제목/설정 버튼의 섬 대비 80% 크기는 유지한다. 제품 버전 1.4.4, PWA shell revision 1.4.4-r12.
- 검증/배포: App 24 tests와 TypeScript/Vite build 통과. 4개 화면의 제목 클릭/닫기/포커스 복귀 회귀 검증 및 실제 서비스 타이틀 클릭으로 사이드바 표시 확인. 1.4.4-r12 배포 완료.

## 추가 보정 - 열 제목 정렬

- 별도의 정렬 아이콘을 제거하고 Song/Artist/Size/Modified/Library 열 텍스트 클릭으로 정렬한다. 같은 열 재클릭은 방향을 반전하고 작은 화살표로 현재 방향을 표시한다.
- Video/Image와 모바일도 텍스트 정렬 메뉴를 제공한다. 누락된 정렬 값은 양방향 모두 마지막에 표시하며 필터/라이브러리 갱신 시 선택한 정렬을 유지한다.
- 열 제목과 값은 왼쪽 정렬하고 작은 | 구분자를 추가했다. 음악의 desktop 헤더/행 grid 열 위치도 일치시켰다.
- 제품 버전 1.4.4, PWA shell revision 1.4.4-r13.
- 검증/배포: LibraryScreen 31, libraryView 16, App 24 tests와 TypeScript/Vite build 통과. 실제 desktop 열 제목/데이터 좌표 차이 <0.01px, 왼쪽 정렬 및 Size 양방향 정렬 확인. 320px 정렬 메뉴 줄바꿈/가로 넘침 없음. 1.4.4-r13 배포 완료.
