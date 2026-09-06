> Historical Compose-client checklist. The shared web UI host supersedes this UI implementation; see [README.md](README.md) for current scope and acceptance boundaries.

# Web → Android 기능 동등성

웹 구현을 기능 계약의 기준으로 삼습니다. 기능 연결과 첫 UI 이식을 완료했으며,
같은 컴포넌트 단위로 실기기에서 화면을 비교하며 세부 간격과 Android 상호작용을
계속 보정합니다.

상태 표기: `완료`, `진행 중`, `대기`

## 재생과 진행률

| 기능 | 상태 | Android 기준 |
| --- | --- | --- |
| 음악/영상 직접 스트리밍 | 완료 | Media3 단일 세션 |
| 백그라운드 재생 | 완료 | `MediaSessionService`가 플레이어 소유 |
| 시스템 알림/잠금화면 제어 | 완료 | MediaSession 큐와 연결 |
| 오디오 포커스/이어폰 분리 | 완료 | Media3 자동 오디오 포커스 처리 |
| 음악 큐 생성과 자동 다음 곡 | 완료 | 현재 필터 결과로 Media3 타임라인 구성 |
| 이전/다음 곡 | 완료 | MediaSession 기본 명령 |
| 서버 진행률 10초 주기 저장 | 완료 | `/api/progress/{mediaId}` |
| 일시정지/종료 시 진행률 저장 | 완료 | 서비스 수명과 Player 이벤트에서 flush |
| 이어보기 위치 적용 | 완료 | 웹과 같은 30초/95%/잔여 10초 정책 |
| 큐 보기/편집/순서 이동/다음 재생 | 완료 | Queue 화면에서 재생/이동/삭제/비우기 |
| 랜덤/반복 없음·전체·한 곡 | 완료 | MediaSession 상태와 전체 화면 제어 연결 |
| 현재 곡 후 정지 | 완료 | 서비스의 항목 끝 일시정지 정책 |
| 슬립 타이머 | 완료 | 서비스 소유 타이머, 초 단위 상태와 자동 일시정지 |
| 볼륨/음소거 | 완료 | 음소거 해제 시 기존 볼륨 복원 |
| 네트워크 재시도/진단 | 완료 | 온라인 상태 분류, 오류 메시지, 직접 재시도 |
| 포맷 fallback | 완료 | `/api/fallback/{mediaId}` 계획과 상태 표시 |

## 라이브러리와 컬렉션

| 기능 | 상태 | Android 기준 |
| --- | --- | --- |
| 음악/영상/이미지 목록 | 완료 | 현재 backend 계약 사용 |
| 썸네일 | 완료 | 서버 thumbnail URL 사용 |
| 필터 | 완료 | 제목/이름/경로/아티스트/앨범 검색 |
| 최신순/이름순 | 완료 | 서버 최신순 유지/이름 정렬을 웹 정책과 동일 적용 |
| 라이브러리 새로고침 | 완료 | 수동 전체 재조회 |
| SSE 변경분 동기화 | 완료 | revision, affectedTypes, delta/reset, 지수 백오프 |
| 오프라인 스냅샷 | 완료 | 서버별 음악/영상/이미지 원자적 파일 캐시 |
| 길게 눌러 다중 선택 | 완료 | 이미지 제외, 선택 항목 일괄 플레이리스트 추가 |
| 좋아요 | 완료 | 웹과 같은 content identity 기반 DataStore 저장 |
| 사용자 플레이리스트 CRUD | 완료 | 생성/이름 변경/삭제/항목 추가·제거 |
| Liked Music | 완료 | 스마트 컬렉션 |
| Most Played | 완료 | 재생 활동 기반 상위 50개 |
| Recently Watching | 완료 | 영상 활동 기반 최근 50개 |
| 이미지 메뉴 자리표시자 | 완료 | 웹도 현재 Favorites/Recently Added/Screenshots/Downloads 정적 메뉴만 제공 |

## 전체 화면과 플랫폼 기능

| 기능 | 상태 | Android 기준 |
| --- | --- | --- |
| 이미지 전체 화면 | 완료 | 원본 이미지 열기/닫기 |
| 음악 전체 플레이어 | 완료 | 큰 정사각 아트워크, 동작 rail, scrubber, transport, Queue |
| 영상 시청 화면 | 완료 | 정보/Up Next/fallback/공유/외부 열기 적용 |
| 위치 탐색 | 완료 | 음악 커스텀 scrubber와 영상 Media3 컨트롤; 길이 미확인은 `--:--` 처리 |
| 자막 메타데이터 | 완료 | 웹과 동일하게 sidecar 목록/언어/label 표시; 웹에도 재생 endpoint는 없음 |
| PiP | 완료 | 16:9 명시 진입, 실기기 pinned task 확인 |
| 외부 플레이어/공유 | 완료 | Android chooser와 share sheet 사용 |
| 아래로 끌어 닫기 | 완료 | 이미지/음악/영상 공통 threshold gesture, 이미지 실기기 확인 |

## 설정과 진단

| 기능 | 상태 | Android 기준 |
| --- | --- | --- |
| Android 서버 프로필 | 완료 | 기존 1.0.2 DataStore 마이그레이션 유지 |
| 백엔드 연결 확인 | 완료 | `/healthz` |
| 백엔드 상태 상세 | 완료 | health 결과, index/watcher/degraded/manual-refresh 진단 |
| 미디어 폴더 조회·수정·새로고침 | 완료 | `/api/settings/media-roots` |
| 인덱스/워처/저하된 루트 정보 | 완료 | 웹 Runtime Notes와 동일 데이터 |
| 외형 설정 조회·수정·초기화 | 완료 | `/api/settings/appearance` |
| 활동 데이터 가져오기/내보내기 | 완료 | 웹 v1 JSON 호환, Android 문서 열기/저장 선택기 |

## UI 동등성 상태

다음 웹 컴포넌트의 첫 Android 이식을 완료했습니다.

1. 앱 셸: 상단 segmented tabs, 모바일 peek drawer, 배경/blur/색상
2. 리스트: 헤더, 검색, 정렬, 행 높이와 열, 썸네일, 진행률, 옵션 메뉴
3. 미니 플레이어: 아트워크, 메타데이터, 상태/오류, 재생 제어
4. 음악 전체 플레이어: 아트워크, 동작 메뉴, scrubber, transport, Queue
5. 영상 시청 화면: viewport, 정보, 설명, Up Next, fallback
6. 이미지 뷰어와 설정/진단/플레이리스트 drawer 및 modal

Android 시스템 inset, 뒤로가기, 제스처, 알림, PiP만 플랫폼 규칙에 맞게 조정하고
정보 구조와 시각적 표현은 웹을 그대로 기준으로 합니다.

2026-07-19 Samsung SM-S936N 실기기에서 목록/진행률/다중 선택, 미니바,
음악 전체 플레이어와 Queue, 비디오 viewport·정보·목록, 이미지 뷰어, 설정 연결
확인, 앱 메뉴와 플레이리스트 브라우저를 회귀 검증했습니다. 삼성 Edge 패널과
겹치지 않도록 앱 메뉴 핸들은 화면 안쪽에 배치했습니다. 미니바의 Queue, Timer,
Volume 버튼은 각각 대응 전체 플레이어 패널로 바로 진입합니다.
