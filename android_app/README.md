# Muzio Android

`android` 브랜치의 네이티브 Android 클라이언트입니다. 2026-07-12 공개 저장소
이력 초기화 때 사라진 기존 Android 브랜치를 현재 `main`의 Muzio 1.3.13 API
계약 위에서 다시 구축합니다.

## 현재 기준선

- 패키지: `com.twkim.videiomusic`
- 버전: `1.1.0-dev` (`versionCode 4`)
- 최소/대상 SDK: 26 / 36
- 도구: Gradle 9.5.1, AGP 9.2.1, Kotlin/Compose 2.4.0
- 기존 `server_profile` DataStore를 그대로 읽어 서버 주소 설정을 보존
- 음악, 영상, 이미지 라이브러리 조회
- 제목 필터와 서버 최신순/이름순 정렬
- 서버 썸네일 표시
- Media3 기반 오디오/비디오 직접 재생
- MediaSessionService 기반 백그라운드 재생과 시스템 미디어 알림
- 필터 결과 기반 음악 Queue, 이전/다음, 랜덤, 반복, Queue 편집
- 현재 곡 후 정지, 서비스 슬립 타이머, 볼륨과 음소거
- 서버 진행률 저장과 웹 정책에 맞춘 이어보기
- content identity 기반 좋아요와 Liked Music
- 사용자 플레이리스트 생성/이름 변경/삭제/항목 편집
- 재생 활동 기반 Most Played와 Recently Watching
- 웹 v1 JSON 호환 재생 활동 가져오기/내보내기
- 음악/영상 행 길게 누르기 다중 선택과 일괄 플레이리스트 추가
- 웹 구조를 옮긴 음악 전체 플레이어와 플로팅 미니 플레이어
- 전체 화면 이미지 보기
- 서버 프로필 저장과 `/healthz` 연결 확인
- 서버 외형 설정과 미디어 폴더/인덱스/파일 감시 설정
- SSE revision 변경분 자동 동기화와 1초→30초 재연결 백오프
- 서버별 음악/영상/이미지 오프라인 스냅샷
- 영상 오류 재시도와 backend fallback 계획 표시
- 외부 플레이어/공유와 16:9 Android PiP
- 영상 정보/자막 메타데이터와 Up Next
- 이미지/음악/영상 전체화면 아래로 끌어 닫기
- 웹 외형 설정을 즉시 반영하는 다크/라이트 및 사용자 색상 테마
- 모바일 라이브러리 메뉴와 웹형 플레이리스트 drawer

## 실기기 확인

2026-07-19 Samsung SM-S936N에서 디버그 APK를 설치해 다음 경로를 확인했습니다.

- 기존 서버 프로필 복원 및 음악/영상/이미지 라이브러리 로드
- 음악 직접 스트리밍 재생과 일시정지
- 홈 화면에서도 재생 유지, 시스템 이전/일시정지/다음 제어
- 2,685곡 Queue 구성과 시스템 다음 곡 전환
- 서버 진행률을 읽은 이어보기 시작
- H.264 영상의 화면/음성 재생
- 이미지 전체 화면 열기와 닫기
- 설정 화면의 `/healthz` 연결 확인
- 비디오 목록 시청률/진행 바와 viewport·정보·다음 영상 목록
- 총 길이가 없는 AAC의 `--:--` 표시와 탐색 비활성화
- 다중 선택, 앱 메뉴, 플레이리스트 브라우저와 Queue
- 미니바 Queue/Timer/Volume 버튼의 대응 패널 직접 진입
- 다크/라이트 preset의 즉시 전체 화면 반영
- 위 경로에서 앱 크래시 없음

구형 MPEG-4 Visual(`video/mp4v-es`) 영상은 기기 하드웨어 코덱에 따라 검은
화면이 될 수 있습니다. 웹의 변환/fallback 상태와 동작을 Android에도 적용해야
하는 확인된 호환성 과제로 관리합니다.

## 빌드와 기기 설치

JDK 21과 Android SDK 36을 사용합니다.

```sh
cd android_app
JAVA_HOME="$HOME/Library/Java/JavaVirtualMachines/ms-21.0.9/Contents/Home" \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
GRADLE_USER_HOME=/private/tmp/vma_gradle_home \
./gradlew :app:assembleDebug

adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.twkim.videiomusic/.MainActivity
```

## 웹 기능 동등성 작업 순서

1. 기능 동등성 표 전체 회귀 검증 — 완료
2. 웹 화면의 리스트/미니바/전체 플레이어/비디오/이미지/설정/플레이리스트 UI 이식 — 완료
3. Android inset/뒤로가기/제스처 및 기기별 충돌 최적화 — 진행 중

각 단계는 웹의 상태 정책을 기준으로 맞춘 뒤 실제 기기에서 Android 제스처,
시스템 UI, 백그라운드 동작에 맞게 디자인과 상호작용을 조정합니다.
