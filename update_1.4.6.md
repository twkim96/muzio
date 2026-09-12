# Update 1.4.6 - Apple Shared Web UI

## 상태 및 기준

- 시작: 2026-09-07. 최종 개발 마감: 2026-09-08. 기준: Android1.4.5 최종 구현 `ba8ac7b`, 문서 정리 `52f3485`.
- **1.4.6 최종 마감(2026-09-08)**. 웹·Android·iPhone/iPad·Mac 표시 버전1.4.6, 웹 UI 캐시r20. Android versionCode14, Apple 내부 빌드1.
- 현재 범위: Apple 공유 웹뷰 앱·네이티브 음악·로컬 음악, 공유 웹 영상 플레이어, 플랫폼 공통 필터·영상 UI, Android AAC 길이/탐색·영상 인덱스 캐시·가로 전체화면 복구.
- 최신 검증: 2026-09-08 iPad 공유 웹 영상 복귀본 설치·실행 성공, iOS 서명 빌드/macOS 컴파일 통과. Android 가로 전체화면 수정본은 JVM25개·APK 빌드·API36 에뮬레이터 검사를 통과했으며 실제 폰 설치는 대기 중이다. 09-07 Android 설치 기록은 이전 산출물의 이력이다. App Store 배포·공증·전체 실기기 기능 수용 완료를 뜻하지 않는다.
- 현재 Apple 영상은 공유 웹 플레이어로 복귀했고 자동 PiP는 제외했다. 네이티브 음악·로컬 곡과 영상 인덱스/시작 데이터 캐시는 유지한다. 아래 초기 네이티브 영상/PiP 기록은 당시 이력이다.
- 남은 확인: 웹 플레이어 복귀 후 iPad 연속 영상·오디오, A→B→A 체감 지연, 영상 탭/전체화면/탐색 조합 및 Android 가로 전체화면의 실기기 사용자 수용. Android 재진입 metadata 약6.4초→1.05초는 실측했지만 최초 캐시 생성 비용은 남는다. 사용자 요청으로 실기기 확인은 [1.4.7 이월 검증](update_1.4.7.md)으로 옮겼다. 1.4.6 개발은 마감하며 미확인 동작을 해결 완료로 표시하지 않는다.
- 아래 구현·검증·산출물 항목은 개발 시점별 이력이다. 초기 SDK 미설치/이전 캐시 버전/초기 산출물 기술보다 문서 상단과 마지막 마감 기록이 현재 상태를 우선한다.

## 구현

- `ios_app/Muzio.xcodeproj`에 iOS16+ iPhone/iPad와 macOS13+ 별도 타깃을 만들고 SwiftUI/WKWebView/AVPlayer 소스를 공유한다. 별도 UI 프레임워크/플러그인 의존성은 추가하지 않는다.
- Apple 앱은 서버에 배포된 React UI를 직접 표시한다. Android APK의 정적 UI 번들과 달리 Apple은 현재 서버 UI를 따라가며 첫 실행/화면 로딩에 연결이 필요하다. 목록·검색·필터·설정·글래스·미니바·영상·이미지 UI를 재사용한다.
- 서버 연결/저장/변경, health 확인, 실패 시 재시도 화면을 제공한다. Mac 메뉴의 서버 설정과 새로고침 단축키를 추가했다. iPhone/iPad는 safe area 내에 웹 화면을 배치하고 iPad 회전을 허용한다.
- 네이티브 포트에 platform/capabilities를 추가했다. 기존 Android는 메타데이터가 없어도 기존 기능을 유지한다. Apple은 nativeAudio를 연결한다. 초기 구현에서는 localLibrary를 비활성화했으며, 아래 후속 로컬 음악 구현에서 활성화했다. 네이티브 웹뷰에서는 서비스워커 등록을 생략한다.
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
- Apple 로컬 폴더/목록은 아래 후속 구현에 추가했다. 완전 오프라인 UI 시작, 위젯, 전체 process-death 재생 큐 복구, 잠금화면 커버는 후속 범위다.
- iOS 영상 inline/PiP 허용 설정은 들어갔지만 Home 자동 PiP와 복귀·종료, 백그라운드 오디오, 실제 미디어 키/인터럽트, 다양한 파일 형식은 Apple 실기기 검증이 남아 있다.
- 상세 계약·빌드 명령: [Apple 앱 README](ios_app/README.md).

- Mac 압축 산출물: `dist/apple/Muzio-1.4.6-macOS-arm64.zip`, SHA-256 `fa7b51c1a280ea2c379dc531b701bc88393e6fada6348e9b66dc1d466cf67671`.

## 추가 수정 — 음악 목록 가독성

- 음악 첫 줄은 메타데이터 제목을 표시하고, 제목이 없으면 경로를 제외한 파일명을 사용한다. 모바일과 PC에 공통 적용한다.
- 모바일에서 숨긴 더보기 버튼의 예약 폭을 제거해 제목과 보조 정보에 공간을 돌려준다.
- 모바일 두 번째 줄을 `가수 | 용량 | 위치(저장소)`로 정리했다. 날짜를 제외하고 가수·용량·위치를 한 줄에 자연스럽게 이어 표시한다. 후속 요청에 따라 항목별 폭 제한/말줄임을 없앴고, 앨범 이미지와 하트 사이의 공간을 모두 사용하되 오른쪽 경계를 넘는 텍스트만 숨긴다. 모바일 제목도 같은 방식으로 표시한다. PC의 개별 정보·정렬 열은 유지한다.
- 빌드 정책(2026-09-07 재정립): 네이티브 변경 시 Android·iOS·macOS의 영향받는 타깃 컴파일과 관련 테스트를 수행한다. 설치·배포 패키징은 버전 마무리 때 타깃별 1회로 모은다. 실기기 검증은 별도이며, SDK 미설치 타깃은 미검증으로 명시한다. 상세 기준은 [AGENTS.md](AGENTS.md)를 따른다. Android 번들 UI는 다음 버전 APK에 포함한다.
- 검증: LibraryScreen 36 tests 통과, TypeScript/Vite 및 웹 배포 완료(`1.4.6-r2`). 운영 health 200·JS/CSS 일치, 412px 모바일 화면에서 제목 폭 256px·액션 영역 36px·가로 넘침 없음 확인. 네이티브 앱 산출물은 재생성하지 않았다.
- 후속 레이아웃 검증: 웹 `1.4.6-r3` 배포 및 TypeScript/Vite 통과. 모바일 412px 화면에서 항목별 말줄임 없이 한 줄의 오른쪽 끝만 가려지는 스타일을 확인하고, 운영 health/JS/CSS 일치를 확인했다. 앱 빌드는 생략했다.

## 추가 수정 — 원본 영상 탐색의 전체 다운로드 전환 방지

- `아리사 - 올림푸스 같이보기 오픈런 - CHZZK.mp4`(14.1GB, 12시간 28분)를 Mac Edge에서 측정했다. 6시간 위치의 Range 요청이 `206` 대신 `200` 전체 응답으로 전환되어 34.4초 동안 2.26GB를 보내고도 목표 화면이 나오지 않았다.
- 원본 미디어의 weak ETag를 브라우저가 후속 요청의 `If-Range`에 사용하는 조합이 원인이었다. `/api/media/{id}`는 weak ETag를 제공하지 않고 `Last-Modified`로 검증한다. 일치하는 수정 시각의 탐색은 `206`으로 처리하고, 변경된 파일이나 유효하지 않은 검증값은 기존 HTTP 조건부 요청 규칙을 유지한다. 임의로 `If-Range`를 무시하거나 weak ETag를 강한 검증값으로 취급하지 않는다.
- 네트워크 원본 재생 URL에 고정 `?v=2`를 붙여 이전 weak ETag가 남은 브라우저 캐시와 분리한다. 재생 내역 복원과 `#t=` 이어보기는 같은 빌더를 사용하며 mediaId/진행률 저장 키는 바꾸지 않는다. Android 로컬 영상 URL과 최적화 복사본의 불변 URL은 유지한다. 웹 서비스워커는 `1.4.6-r4`로 갱신한다.
- 회귀 검증은 최초 응답의 검증값으로 후속 탐색하기, 실제 파일 변경 후 전체 응답으로 전환하기, 수정 없는 파일의 `304`, 오래된 날짜·기존 weak ETag·다른 ETag의 조건부 요청, 네트워크/로컬 URL과 이어보기 fragment를 포함한다.
- 자동 검증: 문제를 재현하는 조건부 탐색 테스트의 수정 전 실패(`200` 전체 응답)와 수정 후 통과(`206`)를 확인했다. Go 전체 테스트(11 packages)·vet, TypeScript/Vite, 1.4.6 버전 검사 통과. 프론트 전체 실행 후 URL 기대값을 갱신한 관련 6 files/221 tests가 통과했다. 전체 병렬 실행에서 시간 초과한 `nativeLocalLibrary`는 코드/테스트 변경 없이 단독 6 tests 통과했으며, 최초 통과 파일과 합쳐 60 files/623 tests를 확인했다.
- 운영 배포: `scripts/deploy_local.sh`로 설치 후 실제 Control Server 관리 서비스 `server-control--muzio`를 재시작했다. 운영 health 정상, 제공 JS/CSS와 빌드 파일 일치, 서비스워커 `1.4.6-r4`를 확인했다.
- 운영 직접 재생 검증: Mac Edge에서 같은 영상의 `/api/media/{id}?v=2`에 직접 HTTPS/HTTP2로 연결했다. 처음 열어 6시간 지점의 목표 프레임까지 **1.222초**(metadata 1.163초), 이후 11시간 탐색 **0.042초**, 1시간 역방향 탐색 **0.053초**였다. 서버 로그의 최초·이어보기·앞/뒤 탐색 요청 네 건 모두 `206`으로 유지됐다. 시험용 중계 없이 HTML video의 목표 프레임 표시를 측정했으며, 전체 Muzio UI 조작 시간이나 모바일 실측을 뜻하지 않는다. 사용자 재생 내역은 유지했고 임시 페이지/진단 쿠키는 정리했다.
- 버전은 `1.4.6`을 유지하며 네이티브 앱은 재빌드하지 않았다. 브라우저와 서버 UI를 사용하는 Apple 앱은 페이지를 새로고침하면 새 URL을 사용한다. Android APK의 번들 UI에 대한 URL 변경은 다음 APK 빌드에 포함되므로 기존 앱의 캐시 전환까지 완료된 것으로 표시하지 않는다.
- 이 파일의 82MB front-moov 인덱스 다운로드 비용은 별도다. 이번에는 HLS 생성·영상 재인코딩·원본 변경을 하지 않는다. 외부 네트워크의 실제 모바일 체감 성능은 기기 검증이 남아 있다.

