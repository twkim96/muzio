# Update 1.4.6 - Apple Shared Web UI

## 상태 및 기준

- 시작일: 2026-09-07. 기준: Android1.4.5 최종 구현 `ba8ac7b`, 문서 정리 `52f3485`.
- 1.4.5는 개발 마감 / Android 실기기 연결·설치 대기. 보관된 versionCode13 APK는 그대로 두며 사용자 퇴근 후 연결 시 설치한다.
- 1.4.6 범위: iPhone·iPad·Mac용 공유 웹뷰 앱과 네이티브 음악 재생. Android 네이티브 소스/버전은 이번 범위에서 변경하지 않는다.
- 상태: Mac 앱 빌드·실행·서버 연결 확인. iPhone/iPad 공용 소스·Xcode 타깃 구현, **Xcode/iOS SDK 미설치로 iOS 빌드·시뮬레이터·서명·실기기 검증 대기**. 전체 Apple 실기기 완료 또는 App Store 배포로 표시하지 않는다.

## 구현

- `ios_app/Muzio.xcodeproj`에 iOS16+ iPhone/iPad와 macOS13+ 별도 타깃을 만들고 SwiftUI/WKWebView/AVPlayer 소스를 공유한다. 별도 UI 프레임워크/플러그인 의존성은 추가하지 않는다.
- Apple 앱은 서버에 배포된 React UI를 직접 표시한다. Android APK의 정적 UI 번들과 달리 Apple은 현재 서버 UI를 따라가며 첫 실행/화면 로딩에 연결이 필요하다. 목록·검색·필터·설정·글래스·미니바·영상·이미지 UI를 재사용한다.
- 서버 연결/저장/변경, health 확인, 실패 시 재시도 화면을 제공한다. Mac 메뉴의 서버 설정과 새로고침 단축키를 추가했다. iPhone/iPad는 safe area 내에 웹 화면을 배치하고 iPad 회전을 허용한다.
- 네이티브 포트에 platform/capabilities를 추가했다. 기존 Android는 메타데이터가 없어도 기존 기능을 유지한다. Apple은 nativeAudio를 연결하고 localLibrary 요청/폴더 설정 UI를 비활성화한다. 네이티브 웹뷰에서는 서비스워커 등록을 생략한다.
- AVPlayer가 오디오 큐·재생/일시정지/탐색·중복 항목 재정렬·반복·볼륨/음소거·현재 곡 종료 후 정지·슬립타이머를 처리한다. 페이지 재로딩 동안 앱 프로세스의 플레이어를 유지하고 최신 상태를 다시 연결한다.
- Now Playing 및 시스템 재생/이전/다음/탐색 명령을 연결했다. iOS 오디오 세션·백그라운드 오디오·인터럽트/헤드폰 제거 처리를 추가했다. 영상 재생 보고 시 네이티브 음악을 멈춘다. 잠금화면 앨범아트는 아직 추가하지 않았다.
- 브리지는 지정한 서버 origin의 최상위 앱 문서에서만 수신한다. 외부 링크는 시스템 브라우저로 연다. 오디오 URI는 전달된 임의 URL 대신 서버 mediaId로 조립한다. 로컬 ID는 거부하고 비동기 재생/seek 결과는 선택 세대를 확인한다.
- HTTPS 인증서 검증은 시스템 기본값을 사용한다. health 리다이렉트, 주소 내 계정 정보·query·fragment·비루트 경로를 허용하지 않는다. 로컬 네트워크 용도를 명시하고 공용 HTTP/인증서 전역 우회는 넣지 않는다.

## 검증

