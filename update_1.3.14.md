# Update 1.3.14 - Latest AAC Resume Cache

## 목표

대용량 원시 AAC의 시간 기반 seek 지연을 줄이기 위해 가장 최근에 30초 이상
재생한 AAC 한 곡만 M4A로 remux하여 이어듣기 캐시로 사용한다.

이 변경은 후속 M4A artist metadata 패치와 함께 `1.3.15` 릴리스에 포함됐다.

## 확정 동작

- 새 AAC는 기존 원본 스트림을 0초부터 즉시 재생한다.
- 재생 위치가 30초 이상이고 현재 캐시 곡과 다르면 백그라운드 remux를 요청한다.
- 새 캐시가 완성되기 전까지 이전 캐시와 이어듣기 슬롯을 유지한다.
- 새 캐시와 슬롯 메타데이터 저장이 모두 성공한 뒤 이전 캐시를 삭제한다.
- 캐시된 최신 곡의 진행기록은 M4A 캐시 URL과 `#t=`로 빠르게 복원한다.
- 캐시되지 않은 과거 곡도 진행기록을 유지하며 기존 원본 AAC `#t=` seek로
  이어듣는다. 이 경우 기존 탐색 지연은 허용한다.
- FFmpeg가 없거나 remux가 실패하면 기존 원본 재생과 진행기록 복원 경로를
  유지한다.
- MP3, M4A, FLAC 등 원시 AAC가 아닌 오디오는 remux 캐시 대상에서 제외한다.

## 캐시 수명주기

```text
AAC 원본 재생
  -> 30초 도달
  -> 현재 캐시 mediaId와 비교
  -> 다르면 임시 M4A remux 시작
  -> 성공: current.json 교체
  -> 새 캐시 활성화
  -> 이전 M4A 삭제

실패 또는 취소
  -> 임시 파일 삭제
  -> 이전 캐시 유지
```

정상 상태의 영구 캐시는 한 곡분이다. 교체 중에는 이전 캐시와 임시 출력으로
인해 일시적으로 두 곡분의 저장공간이 필요할 수 있다.

## 서버 구현

- [x] `backend/internal/audioresume/` 단일 슬롯 캐시 매니저
- [x] AAC 전용 FFmpeg `-c:a copy` 및 `+faststart` M4A remux
- [x] 파일 크기와 수정시각 기반 원본 fingerprint 검증
- [x] 새 요청이 들어오면 이전 미완성 작업 취소
- [x] 성공 전 이전 캐시 보존 및 성공 후 교체
- [x] `current.json` 교체 중단 시 이전 슬롯 metadata backup 복구
- [x] 시작 시 임시 파일과 사용하지 않는 M4A 정리
- [x] 캐시 미준비 또는 무효 상태에서 기존 `/api/media/{id}` fallback
- [x] 캐시 미디어의 HTTP Range 및 gzip 제외 처리
- [x] 설정 디렉터리 아래 `audio-resume-cache/v1/` 경로 추가

### HTTP API

| Method and path | 용도 |
| --- | --- |
| `GET /api/audio-resume-cache` | 현재 ready/building 슬롯 조회 |
| `PUT /api/audio-resume-cache/{id}` | 최신 AAC 캐시 후보 준비 요청 |
| `GET/HEAD /api/audio-resume-cache/media/{id}` | Range 지원 M4A 캐시 스트림 |

## 웹 앱 구현

- [x] 앱 시작 시 현재 캐시 상태 동기화
- [x] AAC가 playing 상태에서 30초에 도달하면 준비 요청
- [x] 동일 mediaId 중복 요청 방지
- [x] 캐시 빌드 상태 polling 및 ready 슬롯 갱신
- [x] 준비된 최신 mediaId의 이어듣기 URL만 캐시 스트림으로 교체
- [x] 다른 mediaId의 진행기록 URL은 기존 `/api/media/{id}#t=...` 유지
- [x] 캐시 URL에는 `audio/mp4` MIME 적용

## 버전 변경

- [x] 1.3.14 구현 단계에서 Web package, lockfile, PWA shell, 설정 화면 갱신
- [x] 후속 artist metadata 패치와 묶어 최종 표기를 `1.3.15`로 승격
- [x] `README.MD` 제품 계약, 저장 경로, HTTP API 갱신

## 검증 결과

- [x] 프런트 전체 테스트: 44 files, 466 tests 통과
- [x] TypeScript 및 Vite production build 통과
- [x] 오디오 캐시 매니저 교체/실패/단일 슬롯 테스트 통과
- [x] 캐시 HTTP 상태·요청·Range·원본 fallback 테스트 통과
- [x] 설치된 실제 FFmpeg로 raw AAC 생성 후 M4A remux 테스트 통과
- [x] 관련 Go 패키지 테스트 통과:
  - `./internal/audioresume`
  - `./internal/config`
  - `./internal/httpserver`
  - `./cmd/server`
- [x] 마지막 변경 기준 `go test ./...` 전체 통과
- [x] cache/HTTP/server 관련 `go test -race` 통과
- [ ] Android Chrome/PWA에서 대용량 실파일 이어듣기 시작 시간 비교
- [x] `1.3.15` production build에 포함해 배포 및 서버 재시작

## 완료 기준

- [x] 캐시된 최신 AAC 한 곡만 빠른 이어듣기 경로를 사용한다.
- [x] 캐시 교체 실패가 기존 캐시와 원본 재생을 손상시키지 않는다.
- [x] 캐시되지 않은 과거 진행기록을 버리지 않는다.
- [x] 새 곡 최초 재생이 remux 완료를 기다리지 않는다.
- [ ] 실기기에서 캐시 경로가 기존 원본 AAC seek보다 유의미하게 빠름을 확인한다.

## 범위 제외

- 전체 음악 라이브러리 remux
- 여러 곡을 보관하는 LRU 캐시
- 바이트 오프셋 기반 진행기록
- AAC sidecar seek index 또는 Media Source Extensions 구현
- 일반-purpose 오디오/비디오 fallback transcoding