## 추가 수정 — 영상 인덱스 로컬 LRU 캐시

- 버전은 `1.4.6`을 유지한다. 웹은 최근 **2개**, Android·Apple 앱 소스는 최근 **5개**의 인덱스를 저장한다. 다시 사용하는 항목은 최근 사용 순서로 올리고, 한도를 넘으면 가장 오래 사용하지 않은 항목을 삭제한다. 영상 전체를 저장하는 기능은 아니다.
- 지원 대상은 원본 MP4/MOV의 앞쪽 `moov` 인덱스다. 인덱스가 끝나는 위치까지의 파일 앞부분만 저장하며, 항목당 **128 MiB**, 웹 합계 **256 MiB**, 앱 합계 **640 MiB**를 상한으로 둔다. 끝에 인덱스가 있는 파일, fragmented MP4, 다른 형식, 상한 초과 파일은 기존 스트리밍을 사용한다. 원본 파일과 재생 내역의 식별자는 바꾸지 않는다.
- 서버는 `/api/media/{id}?index=manifest`로 크기·수정 시각 기반 revision과 인덱스 범위를 제공한다. 인덱스를 재사용할 때 작은 manifest로 원본 변경을 확인하며, `index=data&revision=...`는 해당 인덱스만 전송한다. 캐시 뒤에 연결하는 영상 바이트에도 revision을 검증해 서로 다른 파일 버전이 섞이지 않게 한다. 바뀐 revision이나 불완전·손상된 저장 항목은 재사용하지 않는다.
- 웹은 IndexedDB에 실제 인덱스 Blob을 저장하고 서비스워커가 영상의 Range 요청에 공급한다. 최근 사용 시각과 Blob을 별도 저장소로 분리하여 탐색할 때 큰 인덱스를 다시 쓰지 않는다. 기존 캐시 저장 구조도 보존하여 이전한다. 저장된 인덱스 밖으로 탐색하면 최근 사용 순서만 갱신하고 해당 영상 구간을 직접 요청하므로 매번 인덱스나 manifest를 다시 다운로드하지 않는다.
- 캐시에서 만든 부분 응답과 일반 네트워크 탐색 응답을 함께 사용할 수 있도록 웹 영상에 `crossOrigin="anonymous"`를 지정했다. 아직 새 화면을 로드하지 않은 기존 no-CORS 영상 요청은 직접 스트리밍을 유지한다. 서비스워커는 **`1.4.6-r6`**이다. 캐시 저장 실패·지원하지 않는 요청·조건부 요청은 기존 HTTP 동작으로 돌아간다.
- Android는 신뢰한 서버의 원본 미디어 요청에 한해 WebView 응답을 연결하고 앱 캐시 디렉터리에 저장한다. Apple은 서버 화면의 origin을 유지하면서 토큰이 있는 loopback 영상 프록시와 앱 디스크 캐시를 사용한다. 임의 외부 URL 프록시나 인증서 우회는 추가하지 않는다. Apple 재생 경로가 실패하면 원본 URL로 한 번 복귀하며, 이어보기·탐색 위치·재생/일시정지 상태를 유지한다.
- Apple의 2-byte 초기 확인 요청은 인덱스를 내려받지 않고 전달한다. 서버를 전환할 때는 같은 캐시 소유자와 다운로드 잠금을 공유해 진행 중인 임시 파일을 다른 연결이 지우지 않게 했으며, 종료된 프록시의 연결·리스너를 정리한다. 작은 확인 요청·조건부 요청의 `412` 보존·서버 전환 중 임시 파일 유지·프록시 해제 회귀 검사도 통과했다.
- 웹 화면/탭을 닫아도 저장한 인덱스는 다음 재진입에 사용할 수 있다. 다만 LRU 밀어내기, 사이트 데이터/앱 캐시 삭제, 브라우저·OS의 저장 공간 회수, 원본 변경 시에는 다시 받아야 한다. 인덱스가 있어도 실제 영상 구간 다운로드와 인덱스 해석·디코딩 시간은 필요하다.
- 자동 검증: Go 전체 11 packages 및 vet 통과. 최종 웹 관련 **9 files / 157 tests**, TypeScript/Vite, 1.4.6 버전 검사 통과. Android 캐시 **5 JVM tests**와 Kotlin 컴파일 통과(`-x buildSharedWeb`). Apple 프록시의 구성·재사용·revision·조건부 요청·취소·LRU·손상 복구 fixture 검사 및 macOS 13 대상 Swift 타입 검사 통과. iOS SDK 검증을 대체하지 않는다.
- 운영 웹/서버 배포 후 관리 서비스 `server-control--muzio`를 재시작했고 health·제공 JS/CSS·서비스워커/캐시 helper의 빌드 파일 일치를 확인했다. Mac Edge의 실제 82,125,982-byte 인덱스로 최초 `miss`, 탭을 닫고 다시 연 후 저장 구조 이전을 거쳐 `hit`, 실제 IndexedDB의 최근 사용 승격·2개 밀어내기·revision 무효화를 확인했다. 최종 직접 HTTPS 재생은 캐시를 사용한 6시간 이어보기 첫 프레임 **0.862초**, 11시간 탐색 **0.158초**, 1시간 역방향 탐색 **0.047초**였다. 측정용 HTML video를 사용했으며 모바일 네트워크/앱 실측을 뜻하지 않는다. 진단 페이지는 진행률을 저장하지 않는다.
- **네이티브 패키지는 재빌드하지 않았다.** 현재 설치된 Android/iOS/Mac 앱에 5개 캐시가 적용된 것으로 표시하지 않는다. 네이티브 호스트 변경은 다음 앱 빌드에 포함한다. Apple HTTPS 화면에서 loopback 영상 재생, iPhone/iPad·Android 실기기 재진입과 PiP/백그라운드는 별도 기기 검증이 남아 있다. 웹 캐시는 새 서비스워커와 화면을 로드하면 사용할 수 있다.

## 추가 수정 — Android PiP 재생 버튼

