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