- 웹 브리지/플랫폼/서비스워커/설정/네이티브 오디오 5 files / 28 tests 통과. TypeScript/Vite 및 운영 배포 완료. Android 기본 capability 동작 유지 확인.
- macOS13 타깃으로 전체 Swift 앱 컴파일·ad-hoc 서명 성공. Xcode 프로젝트와 iOS/Mac Info.plist 문법 검사 통과. iOS SDK 타입 검증을 대체하는 결과는 아니다.
- ServerPolicy 실행 검사: 주소 정규화, 기본 포트, 잘못된 scheme·credentials·경로/query/fragment, 다른 origin·port 및 비앱 문서 차단 확인.
- 실제 macOS AVPlayer와 합성 무음 WAV/HTTP Range 서버: paused load/1.5초 재개 위치, play 진행, seek/pause, 중복 queueEntryId 재정렬 시 위치 유지, 설정, 브리지 polling 없는 sleep 만료 이벤트, clear, 로컬 source 거부 및 외부 URL 무시 확인. fixture/서버는 종료 후 정리했다.
- 통합 검토에서 서버 재연결 시 이전 WKWebView가 남는 SwiftUI identity 문제를 수정했다. 재연결 후 새 음악 화면과 웹 Settings의 Change server → 네이티브 설정 시트를 확인했다.
- 실제 Mac 앱에서 서버 연결 → 음악 목록 → Sort 글래스 모달 → 닫기 → Settings 이동 확인. 설정에 Local Music 기능이 없고 서버 변경이 제공됨을 확인했다. 사용자 음원을 검증 목적으로 재생하지 않았다.

## 산출물 및 남은 작업

- 운영 웹 PWA `1.4.6-r1`의 health 정상 및 실제 제공 JS/CSS와 빌드 산출물 일치 확인.
- Mac: `dist/apple/Muzio.app` (현재 빌드 머신 arm64용, 로컬 ad-hoc 서명). 배포용 공증/스토어 배포는 하지 않았다.
- iPhone/iPad: `ios_app/Muzio.xcodeproj`의 `Muzio-iOS` scheme. Xcode/iOS runtime 설치와 signing Team 설정 후 빌드·기기 실행이 필요하다. IPA는 아직 생성되지 않았다.
- Apple 로컬 폴더/오프라인 목록, 위젯, 전체 process-death 재생 큐 복구, 잠금화면 커버는 후속 범위다.
- iOS 영상 inline/PiP 허용 설정은 들어갔지만 Home 자동 PiP와 복귀·종료, 백그라운드 오디오, 실제 미디어 키/인터럽트, 다양한 파일 형식은 Apple 실기기 검증이 남아 있다.
- 상세 계약·빌드 명령: [Apple 앱 README](ios_app/README.md).

- Mac 압축 산출물: `dist/apple/Muzio-1.4.6-macOS-arm64.zip`, SHA-256 `fa7b51c1a280ea2c379dc531b701bc88393e6fada6348e9b66dc1d466cf67671`.

## 추가 수정 — 음악 목록 가독성

- 음악 첫 줄은 메타데이터 제목을 표시하고, 제목이 없으면 경로를 제외한 파일명을 사용한다. 모바일과 PC에 공통 적용한다.
- 모바일에서 숨긴 더보기 버튼의 예약 폭을 제거해 제목과 보조 정보에 공간을 돌려준다.
- 모바일 두 번째 줄을 `가수 | 용량 | 위치(저장소)`로 정리했다. 날짜를 제외하고 가수·용량·위치를 한 줄에 자연스럽게 이어 표시한다. 후속 요청에 따라 항목별 폭 제한/말줄임을 없앴고, 앨범 이미지와 하트 사이의 공간을 모두 사용하되 오른쪽 경계를 넘는 텍스트만 숨긴다. 모바일 제목도 같은 방식으로 표시한다. PC의 개별 정보·정렬 열은 유지한다.
- 빌드 정책: 앞으로 네이티브 앱은 버전 변경 시 변경사항을 모아 1회 빌드한다. 이 추가 수정에는 Android/iOS/Mac 앱 빌드를 실행하지 않는다. Android 번들 UI는 다음 버전 APK에 포함한다.
- 검증: LibraryScreen 36 tests 통과, TypeScript/Vite 및 웹 배포 완료(`1.4.6-r2`). 운영 health 200·JS/CSS 일치, 412px 모바일 화면에서 제목 폭 256px·액션 영역 36px·가로 넘침 없음 확인. 네이티브 앱 산출물은 재생성하지 않았다.
- 후속 레이아웃 검증: 웹 `1.4.6-r3` 배포 및 TypeScript/Vite 통과. 모바일 412px 화면에서 항목별 말줄임 없이 한 줄의 오른쪽 끝만 가려지는 스타일을 확인하고, 운영 health/JS/CSS 일치를 확인했다. 앱 빌드는 생략했다.