- 이전 APK에서 영상은 재생 중인데 PiP에 재생 아이콘이 표시되고, 누른 뒤 복구되지 않는 증상 보고를 반영했다.
- 기존 PiP는 사용자 정의 액션이 없어 시스템 미디어 세션 제어에 의존했다. 네이티브 음악 세션과 영상 제어가 섞일 가능성을 제거하기 위해 영상 전용 RemoteAction을 명시하고, `shell.videoState`의 실제 영상 상태로 재생/일시정지 아이콘을 갱신한다.
- 앱 내부 수신기는 PiP 중에만 명령을 처리하고 WebView를 resume한 뒤 현재 영상에 명시적인 play/pause를 전달한다. 토글하지 않으므로 오래된 Play 명령이 재생 중인 영상을 멈추지 않는다. 실패한 play 요청도 실제 상태를 다시 보고하고 다음 요청을 허용한다.
- 공식 API 근거: [Android PiP RemoteActions](https://developer.android.com/develop/ui/compose/system/pip-remote-actions?hl=en).
- 검증: `androidVideoPip.test.ts` 6 tests 통과. 동일 영상의 반복 재생/정지, 중복 Play, PiP 외 명령 무시, 정리 후 명령 무시, 재생 실패 후 재시도를 확인했다. 앱 빌드/설치/실기기 검증 및 이번 변경의 배포는 하지 않았다. 다음 버전 APK에서 음악 재생 이력 유무별 PiP 아이콘·정지/재개·복귀/닫기를 확인한다.

## 추가 수정 — 공유 앱 아이콘

- 취소한 보라색 원형 재생 버튼 시안을 교체했다. 문자 M 시안도 최종안에 남기지 않고, 검은 배경(`#08090B`)에 네온 코랄(`#FF365F`) 재생 삼각형과 음파 막대를 결합했다.
- 웹 SVG/192·512 PNG/maskable, Android PNG·adaptive/monochrome 리소스, Mac ICNS, iPhone/iPad AppIcon을 같은 도형으로 생성한다. Android Manifest는 adaptive mipmap을 참조하며 iOS Xcode 프로젝트에 AppIcon asset catalog를 연결했다.
- 재생성: `scripts/generate_app_icons.py` (Pillow 필요). 패키지 컴파일과 별개인 아이콘 리소스 생성만 수행했다.
- PNG 미리보기, XML/JSON·Xcode 프로젝트 문법과 리소스 연결을 확인했다. 앱 빌드·설치는 하지 않았으며 설치된 앱 아이콘은 다음 버전 설치 시 변경된다. 이번 아이콘의 웹 배포도 아직 하지 않았다.

## 추가 수정 — Android 음악 알림 큐·좋아요

- 확장 알림에 큐·이전·재생/일시정지·다음·좋아요를 제공한다. Android12 이하에서는 사용 가능한 버튼을 이 순서로 정렬하며, 접힌 알림은 이전/재생/다음을 유지한다. Android13 이상은 SystemUI가 표준 재생 버튼 위치를 정하므로 추가 액션 슬롯으로 큐/좋아요를 제공하며 동일한 물리적 순서는 보장하지 않는다.
- 큐 버튼은 앱을 열고 기존 Queue drawer를 표시한다. 앱 초기 로딩 또는 실행 중 재진입 모두 처리하며 화면 수신 후 요청을 확인 처리한다.
- 좋아요는 현재 곡의 콘텐츠 키에 적용한다. 서비스의 서버별 저장소에 변경 요청을 남겨 웹뷰가 닫혀 있어도 보존하고, 앱에서 수신하면 웹의 좋아요 목록에 반영·확인 처리한다. 웹에서 변경한 좋아요도 알림 하트에 반영한다. 로컬 음악도 연결 서버의 동일한 좋아요 공간을 사용한다.
- 검증: 알림 좋아요 저장 요청 재생/확인·실패 후 재시도·웹 변경 연동 및 큐 열기/확인 처리 포함 웹 2 files / 36 tests 및 TypeScript 타입 검사 통과. Media3 1.10.1 공식 소스/API 확인. 앱 빌드·설치·배포는 하지 않았다. 당시 네이티브 컴파일은 미실행이다. 재정립한 정책에 따라 컴파일은 실기기 연결과 무관하게 검증하며, 실제 알림 배열과 백그라운드 큐 진입은 다음 버전 실기기 검증 대상으로 남긴다.
- Android 시스템 배치 규칙: https://developer.android.com/media/implement/surfaces/mobile


## 컴파일 검증 재개 — 2026-09-07

- 상태: **Android·macOS 컴파일/자동 검사 통과, iOS SDK 및 실기기 검증 대기**. 1.4.6 전체 완료로 닫지 않는다. 기존 산출물을 이번 소스의 새 패키지로 표시하지 않는다.
- Android: Java21 + Android SDK36에서 `:app:compileDebugKotlin :app:processDebugResources :app:testDebugUnitTest` 성공. 5 suites / 18 tests, failures/errors/skipped 0. 기본 JVM11 시작 오류는 Java21 지정으로 해결했다. PiP·알림·아이콘·영상 캐시가 포함된 현재 소스를 컴파일했다. Gradle 의존 작업으로 공유 웹 TypeScript/Vite 검사도 실행됐다. APK 패키징/설치는 하지 않았다.
- Apple Mac: 전체 `Muzio/*.swift`를 macOS13 arm64 타깃으로 타입 검사하고 임시 실행 파일까지 컴파일·링크 성공. `test-audio.sh`, `test-video-index.sh`, ServerPolicy 실행 검사, iOS/Mac plist 및 Xcode project 문법 검사 통과. 배포용 .app/ZIP 패키징은 하지 않았다.
- 컴파일 경고: Android API34/35 호환 분기의 deprecated background-activity 상수 및 PiP override 인자명, Swift WebKit Sendable 경고가 남아 있다. 컴파일 실패는 아니다.
- iOS: 현재 `xcode-select`는 CommandLineTools이고 전체 Xcode/iOS SDK·simctl이 없다. Mac 통과는 iPhone/iPad 컴파일을 대체하지 않는다. Xcode/iOS SDK 준비 후 iOS 타깃 컴파일·시뮬레이터 검증을 진행한다.
- 연결 검사: adb 기기 목록이 비어 있고 USB 목록에도 Android/iPhone/iPad가 없다. 사용자 연결 후 최신 버전 패키징·설치와 아래 실기기 검증을 이어간다.
- Android 실기기: 홈 자동 PiP → 일시정지 아이콘 → 반복 정지/재개 → 복귀/닫기, 음악 재생 이력이 있는 경우도 확인. 알림 큐 진입·이전/재생/다음·좋아요 상태 및 앱 재진입 동기화, 로컬 폴더 증분 목록·썸네일, 영상 재진입 캐시, 새 아이콘 확인.
- Apple 실기기: iPhone/iPad 공유 화면·회전/safe area·서버 재연결, 음악 재생·백그라운드/시스템 제어·슬립타이머, 영상 재생/PiP·복귀·캐시 확인. Android 전용 알림 변경을 Apple에 구현한 것으로 표시하지 않는다.
- 로그: `/tmp/muzio-android-compile.log`, `/tmp/muzio-apple-{swift-typecheck,link,audio,video-index,policy,plutil}.log`.

## 추가 수정 — Apple 로컬 음악

- iPhone/iPad·Mac의 시스템 폴더 선택기를 Local Music 설정에 연결했다. security-scoped bookmark로 폴더 권한을 저장하며, 원본 음악은 복사하지 않는다. 폴더를 제거하면 연결·해당 커버 캐시만 제거하고 원본 파일은 유지한다.
- 폴더 등록 요청은 스캔을 예약하고 바로 응답한다. 파일명 목록을 먼저 제공하고 AVFoundation 메타데이터·최대160px JPEG 커버는 직렬 백그라운드 작업으로 채운다. 10곡 단위 및 작업 종료 시 진행 내용을 저장해 종료 후 이어받는다. iOS의 무제한 백그라운드 실행을 보장하지 않으며, 앱 정지 후 다음 실행에서 재개한다.
- 네트워크와 로컬 곡은 기존 공유 목록/필터/큐에서 함께 표시한다. 기본 파일 존재·읽기 권한과 폴더 경계를 확인하고 symlink·등록되지 않은 ID는 거부한다. 네이티브 재생은 웹의 임의 URL을 무시하고 카탈로그 ID로 파일을 열며 재생 항목 수명 동안 폴더 접근 권한을 유지한다.
- 커버는 스냅샷에 대용량 base64를 넣지 않고 `muzio-local` 이미지 요청으로 개별 제공한다. 허용된 서버의 앱 문서에서만 요청을 처리하며, 폴더 연결에 속한 캐시 ID만 읽는다.
- iCloud/파일 제공자 곡은 기기에 먼저 내려받도록 안내한다. 사용할 수 없는 개별 파일은 다른 곡의 정보 수집을 막지 않으며 다시 스캔하면 재시도한다. Apple 웹 화면의 첫 로딩에는 서버 연결이 여전히 필요하다. 완전 오프라인 UI 또는 프로세스 종료 후 재생 큐 복원은 이번 범위가 아니다.
- 검증: 현재 전체 Apple 소스 macOS13 arm64 컴파일·링크 통과, Xcode project 문법 통과. 로컬 카탈로그 1,001곡 빠른 등록/메타데이터 전 목록/중복/심볼릭 링크/미등록 ID/작업 중 제거/저장된 미완료 작업 재개/합성 MP3 앨범아트 테스트 통과. 실제 macOS AVPlayer의 로컬 파일 재생·일시정지/재개·권한 해제·임의 URL 무시·미허가 ID 거부 테스트 통과. 웹 로컬 설정/목록 2 files / 12 tests 및 TypeScript 검사 통과.
- 재현: `bash ios_app/scripts/test-local-music.sh`, `bash ios_app/scripts/test-audio.sh`. 로그 `/tmp/muzio-local-{catalog-test,host-link,web-types}.log`, `/tmp/muzio-apple-local-web.log`.
- iOS SDK 미설치로 iPhone/iPad 컴파일과 실제 폴더 선택/권한 재개/PiP·백그라운드 검증은 대기다. 새 Apple 앱 패키징·설치 및 이번 UI 안내의 웹 배포는 하지 않았다. 기존 설치 앱은 다음 버전 패키지에 반영된다.

## 플랫폼 동등성 점검·버전 통일 — 2026-09-07

- 앞으로 공통 웹 변경은 웹·Android·iPhone/iPad·Mac에 함께 반영하고, 모바일 전용 기능은 Android·Apple 양쪽을 구현·검증한다. OS/API로 불가능한 차이와 구현 누락을 구분한다. 이 정책을 AGENTS.md에 기록했다.
- 사용자 표시 버전을 웹·Android·Apple 모두 **1.4.6**으로 통일했다. Android 내부 versionCode는14이며 Apple 내부 build 번호와는 독립적이다. 버전 검사에 Android versionName, iOS/Mac plist, Xcode MARKETING_VERSION을 추가했다.
- Apple Now Playing에 로컬/동일 서버 앨범아트를 연결하고, 시스템 좋아요 명령과 웹 좋아요를 같은 콘텐츠 키로 동기화한다. 서버별 영구 저장 요청을 웹에서 반영한 후 확인 처리하므로 웹뷰가 중단돼도 보존한다. 시스템이 제공하는 버튼 배치와 노출은 Android의 사용자 정의 알림 배열과 다를 수 있다.
- Apple 네이티브 재생 이력·진행률을 디스크에 보관하고 공통 웹 저장소로 가져온다. 재생 전환 경계, 중복 큐, 재시도 및 저장 공간 부족을 처리하며 실제 웹 저장 성공 전에는 네이티브 기록을 지우지 않는다. 동일 재생 세션을 foreground 기록과 이중 집계하지 않는다.
- 확인된 잔여 구현 차이: Apple은 서버에 연결하지 못한 cold launch에서 공통 UI를 열 수 없다. Android 번들 UI와 동등한 오프라인 진입은 아직 미구현이며 **OS상 불가능한 차이가 아니다**. 별도 네이티브 목록 화면을 추가해 공통 UI를 분기하지 않았다. 자동 PiP와 시스템 버튼의 실제 노출은 기기 검증 전까지 완료로 표시하지 않는다.
- 검증: 변경한 네이티브 오디오/좋아요/이력 및 저장소 웹 **4 files / 30 tests**, TypeScript 통과. Apple 좋아요 영구 저장·origin 격리·앨범아트와 재생 이력 Swift 회귀 검사 통과. Xcode16.4의 iOS SDK로 전체 Swift 소스를 arm64 iOS16 대상으로 직접 컴파일·링크 통과했고 macOS13 전체 링크도 통과했다. iOS의 비동기 파일 열거 Swift6 이행 경고가 남으며 현재 Swift5 모드에서 실패는 아니다.
- Xcode16.4 설치·관리자 인증 완료, iOS 플랫폼 설치 완료. 연결된 iPad Pro11(3세대)는 iPadOS27 beta이며 개발자 모드가 꺼져 있다. Xcode Apple 계정/서명도 미설정으로 Xcode 타깃 빌드·서명·iPad 설치는 아직 완료되지 않았다. 위 직접 컴파일은 리소스 패키징/서명 검증과 다르다. 연결된 iPad의 설치·실기기 동작 결과는 별도 기록한다.

- 추가 검증: playerStore·기존 capability 계약 2 files / 72 tests 통과. Apple 네이티브 배경·설정·오류 화면·sheet에도 웹 테마를 반영하고 최초 실행은 시스템 테마를 사용한다. 최종 테마 포함 iOS16/macOS13 객체 컴파일 통과.

- 공유 웹 배포 완료: 운영 health 정상, JS/CSS가 이번 빌드와 일치하고 서비스워커 **1.4.6-r7**을 확인했다. Apple은 서버 UI를 사용하며 Android의 기존 설치 APK 번들은 다음 패키징에 반영된다.

- 최종 iOS Xcode 빌드: `Muzio-iOS` / Debug / iphoneos / generic iOS 대상으로 **BUILD SUCCEEDED**. 아이콘 asset catalog·plist·전체 Swift 링크를 검증했다. 산출물 `/tmp/muzio-ipad-build/Build/Products/Debug-iphoneos/Muzio.app`의 표시 버전1.4.6 확인. `CODE_SIGNING_ALLOWED=NO`로 생성한 검증용 앱이므로 설치 가능한 서명 완료 패키지가 아니다. 로그 `/tmp/muzio-ipad-build.log`.
- 최종 설치 차단 요인: iPad는 paired이나 Developer Mode disabled, Mac의 유효한 코드 서명 identity0개. Xcode Apple 로그인 창을 열어 두었으며 사용자 기기 설정/계정 인증을 기다린다. iPad 설치·실기기 테스트 및1.4.6 릴리스 종료는 미완료로 유지한다.

## Android 설치 준비 — 2026-09-07

- 사용자 요청은 Apple 설치를 우선 확인하고 불가능하면 Android로 전환하는 순서다.
- Java21/Android SDK 환경에서 `:app:assembleDebug` 성공(39 tasks, 25초). 현재 공유 웹을 포함한 `android_app/app/build/outputs/apk/debug/app-debug.apk`를 준비했다. 설치와 실기기 검증은 아직 수행하지 않았다.
- Xcode 초기 설정 검사는 통과했으나 iPad 연결 unavailable, 유효한 서명 identity0개로 현재 Apple 설치를 완료할 수 없다. Mac 보안 설정의 일반 시스템 확장 활성화 안내를 앱 설치 필수 절차로 취급하지 않는다.

- 후속 연결: Xcode Personal Team 및 Apple Development 인증서 생성 완료(유효한 identity1개). iPad USB tunnel connected 확인. 그러나 Developer Mode disabled로 개발용 기기 등록·프로비저닝을 완료하지 못했고 서명 빌드는 기기 없는 Team/profile 미생성 오류로 중단됐다. 기기에서 개발자 모드 활성화·재시작·확인 후 이어간다. Mac 시스템 확장 설치나 Mac 재시작은 진행하지 않았다.

## iPad 실기기 설치 — 2026-09-07

- 개발자 모드 enabled, 개발용 디스크 이미지 서비스 및 USB 연결 정상 확인. 기존 컴파일 결과를 재사용해 연결 iPad 대상으로 Personal Team 자동 프로비저닝·서명 빌드 **BUILD SUCCEEDED**.
- `devicectl device install app` 성공: iPad Pro11(3세대), `com.twkim.muzio.apple`, 표시 버전1.4.6. Mac 시스템 확장 설치나 Mac 재부팅 없이 진행했다. Android 전환은 필요하지 않았다.
- 앱 서명 `codesign --verify --deep --strict` 통과, provisioning profile에 연결 iPad UDID 포함 확인. 이 테스트 프로필 만료는2026-09-14 12:00:14 UTC(한국21:00:14)이다.
- 최초 실행은 기기의 Security 거부(개발자 프로필 사용자 신뢰 포함 안내)로 차단됐다. iPad의 일반 → VPN 및 기기 관리에서 개발자 앱 신뢰를 사용자에게 요청했다. 설치 성공과 실제 실행·기능 테스트 완료를 구분하며 현재 후자는 대기다.
- 로그: `/tmp/muzio-ipad-signed-build.log`, `/tmp/muzio-ipad-install.json`, `/tmp/muzio-ipad-launch.json`. 테스트 앱: `/tmp/muzio-ipad-build/Build/Products/Debug-iphoneos/Muzio.app`.

- 사용자 개발자 앱 신뢰 승인 후 `devicectl device process launch` 성공(2026-09-07 21:02 KST). iPad 설치·앱 실행 완료. 로컬 폴더/썸네일·백그라운드 재생/좋아요·PiP 등 기능별 실기기 수용 검증은 아직 미실행이며 릴리스 전체 완료로 표시하지 않는다.

## iPad 일반 화면 → 홈 자동 PiP — 2026-09-07

- 설치본에서 홈으로 나가도 PiP가 열리지 않는 사용자 보고를 반영했다. WKWebView의 PiP 허용 설정만으로 일반 인라인 영상의 홈 자동 전환을 보장하지 못했다. 사용자 승인에 따라 iPhone/iPad 영상 재생을 AVPlayerViewController에 연결하고 `canStartPictureInPictureAutomaticallyFromInline`을 활성화했다.
- 목록·필터·영상 정보 등 주변 웹 UI와 공통 재생 저장소는 유지한다. iOS 영상 영역에는 Apple 기본 재생·탐색·전체화면·PiP·내장 자막 컨트롤을 사용한다. Android/일반 웹/Mac의 기존 Vidstack 경로는 유지한다. 기존 Apple 앱은 capability가 없으므로 기존 경로를 유지한다.
- 공통 엔진 어댑터가 영상 명령을 직렬 전달하고 세대 ID로 오래된 이벤트를 무시한다. 네이티브 재생/정지/탐색 상태가 공통 UI로 돌아오며 앱 복귀 시 스냅샷으로 재동기화한다. 같은 AVPlayer를 유지해 PiP 진입 때 재로드하지 않는다. PiP 복귀 시 화면이 없으면 기존 player overlay를 열고 실제 표시 후 복귀 완료를 알린다.
- 영상 전용 background audio session을 설정하고 음악 플레이어의 Now Playing/remote command 소유권을 양보한다. 명시적 음악 재생은 영상을 멈추고 음악 세션을 되찾는다. 스냅샷/설정/늦게 도착한 앨범아트가 영상 정보를 덮어쓰지 않도록 회귀 검증했다.
- 네이티브 영상 URL은 선택 서버의 현재 mediaId 경로 및 최적화 MP4/HLS로 제한한다. 원본 MP4 영상은 기존 로컬 인덱스 프록시를 사용하고 실패 시 원본으로 한 번 복귀한다. 탐색 위치·사용자 재생 의도·슬립타이머를 유지한다.
- 검증: 네이티브 엔진/기존 영상 컴포넌트 6 tests 및 TypeScript 통과. Swift 음악 ownership 회귀 검사, 영상 URL 제한/프록시 경로 테스트, 전체 macOS 컴파일·링크 통과. 최종 iOS 서명 빌드 **BUILD SUCCEEDED**. 실제 사용 중 발견한 실패를 보완한 산출물만 다시 패키징했다.
- 공유 웹 배포와 서비스워커1.4.6-r8 확인. iPad 수정본 업데이트 설치 성공. 홈 자동 PiP·정지/재개·복귀는 사용자 실기기 확인을 요청했으며 자동 검사만으로 실기기 통과로 표시하지 않는다. 전체 웹뷰 프로세스 종료 후 네이티브 영상 복원은 아직 지원하지 않는다.
- 근거: https://developer.apple.com/documentation/avkit/avplayerviewcontroller/canstartpictureinpictureautomaticallyfrominline . 로그 `/tmp/muzio-ipad-pip-build.log`, `/tmp/muzio-ipad-pip-install.json`, `/tmp/muzio-ipad-pip-launch.json`.

## 자동 PiP 기본 플레이어 적용 롤백 — 2026-09-07

- 사용자 실기기 확인: 자동 PiP는 동작했으나 Apple 기본 영상 UI가 기존 웹의 디자인·설정을 유지하지 못했다. 사용자 요청에 따라 위 AVPlayerViewController 영상 전환을 롤백했다.
- iOS도 기존 Vidstack 웹 영상 화면·컨트롤을 다시 사용한다. `nativeVideo` capability, 네이티브 영상 엔진·표면·브리지·전용 테스트를 제거하고 Xcode 소스 목록을 다시 생성했다. 주변 UI만 공유하는 기본 플레이어 방식은 최종 채택하지 않는다.
- 음악 플레이어가 영상의 Now Playing/remote controls를 덮어쓰지 않도록 한 ownership 및 영상 background audio session 보완은 유지한다. 일반 인라인 → 홈 자동 PiP는 다시 미완료로 남긴다.
- 기존 디자인과 PiP를 함께 지원하는 공식 경로는 custom player용 AVPlayerLayer + AVPictureInPictureController이다. 향후 구현은 웹 컨트롤·설정·자막·탐색 등 현재 기능을 유지하는 연결과 검증이 전제이며 이번 기본 플레이어 적용을 완료로 표시하지 않는다.
- 공유 웹을 서비스워커1.4.6-r9로 배포했다. 롤백 앱의 설치 결과는 아래에 기록한다.

- 롤백 검증: 기존 Vidstack 관련34 tests, TypeScript/Vite 및 iOS 서명 빌드 통과. iPad 업데이트 설치 성공. 버전1.4.6 유지.

## 웹 컨트롤 유지형 Apple 자동 PiP 및 필터 유지 — 2026-09-07

- 앞선 기본 AVPlayerViewController UI 교체/롤백에 이어, iPhone/iPad는 AVPlayerLayer로 영상 픽셀만 출력하고 그 위 WKWebView의 기존 Vidstack 컨트롤·메뉴·탐색·배속·극장 모드·전체화면 버튼을 유지하는 구조로 변경했다. `nativeVideo` capability가 없는 기존 Apple 앱과 웹/Android/Mac 영상 경로는 유지한다.
- AVPictureInPictureController의 inline 자동 PiP를 연결했다. 영상 generation으로 오래된 제어를 거부하고, 실제 native 재생·탐색 상태를 웹 플레이어에 반영한다. PiP 복귀는 화면 표시 성공과 실패를 구분하고, 실패 시 백그라운드 재생을 멈춘다.
- 투명 영상 영역 뒤의 기존 목록을 감추고, sticky 영상 밑으로 스크롤하는 설명/목록은 겹치는 구간을 잘라 영상 위로 글이 비치지 않게 했다. 전체화면에서는 fullscreen 요소 밖의 내용을 감추고 종료 시 복원한다.
- 내장 자막/오디오 트랙을 기존 메뉴에 연결했다. 남은 차이: Apple native HLS는 자동 화질이며 수동 HLS 화질 선택·100% 초과 증폭·웹 자막 스타일은 아직 연결되지 않았다. OS상 불가능으로 표시하지 않는다.
- Music·Video·Image 각각 검색어, #Artist 태그, 저장소/온·오프라인 필터, 정렬 기준/방향을 저장한다. 웹/앱 재실행과 화면 전환 후 복원하며, 목록을 아직 불러오는 중에도 필터를 초기화하지 않는다. 저장 공간 비활성화/손상 시 탐색을 막지 않는다. 계정/기기 사이의 동기화 기능은 아니다.
- 검증: 필터 저장/화면 회귀41 tests, native provider8 tests 및 실제 Vidstack MP4/HLS 통합2 tests, 합성 surface2 tests, 영상 화면43 tests, 기존 Android PiP6 tests, 영상 engine32 tests 통과. 웹 TypeScript/Vite build, native 영상 URL 정책 테스트, iOS 및 Mac 컴파일 통과. iOS 서명 빌드로 iPad 테스트 설치를 갱신한다. 실기기의 디자인·스크롤·전체화면·자동 PiP·반복 정지/재개·복귀는 사용자 확인 전 완료로 표시하지 않는다.
- 웹 배포 캐시 `muzio-shell-v1.4.6-r11`; 기존 Android 설치본은 번들 방식이므로 다음 APK 갱신이 필요하다. 이번 iOS 수정으로 Android APK를 다시 패키징하지 않았다. 표시 버전은 전 플랫폼1.4.6 유지.
- 근거: [Apple custom-player PiP](https://developer.apple.com/documentation/avkit/adopting-picture-in-picture-in-a-custom-player). 로그 `/tmp/muzio-ipad-web-controls-build.log`, `/tmp/muzio-ipad-web-controls-install.json`.

- 통합 검사에서 기본 MP4/HLS loader가 custom provider보다 먼저 선택되는 문제와 시간 반영 이벤트 오류를 발견해 수정했다. Apple 내부 source 식별자만 분리하고 실제 스트림 URL·저장된 진행률 identity는 유지한다. 실제 MediaPlayer에서 MP4/HLS native load, 재생 버튼, 현재 시간, 정지 상태를 확인했다. iPad 설치 성공; 설치/실행과 실기기 기능 수용은 구분한다.
- 최종 설치/실행: iPad Debug 설치 성공 후 22:13 KST 앱 launch 성공. 서버의 index.html 및 서비스워커 r11이 최종 산출물과 일치함을 확인했다. 로그 `/tmp/muzio-ipad-web-controls-launch.json`.

## iPad 영상 시작 요청 취소 수정 — 2026-09-07

- 음악 재생은 정상이나 영상 전체가 로딩 상태에 머무는 사용자 보고를 조사했다. native video.load가 처음 보내는 playing=false 상태를 provider가 pause 이벤트로 변환하면서, 영상 engine이 준비 완료를 기다리던 재생 의도를 취소하는 결함을 확인했다.
- 초기 정지 상태 보고는 일시정지 이벤트로 만들지 않고, 실제 재생 중→정지 전환을 전달한다. 영상 준비 완료 후 요청된 video.play가 실행되게 한다.
- 기존 fake native 상태만 확인한 테스트를 실제 Vidstack + 영상 engine 연결로 확장했다. paused loading→ready 순서 후 native 재생 명령이 전달되는지 검증한다. 웹 연결 수정이므로 앱 바이너리 재패키징은 필요하지 않으며, 웹 캐시를 r12로 갱신한다. 실기기 결과는 다시 확인한다.
- 검증: MP4/HLS 시작 회귀는 수정 전2개 실패, 수정 후 provider11 tests 통과. 로딩 중 명시적 pause의 재생 취소도 통과.

## iPad 영상 준비 단계의 배포 전용 오류 수정 — 2026-09-07

- 작은 영상과 수동 재생도 계속 버퍼링한다는 후속 보고를 반영했다. 이전 초기 pause 수정만으로 전체 증상이 해결됐다고 보지 않는다.
- Vidstack 개발 빌드에는 LIST_ADD/REMOVE symbol 설명이 있지만 production 빌드는 Symbol(0)으로 바꾼다. native 영상의 실제 오디오 트랙이 들어오면 이름 탐색이 실패해 syncAudioTracks에서 예외가 발생하고, delegate.ready에 도달하지 못하는 결함을 production AudioTrackList로 재현했다.
- 설명/순서에 의존하지 않고 별도 임시 목록에서 추가/개별 삭제 동작을 확인해 adapter를 캐시한다. 사용자 목록을 탐색용으로 변경하지 않는다. 호환성 실패는 player error로 전달하여 무한 대기로 숨기지 않는다.
- production 목록의 준비 완료·트랙 선택·개별 삭제·소스 교체까지 포함해 provider12 tests 통과. 웹 캐시 r13으로 갱신하며 네이티브 바이너리는 변경하지 않는다. 실기기 재생 성공은 사용자 확인 전까지 미검증이다.

## iPad 영상 탭·전체화면·양방향 탐색 복구 — 2026-09-07

- 영상 탭이 재생/일시정지 대신 컨트롤 표시만 바꾸던 touch 설정을 Apple native 영상에서 재생 토글로 복구했다. 기존 좌우 더블 탭 탐색은 유지한다.
- WebKit element/video fullscreen이 영상 아래의 별도 AVPlayerLayer와 분리되는 경로를 사용하지 않는다. 같은 영상/컨트롤 DOM을 앱 화면 전체로 확대하고, 종료 시 placeholder 위치로 돌려놓는다. 기본 전체화면 버튼·키보드·더블 탭·영상 화면 swipe 진입을 같은 경로로 연결했다. native host도 상태바/safe area를 조정하며 종료 시 복원한다. 웹/Android/Mac의 기존 전체화면 경로는 유지한다.
- 탐색 중 AVPlayer의 임시 paused 상태와 늦게 도착한 KVO가 재생 의도를 지우지 않도록 observation 시점의 revision과 seek 상태를 보존했다. 새 명령/새 탐색보다 오래된 콜백은 무시하고, 탐색 중 직접 pause하면 정지 의도가 우선한다. 앞/뒤 연속 탐색은 최신 대상만 완료한다.
- 네트워크 영상의 exact-frame seek 대신 허용 오차250ms를 사용한다. 실제 파일의 키프레임/네트워크에 따른 탐색 지연까지 없어진다고 보장하지 않는다. 무한 대기를 일으킨 상태 혼선을 수정하는 범위다.
- native playback intent 회귀 실행 통과, iOS signed build 및 Mac compile 통과. 기존 웹 영상화면/engine/Android PiP81 tests 통과. 전체화면 반복/복귀/cleanup 및 native provider 연결은 추가 테스트로 검증한다. 수정본은 iPad 설치 후 실기기 탭·전체화면 왕복·양방향 탐색을 별도 확인한다.
- 웹 캐시 r14. 로그 `/tmp/muzio-ipad-controls-seek-build.log`, `/tmp/muzio-mac-controls-seek-build.log`.
- 추가 확인: native provider12 tests와 surface3 tests 통과. 같은 플레이어의 반복 전체화면 진입/복귀, Escape/아래 swipe 종료, inline frame 복원, fullscreen 중 cleanup을 검증했다. 가로 swipe는 fullscreen을 종료하지 않는다. 실제 coarse touch hit test와 영상별 탐색 지연은 iPad 확인 항목이다.
- iPad signed 수정본 설치 성공, 웹 r14 및 index.html 실제 서비스 일치 확인. 설치 로그 `/tmp/muzio-ipad-controls-seek-install.json`, 실행 로그 `/tmp/muzio-ipad-controls-seek-launch.json`. 웹 TypeScript/Vite build 통과.

## Android 최신 APK 빌드·설치 — 2026-09-07

- 사용자 요청으로 현재 공유 웹 UI(r14)를 포함한 Android1.4.6(versionCode14) Debug APK를 빌드했다. `:app:testDebugUnitTest :app:assembleDebug` 성공(16초), 단위 테스트18개 failures/errors0. APK 안의 index.html과 서비스워커 r14를 생성 자산과 대조했다.
- 연결된 SM-S936N의1.4.5-web-dev(versionCode11)를 `adb install -r`로 업데이트해 앱 데이터/폴더 권한을 유지했다. 설치 Success, 설치 버전1.4.6/code14 확인. MainActivity cold launch Status:ok, 프로세스 및 음악 목록 화면 표시 확인. 음악/영상 재생·PiP·알림·로컬 폴더 기능 수용 테스트는 별도다.
- APK: `android_app/app/build/outputs/apk/debug/app-debug.apk` (26,377,316bytes), SHA256 `050248525a919b74787d9f3f93adf7c2bd65cf2aa51f86f7de7bc0d680f8312c`.
- 빌드 로그 `/tmp/muzio-android-146-r14-build.log`, 설치 후 화면 `/tmp/muzio-android-146-installed.png`.

## Android AAC 총 길이·탐색 복구 — 2026-09-07

- 미니바/전체 플레이어/알림에서 총 길이가00:00이던 실제 곡 `Curara(260907).aac`를 확인했다. 서버는 Content-Length와 Range를 제공했지만 기본 Media3 ADTS extractor가 길이/seek map을 만들지 않아 native snapshot부터 durationSec0이었다. Queue/Like 알림 버튼 추가가 원인은 아니었다.
- Android 공용 ExoPlayer의 ADTS extractor에 constant-bitrate seeking을 활성화했다. 네트워크/로컬 AAC 모두 같은 설정을 사용하며 MediaSession과 웹 브리지가 실제 플레이어 timeline을 공유한다. AAC 길이/탐색은 bitrate 추정값이므로 가변 bitrate에서는 오차가 있을 수 있고, 길이를 알 수 없는 스트림은 강제로 seekable로 만들지 않는다. Apple/web 재생기는 이 Android extractor를 사용하지 않으므로 변경 대상이 아니다.
- 실제 ADTS 프레임으로 기본 duration 미정, 알려진 길이의 duration/중간 탐색, 길이 미상의 탐색 비활성 회귀3개 통과. 기존 Android 단위18개 및 APK assemble 성공. 테스트 추가 후 해당 회귀3개 Gradle 실행도 성공했다.
- 수정 APK를 연결된 SM-S936N에 데이터 유지 업데이트 설치했다. 같은 곡의 native duration1288.848초, 미니바21:28/seek max1288.848, 전체 플레이어21:28/seek max1288.848, 시스템 알림 총 시간21:28을 실기기에서 확인했다. 45초 탐색 후 재생 위치52.212초까지 진행, pause 및 원래11.494초 복원 성공. 다른 형식/모든 로컬 곡을 전수 확인한 것은 아니다.
- 로그: `/tmp/muzio-android-aac-duration-build.log`, `/tmp/muzio-android-aac-regression.log`. 버전1.4.6/code14 유지.

## 영상 탭 동작·글래스 피드백·로딩 표시 — 2026-09-07

- Android에서 coarse pointer 기본값이 화면 탭을 controls 토글로 처리하던 설정을 공통 영상 UI에서 재생/일시정지로 통일했다. 기존 좌우 더블 탭 탐색은 유지한다.
- 화면 제스처 요청 후 실제 play/pause 이벤트가 확인되면 해당 아이콘을 글래스 원형 배지로650ms 표시한다. 자동 재생/소스 교체/탐색에는 배지를 표시하지 않으며 실패한 요청과 해제된 리스너의 잔여 피드백을 방지한다. reduced-motion에서는 확대 애니메이션을 생략한다.
- 큰 기본 버퍼링 링을48px 글래스 원형 안의22px 링으로 교체했다. 영상 준비 전 WebView 기본 포스터 노출을 숨기며 준비된 영상의 이후 버퍼링에서는 프레임을 가리지 않는다.
- 캐시 감사: Android/Apple은 최대5개·640MiB, 웹은2개·256MiB의 front MP4/MOV 인덱스 prefix를 보존한다. 영상 본문 캐시는 아니며 재진입 manifest 검증과 현재 시청 위치의 본문 네트워크 요청은 남는다. A→B→A의 버퍼링만으로 캐시 미작동이라고 판단하지 않는다. 이번 변경으로 전체 영상 캐시를 새로 구현한 것은 아니다.
- 피드백 회귀2개와 기존 FullPlayerScreen43개 통과, TypeScript/Vite 및 Android APK assemble 통과. 웹 서비스워커r15 서비스 확인. Apple은 서버 공통 UI 변경이며 native 재패키징 대상이 아니다. 실제 각 플랫폼의 탭/더블 탭 체감 및 로딩 디자인 수용은 별도 확인한다.
- Android 수정 APK `adb install -r` Success, MainActivity 실행 Status:ok 및 공유 UI 표시 확인. 사용자 재생 상태는 추가로 변경하지 않았다.

## 앱 A→B→A 재진입 지연 및 중앙 기본 버튼 후속 수정 — 2026-09-07

- 사용자 실측은 iPad/Android 앱 약5초, 같은 기기 웹 약1초였다. 이전의 인덱스 캐시 존재 확인만으로 이 차이가 설명됐다고 보지 않는다.
- 작은 영상 레이아웃의 지속 표시되는 중앙 기본 play/pause 버튼을 숨겼다. 화면 탭과650ms 글래스 피드백을 사용하며 타임라인/설정/전체화면 및 데스크톱 하단 재생 버튼은 유지한다. 웹 공통 UI 캐시r16.
- 네이티브 경로에는 매번 전체 인덱스 SHA256을 계산하는 비용이 있었다. 웹 IndexedDB 적중은 같은 검사를 반복하지 않는다. 캐시 존재와 재진입 지연은 구분하며, 코드 개선만으로 사용자 실측5초가1초로 줄었다고 확정하지 않는다.
- Android/Apple 캐시의 검증 결과를 파일 크기·수정시각·파일 식별자 및 checksum/record 상태와 함께 재사용한다. 앱 재시작/파일 변경 시 전체 검사를 다시 수행한다. Apple warm hit는 다른 cache fill lock을 기다리지 않는다. Android 캐시 회귀6개 및 Apple proxy 통합 검사 통과, iOS signed/macOS compile 통과.
- 실기기 추가 진단에서 Android cache/video-index-v1이 비어 있었고, 실제 이어보기 주소의#t=29754.1 때문에 bypass=fragment가 발생함을 확인했다. 네트워크 주소에서만 fragment를 제거해 캐시를 사용하도록 수정했다. HTML 영상 주소의 이어보기 의미와 same-origin/인증 검사는 유지한다. fragment를 포함한 요청의 전체 데이터·적중·타 origin 거부 회귀 통과.
- 동일 영상2af1d7dd049af129의 Android WebView metadata probe: 수정 전6,422.6ms 및 cache bypass, 수정 후 최초82,125,982byte 캐시 생성20,318ms, 새 video 요소로 재진입1,045.6ms. 재진입 native cache hit225ms/응답 준비280ms 로그 확인. 이는 같은 영상 요소 재생성의 metadata 측정이며 사용자 전체 A→B→A 재생 체감과 동일한 측정이라고 간주하지 않는다. 처음 캐시를 채우는 비용은 남는다.
- 최종 Android APK 설치 Success 및 실행 확인. iPad 수정본 설치 성공했으나 기기 잠금으로 실행/재측정은 실패했다. Apple fragment는 기존 source policy에서 이미 제거되므로 Android 원인을 Apple에 그대로 적용하지 않는다. iPad 앱 대 웹의5초/1초 차이는 실기기 후속 진단이 남아 있다.
- 로그: /tmp/muzio-r16-fragment-build.log, /tmp/muzio-r16-ios-build.log, /tmp/muzio-r16-mac-build.log, /tmp/muzio-r16-ipad-install.log, /tmp/muzio-r16-ipad-launch.log. 원인 확인용 Android DEBUG 로그는 URL/토큰/오류 메시지를 제외하고 단계·적중 여부·소요시간만 기록한다.

## 1.4.6 개발 마감 — 2026-09-07

- 사용자 요청으로 이번 버전을 마감한다. iPad에 최종 캐시 개선 네이티브 패치 설치를 확인했고, 잠금 해제 후 `devicectl` 앱 실행 성공(23:35)을 확인했다. 설치 표시 버전1.4.6/build1, 서버 공유 UIr16. iPad A→B→A 체감 시간과 전체 기능 수용 테스트는 후속 확인으로 남긴다.
- 릴리스 검사: backend 전체11 packages, race4 packages, go vet 통과. 웹 전체 실행은679/680 통과·로컬1001곡 테스트1개가5초 제한 초과했고, 해당 파일 별도 재실행에서6개 모두 통과했다. 테스트 제한을 늘리거나 제품 코드를 바꾸지 않았다. 최신 웹 빌드, Android Kotlin/캐시 회귀, iOS 서명 빌드/macOS 컴파일의 기존 유효 결과를 재사용했다.
- Android 최종 APK SHA256 `95487eb0d6687ecaeb501d84e5f61c9b1471f257fa60f8240762cbec8fb3cc19` (27,141,615bytes). iOS는 설치용 서명.app을 사용했으며 App Store archive/IPA 배포는 하지 않았다.
- Mac 최종 컴파일 결과를 로컬 ad-hoc 서명·검증하고 `dist/apple/Muzio-1.4.6-macOS-universal.zip`으로 갱신했다(arm64/x86_64, 1,047,904bytes, SHA256 `ad4929e2f8597a49631b8873cc4c74ae094eca93dca65649cfcbd9e58714889b`). 초기 arm64 산출물 기록을 대체하며 공증하지 않았다. 생성 앱/APK/ZIP은 Git 대상에서 제외한다.
- 전체 검사 로그: `/tmp/muzio-146-release-backend.log`, `/tmp/muzio-146-release-race.log`, `/tmp/muzio-146-release-vet.log`, `/tmp/muzio-146-release-web.log`, `/tmp/muzio-146-release-web-retry.log`. iPad 실행 로그: `/tmp/muzio-release-ipad-launch.log`.

## 마감 후 iPad 재진입 지연 진단 — 2026-09-07

- 사용자 A→B→A 재현 로그에서 Apple proxy 사용과 실제 인덱스 cache hit를 확인했다. A의 load→ready는 첫4.70초/재진입4.65초, B는2.46초였다. 트랙 준비는1~2ms였다.
- A 재진입에서 약82MB 인덱스의 캐시 응답은 요청별약45~100ms였고, 약1초 뒤 인덱스 다음의 영상 본문 요청에서약3.57초 간격이 발생했다. 이어보기 seek는 ready 이후 추가약1.13초였다. 인덱스 cache miss라고 진단하지 않는다.
- 재생 시작 데이터 범위의 캐시 보완과 연결 재사용을 구현·검증 중이다. 실제 개선 여부는 후속 설치/재측정 결과로 구분한다. 진단 로그는 DEBUG 빌드의 제한된 로컬 파일에만 기록하며 URL/토큰을 넣지 않는다.
- 2026-09-08 후속 구현: Apple 캐시 범위를 원래 인덱스 뒤16MiB까지 확장하되 항목128MiB/파일 크기와 전체640MiB/5개 상한을 유지한다. 기존 인덱스를 복사해 활용하고 추가 범위만 revision/Content-Range/길이 검증 후 원자적으로 게시한다. 앱 시작 시 AVPlayer가 반복 요청한 약10MiB 본문을 포함하기 위한 Apple 재생기 경로 보완이다.
- 요청별 ephemeral URLSession 생성을 제한된 재사용 풀로 바꾸고, 취소는 해당 작업에만 적용한다. 기존 직렬 콜백/메모리 제한/리다이렉트 거부를 유지한다.
- Apple proxy 통합 검사 통과(44 assertion sites): 재진입 fresh manifest만 요청, 기존 인덱스 재다운로드 없는 확장, 확장 캐시 손상/버전 변경/범위 연결/취소/연결 재사용/LRU 상한. iOS 서명 및 macOS 빌드 통과. iPad 보완본 설치 완료, 사용자 A→B→A 재측정 대기. 최초 추가 데이터 저장 비용과 이어보기 위치 자체의 네트워크 탐색 비용은 남는다.
- 후속 사용자 확인: 재진입은 확실히 빨라졌으나 영상 끊김·오디오 소실이 보고됐다. 재진입 개선은 유지하기 위해 시작 데이터 캐시는 남기고, 동시에 도입했던 URLSession 연결 풀만 분리해 이전의 요청별 세션으로 되돌린다. 무음의 원인을 음소거/오디오 세션으로 단정하지 않으며, DEBUG 상태에 볼륨·음소거·선택 트랙 유무·출력 유형을 추가해 전송 문제와 구분한다. 영상/오디오 복구 여부는 수정본 후속 재현으로 검증한다.
- 연결 재사용 제외/시작 캐시 유지 버전의 proxy 회귀 검사, iOS signed/macOS build 통과. 이전 요청별 URLSession의 transfer/cancel/ProxyTransfer를 그대로 사용함을 대조했다. iPad 설치 완료. 오디오 소실/영상 끊김이 해결됐다는 실기기 수용 결과는 아직 없다.
- 추가 재현: 사용자 A/B 모두 무음·영상 끊김 보고. DEBUG에서 volume1/mutedfalse/오디오1트랙 selectedtrue/Speaker를 확인했고, 대상 파일은 일반 H264/AAC-LC48kHz stereo였다. 연결 풀만 제외한 것으로 해결되지 않았다. 사용자는 재진입 개선은 체감했다고 정정했으므로 이를 부정하지 않는다.
- 원인 분리를 위해 iOS native 영상의 검증된 private proxy URL을 원래 같은 서버 media URL로 복원하는 직접 AVPlayer 경로를 적용했다. 디자인/자동PiP를 유지하되 영상에 자체 인덱스 중계를 사용하지 않는다. 잘못된 proxy prefix/다른origin은 계속 거부하고 query는 보존한다. 정책 회귀 검사, iOS signed/macOS build 통과, 비교용 iPad 설치 완료. 무음/끊김 해소는 아직 실기기 확인 전이며 성능 수정 완료로 표시하지 않는다.

## iPad 연속 재생 중 무음·멈춤 후속 — 2026-09-08

- 사용자 증상을 정정한다. A→B→A 이전에 A 하나만 재생해도 소리가 사라지며, 오류 문구는 없다. 일시정지 후 재생하면 잠시 소리가 돌아오지만 반복해서 멈춘다. 자체 proxy를 우회한 직접 AVPlayer 경로에서도 발생했으므로 캐시 전송만으로 설명하지 않는다.
- 실제 AVPlayer를 이용한 로컬 재현에서 timeControlStatus KVO의 change.newValue가 nil이지만 관찰 대상의 상태는 waiting(1)/paused(0)으로 바뀌는 것을 확인했다. 기존 guard가 상태 변경을 버리는 결함을 수정했다. 관찰 콜백 시점에 실제 상태와 intent revision을 함께 캡처하며, 탐색·소스 교체 후 늦게 전달되는 알림 방어는 유지한다. 실제 AVPlayer를 통한 waiting/외부 pause 회귀를 추가했다.
- play/seek 완료 시 playImmediately를 사용하던 경로를 일반 play로 변경했다. defaultRate에 선택 배속을 보존하고 자동 버퍼 대기·재개를 사용한다. Apple SDK는 playImmediately가 충분한 버퍼 여부와 관계없이 재생한다고 명시한다. 이 변경만으로 실기기 무음 원인이 확정되거나 해결됐다고 표시하지 않는다.
- DEBUG에서 미디어 시간이 멈춰도 벽시계 타이머로 실제 rate/timeControlStatus/대기 이유/현재 위치/버퍼 잔량/오류 domain·code/음소거·오디오 출력 유형을 제한적으로 기록한다. URL·인증 정보·출력 장치 이름은 기록하지 않는다. 직접 서버 연결은 비교 조건을 유지하기 위해 그대로 둔다. 따라서 자체 시작 캐시 재사용 성능은 이번 확인 대상이 아니다.
- 검증: 실제 AVPlayer KVO를 포함한 playback intent 회귀 실행 통과, iOS DEBUG 서명 빌드 및 macOS 컴파일 통과. iPad 수정본 설치 성공(databaseSequenceNumber3536). 자동 실행은 기기 잠금으로 실패했다. 사용자가 잠금을 풀고 A 단독 연속 재생을 확인해야 하며, 무음·멈춤 해결은 아직 미확인이다. 로그: /tmp/muzio-ipad-buffered-build.log, /tmp/muzio-mac-buffered-build.log, /tmp/muzio-ipad-buffered-install.log, /tmp/muzio-ipad-buffered-launch.log.

## iPad 영상 재생 순서·버퍼 대기 재검증 — 2026-09-08

- 직전 수정본의 무한 대기를 실기기 로그와 iOS 시뮬레이터에서 재현했다. 원본을 직접 읽는 AVPlayer가 현재 위치에 약1.44초의 데이터를 확보하고도 `waitingToMinimizeStalls`에 머물렀다. 일반 `play()`로 바꾼 것만으로는 이 대기를 해소하지 못했다.
- 별도 AVPlayer와 실제 앱의 NativeVideoPlayer를 같은 원본·이어보기 위치로 비교했다. 오디오 tap의 비영점 PCM 정체도 관찰했지만, 아래의 시험 앱 PiP 설정 누락을 뒤늦게 확인했다. 이 초기 무음 측정만으로 실제 앱의 무음 원인이나 수정 효과를 확정하지 않는다.
- 탐색 중 재생 요청은 의도만 저장하고 탐색 완료 후 적용하는 후보를 검사했다. 탐색 중 배속 변경도 실제 재생기에 즉시 적용하지 않으며, 직접 정지·새 탐색·소스 교체는 기존 revision 보호를 유지한다. 탐색 완료 직후 재생 방식 변경과 오디오 세션 활성화 시점 변경은 성공·실패가 반복돼 단독 원인으로 채택하지 않았다.
- 자동 버퍼 대기를 유지하되, progressive 파일의 현재 위치부터 재생 배속 기준1초 분량이 확보됐는데 예측 대기만 지속되면 재개한다. 동일 위치·동일 버퍼의 반복 재개는 차단한다. 데이터 부족·탐색 중·명시적 정지·오류 상태는 재개하지 않으며 HLS는 기존 정책을 유지한다. UI·자동 PiP 구조와 웹/Android 재생 경로는 변경하지 않는다.
- 회귀 검사: 실제 AVPlayer KVO와 버퍼 복구/정지/탐색/소스 교체/불연속 버퍼/배속/짧은 마지막 구간 테스트 통과. 현재 앱 코드 직접 연결 시뮬레이터에서 연속 재생·정지/재개·양방향 탐색·영상 교체를 추가 검증 중이다. iPad는 잠금 상태이므로 이번 수정본의 실기기 오디오/PiP 수용 검증은 아직 완료하지 않았다.
- 진단 비교 기록: `/tmp/muzio-resource-proof/audio-direct-long.log`, `/tmp/muzio-buffer-recovery-proof/run.log`, `/tmp/muzio-buffer-recovery-proof/serial/run.log`. 직접 서버 연결 조건은 유지하며, 인덱스 캐시 성능 검증과 재생 안정성 검증을 혼동하지 않는다.

### 진단 환경 보정

- 최소 AVPlayer 기준 재생기는 같은 서버·파일·이어보기 위치에서 반복해120초 이상 영상/PCM을 공급했다. 같은 오디오 세션 설정도 통과했지만 PiP controller를 추가한 시험에서 PCM 정체가 나타났다.
- 진단 앱의 Info.plist에 `UIBackgroundModes=audio`가 빠져 있었다. 실제 Muzio에는 이미 있는 설정이며 Apple의 PiP 필수 구성이다. 이를 맞춘 최소 PiP 재생기는120초 연속 검사에 통과했다. 잘못된 fixture의 결과를 실제 앱의 원인 증거로 승격하지 않는다. 보정한 환경에서 제품 코드 전체 경로를 다시 검사한다.
- 오디오 측정은 최종 스피커 출력을 직접 녹음한 것이 아니라 audioMix의 PCM 관찰이다. 볼륨1 비교 및 Float32 형식 확인을 수행했고, 후속 진단용 tap에는 실시간 lock을 제거하고 요청/반환 프레임·소스 시간·종료/불연속 상태를 추가했다. 이 진단 도구는 앱 배포 코드에 넣지 않는다.

## Apple 영상의 공유 웹 플레이어 복귀 — 2026-09-08

- 사용자 요청으로 자동 PiP를 위한 별도 Apple 영상 재생기 사용을 중단했다. 오디오 소실과 무한 버퍼링의 단일 원인은 확정하지 못했다. 일부 진단의 PCM 관찰 장치가 재생 파이프라인 재구성을 일으킨 것도 확인돼, 그 결과만으로 제품 결함 원인을 단정하지 않는다. 서버에서 읽은 문제 구간8개의 HTTP206 본문은 원본과 바이트 단위로 일치했다.
- iPhone·iPad도 Mac/일반 웹과 같은 Vidstack HTML video 경로를 사용한다. WebHost의 `nativeVideo` capability·NativeVideoPlayer 생성·별도 AVPlayerLayer·native fullscreen 명령 연결을 제거했다. 웹 컨트롤과 WebKit 전체화면을 사용하며, 자동 PiP는 이번 경로의 지원/검증 대상에서 제외한다. WebKit이 제공하는 수동 PiP 허용은 유지한다. OS에서 불가능하다고 결론낸 것이 아니라 사용자 선택에 따른 제품 롤백이다.
- 미커밋 상태였던 native 재생 의도·버퍼 강제 재개·직접 서버 URL 우회 실험은 철회했다. 앞선 절의 후보 구현/시험 기록은 당시 이력이며 현재 적용 동작이 아니다. 웹/Android의 영상 기능, Apple 네이티브 음악·로컬 곡 기능은 기존 경로를 유지한다.
- `videoIndexBaseUrl` 연결은 유지해 웹 영상이 Apple 로컬 인덱스 캐시를 사용한다. 인덱스 뒤16MiB 시작 데이터, 항목128MiB·전체640MiB/5개 상한, 기존 캐시의 추가 구간만 받는 확장, revision/Range/길이/체크섬 검증을 보존했다. 연결 풀 실험은 포함하지 않는다. 전체 영상을 저장하는 캐시는 아니므로 임의 탐색 위치의 버퍼링까지 없어지는 것은 아니다.
- 검증: 캐시 통합 회귀, iOS 서명 빌드, macOS 컴파일 통과. 로그: `/tmp/muzio-web-video-cache-tests.log`, `/tmp/muzio-web-video-ios-build.log`, `/tmp/muzio-web-video-mac-build.log`.
- 공유 웹 회귀47개 통과: nativeAudio가 있는 iOS에서도 nativeVideo capability가 없거나 false이면 실제 HTML video provider를 선택하고 캐시 URL·이어보기 위치를 유지한다. 네이티브 영상 명령과 투명 레이어가 생성되지 않는 것도 확인했다. 추가한 테스트의 타입 선언을 정리한 뒤 해당 컴포넌트5개와 TypeScript 검사도 통과했다. 웹 제품 코드는 변경하지 않아 서버 UI/Android 자산을 다시 배포하지 않았다. 로그: `/tmp/muzio-web-video-regression.log`, `/tmp/muzio-web-video-component-final.log`, `/tmp/muzio-web-video-types-final.log`.
- 연결된 iPad에1.4.6 수정본을 데이터 유지 업데이트 설치하고 앱 실행까지 성공했다. 설치/실행 로그: `/tmp/muzio-web-video-ipad-install.json`, `/tmp/muzio-web-video-ipad-launch.json`. 실기기 연속 오디오·영상·전체화면·A→B→A 체감 확인은 아직 남아 있으며 컴파일/설치 통과로 대신하지 않는다.


## Android 가로 전체화면 복구 — 2026-09-08

- Android WebView의 전체화면 custom view는 표시했지만 호스트 창의 가로 방향·시스템 바·루트 여백을 함께 전환하지 않았다. 웹과 같은 영상 전체화면 요청을 받으면 가로 방향으로 전환하고 상태/탐색 바 및 루트 여백을 제거한다. 전체화면 버튼과 DOM 전체화면을 요청하는 스와이프가 같은 호스트 처리를 사용한다.
- 전체화면 진입 전 방향·시스템 바 상태를 저장하고 종료 시 복원한다. 중복 종료/재진입을 보호하고 PiP에서 돌아오거나 창 포커스를 되찾으면 전체화면 상태를 다시 적용한다. 회전 시 WebView/영상 요소를 재생성하지 않는다. 웹·Apple 플레이어 디자인과 영상 비율 설정은 변경하지 않는다.
- 검증 결과와 실기기 설치 여부는 `android_app/VALIDATION.md`의 같은 날짜 항목을 따른다. 최신 Android 수정본은 실제 폰에 아직 설치하지 않았으므로 이전 APK 설치 기록을 이번 수정의 수용 결과로 간주하지 않는다.

## 다중선택 조작 및 즉시 강조 — 2026-09-08 / 웹 UI r17

- 현재 누른 행의 hover 색상이 선택 배경을 덮어 다음 행을 누른 뒤에야 선택색이 드러나던 문제를 수정했다. 선택된 행에는 hover 배경을 적용하지 않고 즉시 강조한다. 데스크톱/모바일390px 실제 렌더링에서 두 선택 행이 같은 강조색을 유지함을 확인했다.
- 다중선택 시 상단의 Add to Playlist/닫기 대신 가장 최근 선택한 행 옆에 글래스 원형 +/× 버튼을 표시한다. 마지막 선택을 취소하면 남아 있는 최근 선택 행으로 이동하고, × 또는 모든 항목 선택 해제 시 모드를 종료한다.
- +는 플레이리스트 모달을 연다. 기존 플레이리스트 이름을 누르면 선택 항목을 모두 추가하고 모달과 선택 모드를 종료한다. 중복은 기존 contentKey 기준으로 제외하며, 플레이리스트가 없을 때 새로 만드는 흐름도 유지한다. 모달만 닫으면 선택은 유지한다.
- 웹 회귀48개와 TypeScript/Vite 빌드 통과. 실제 서버가 제공하는 JS/CSS가 빌드 파일과 일치하고 서비스워커r17임을 확인했다. 로그: `/tmp/muzio-selection-final-tests.log`, `/tmp/muzio-selection-final-build.log`.
- 웹·Apple의 서버 공유 UI에 반영된다. Android는 같은 웹 소스를 APK에 포함하므로 다음 일괄 패키징/설치 시 반영되며, 앞선 전체화면 검사용 APK에는 이 후속 UI가 없다. 이번에는 네이티브 코드/브리지 계약 변경이 없어 앱 재패키징을 하지 않았다.


### 다중선택 버튼 배치 후속 — 웹 UI r18

- 개별 곡 동작처럼 보이지 않도록 +/× 버튼을 행 내부에서 제거하고 마지막 선택 행 바로 아래8px에 떠 있는 형태로 옮겼다. 선택 개수 표시를 함께 두고, 원래 행의 텍스트 공간도 복원했다. 행 밖 버튼이 잘리거나 다음 행 뒤에 가려지지 않도록 표시 영역과 겹침 순서를 조정했다.
- 웹 관련 회귀41개·TypeScript/Vite 빌드 결과는 `/tmp/muzio-selection-floating-tests.log`, `/tmp/muzio-selection-floating-build.log`에 기록한다. Android 설치 산출물은 다음 일괄 패키징 시 반영한다.


### 용량·위치 텍스트 선택 제한 — 웹 UI r19

- 목록의 용량·위치(모바일 구분자 포함)에만 user-select:none 및 WebKit touch-callout:none을 적용했다. 제목과 가수명은 텍스트 선택/복사/검색을 유지하고, 용량·위치의 길게 누르기 다중선택 동작도 유지한다. 모바일과 데스크톱 표시에 함께 적용한다.
- LibraryScreen 기존 회귀와 TypeScript/Vite 빌드 검사. 로그: `/tmp/muzio-file-info-selection-tests.log`, `/tmp/muzio-file-info-selection-build.log`. Android는 다음 일괄 패키징에 포함한다.


### 플레이리스트 명시적 생성 — 웹 UI r20

- Add to Playlist의 닫기 왼쪽에 원형 + 버튼을 추가했다. 빈 목록은 안내만 표시하며 +를 눌러야 새 플레이리스트 이름 입력이 열린다. 기존 목록이 있어도 생성할 수 있다.
- 생성·저장 시 새 플레이리스트에 선택 곡을 함께 넣고 선택 모드를 종료한다. 빈 이름은 저장하지 않으며 생성 취소는 기존 목록으로 돌아가 곡 선택을 유지한다. 기존 플레이리스트를 바로 선택해 저장하는 동작도 유지한다.
- LibraryScreen 회귀38개 통과(빈 목록의 미생성 상태, 명시적 생성, 빈 이름 차단, 취소, 다중선택 저장 포함). 로그: `/tmp/muzio-playlist-create-tests.log`. 웹/Apple 서버 UI에 반영하며 Android는 다음 일괄 패키징에 포함한다.
- 추가 검증: App34개도 통과했다. 테스트 검색 옵션의 TypeScript 오류를 수정한 뒤 웹 빌드 통과, 실제 제공 JS/CSS 및 서비스워커r20 일치를 확인했다. 로그: `/tmp/muzio-playlist-create-app-tests.log`, `/tmp/muzio-playlist-create-build.log`.


## 최종 마감 및 1.4.7 이월 — 2026-09-08

- 사용자 요청에 따라 현재 수정까지 1.4.6으로 마감한다. 사용자 표시 버전은 모든 플랫폼에서1.4.6을 유지하고, 1.4.7은 후속 검증 문서만 개설한다.
- 확정 범위: Apple 공유 웹 영상 플레이어 복귀 및 시작 구간 캐시 유지, Android 가로 전체화면 복구, 공용 다중선택 즉시 강조·선택 행 아래 글래스 조작 버튼, 용량/위치 텍스트 선택 제한, 명시적 플레이리스트 생성·선택 곡 저장. 네이티브 Apple 자동 PiP는 사용자 요청으로 철회한 범위이며 다음 버전의 필수 구현으로 재등록하지 않는다.
- 기존 자동검사 증거를 재사용했다: 공유 웹 영상47개, 선택 관련48개, 최종 LibraryScreen38개·App34개, Apple 캐시 통합 검사·iOS 서명/macOS 컴파일, Android JVM25개 및 가로 전체화면 에뮬레이터 확인. 서로 다른 시점의 검사 수를 합쳐 하나의 전체 suite 통과로 표시하지 않는다.
- Android에는 마지막 공용 웹 UI r20을 포함하는 마감 APK를 한 번 패키징했다. Apple은 서버 UI를 읽으므로 r17–r20 변경만으로 iOS를 재빌드하지 않고 기존 웹 영상 복귀 서명본을 유지한다. Mac 배포 ZIP은 후속 Swift 캐시/호스트 변경을 포함하도록 갱신한다. 산출물 위치·해시는 아래 마감 산출물 기록을 따른다.
- 이번 마감에서 기기 설치·실기기 재생은 수행하지 않는다. [update_1.4.7.md](update_1.4.7.md)에 설치, 실제 영상/오디오·캐시·전체화면·PiP·로컬 음악·공통 UI 확인을 미완료 체크리스트로 이월했다. 위 절의 대기·후속 패키징 문구는 해당 시점의 이력이며 이 마감 상태를 우선한다.

### 마감 산출물

- `dist/releases/1.4.6-20260908/Muzio-1.4.6-web-r20-vc14.apk` — SHA-256 `47baf18addf8d343cb56943103a10dde406046d4be83ac8cbf0dc390886b9fd1`.
- `dist/releases/1.4.6-20260908/Muzio-1.4.6-macOS-universal.zip` — SHA-256 `a5f961a2bfe76f1ab27194800fee6484c0da607f6ff2ecedcc7abbab39f23ff2`.
- Android `:app:assembleDebug` exit0, 10초. APK 내부 `assets/muzio-web/sw.js`의 `1.4.6-r20` 및 JS 번들 포함 확인. 로그: `/tmp/muzio-146-close-android-build.log`. 네이티브 입력은 기존 JVM25개 통과 이후 바뀌지 않아 단위 검사를 다시 실행하지 않았다.
- Mac Release arm64/x86_64 universal build exit0, ad-hoc 서명 검증 및 ZIP 생성. 로그: `/tmp/muzio-146-close-mac-build.log`. 공증·스토어 배포는 하지 않았다. 앞선 `dist/apple` 파일은 이전 산출물이며 위 경로를 최종본으로 사용한다.
- iOS는 `/tmp/muzio-ipad-build/Build/Products/Debug-iphoneos/Muzio.app`의 기존 서명/설치 성공본을 재사용한다. 이후 Swift 제품 변경이 없고 Apple은 서버 공용 UI를 읽으므로 이번에는 다시 패키징/설치하지 않았다. 개발 서명 만료·재연결이 필요한 경우 후속 검증에서 처리한다.
- 마감 버전 검사: `VMA_VERSION=1.4.6 bash scripts/verify_version.sh` 통과. 변경 파일의 whitespace 검사도 통과했다.

### 1.4.7 인계 — 2026-09-10

1.4.6 마감과 탐색·인덱스 캐시 변경 이력은 유지한다. 후속 Apple VLC·공용 UI 및 기기 간 좋아요·플레이리스트 동기화는 [1.4.7](update_1.4.7.md)로 패치하며, 기존 실기기 미확인 항목도 해당 문서에서 계속 관리한다.
