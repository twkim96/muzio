# Update 1.3.15 - Embedded M4A Artist Metadata

## 목표

M4A에 저장된 embedded artist metadata를 읽어 `Music-e45c6951` 같은
media-root fallback 대신 실제 아티스트를 음악 목록과 플레이어에 표시한다.

## 확인된 원인

- 예시 `010_guitar(260803).m4a`에는 `artist=010_guitar` 태그가 존재한다.
- 기존 backend metadata는 파일명에서 `아티스트 - 제목` 형식만 추론한다.
- 해당 패턴이 없으면 `metadata.artist`가 비고, web UI가 `rootName`을 artist로
  표시한다.

## 확정 동작

- M4A의 iTunes-style `moov/udta/meta/ilst/©ART/data` 값을 artist로 사용한다.
- 일부 writer의 `moov/meta/ilst` 배치도 허용한다.
- embedded artist는 파일명으로 추론한 artist보다 우선한다.
- title, album 등 이번 요청과 무관한 metadata 정책은 변경하지 않는다.
- M4A 태그가 없거나 손상됐거나 UTF-8이 아니면 기존 fallback을 유지한다.
- MP3, FLAC, AAC 등 다른 형식의 기존 metadata 동작은 변경하지 않는다.
- 파일마다 ffprobe 프로세스를 실행하지 않고 필요한 MP4 atom만 random-read한다.

## 구현

- [x] bounded M4A atom reader 추가
- [x] 32-bit 및 extended-size atom 처리
- [x] 최대 artist payload를 64 KiB로 제한
- [x] full scan과 watcher 단일 파일 scan 모두 embedded metadata 적용
- [x] 기존 `Metadata.Artist` API 계약 유지
- [x] 버전 표기를 `1.3.15`로 갱신
- [x] README 제품 계약 및 capability 갱신

## 검증

- [x] embedded artist가 파일명 fallback을 덮어쓰는 unit test
- [x] 손상된 M4A와 비-M4A가 fallback을 유지하는 unit test
- [x] 기존 metadata 추론 test 통과
- [x] `backend/internal/library` 전체 test 통과
- [x] 실제 예시 파일에서 새 parser가 `artist=010_guitar`를 읽는지 확인
- [x] fixture 전체 scan에서 `Metadata.Artist=010_guitar` 확인
- [x] frontend 전체 test: 44 files, 466 tests 통과
- [x] TypeScript/Vite production build 통과
- [x] `go test ./...` 전체 통과
- [x] `go vet ./...` 통과
- [x] cache/HTTP/server 관련 `go test -race` 통과
- [x] production 배포 및 library refresh 후 API artist 반영 확인
- [ ] 실제 브라우저 UI 표시 확인

## 완료 기준

- [x] M4A artist tag를 읽는 구현과 scanner 연결이 완료된다.
- [x] 태그 실패가 library scan을 실패시키지 않는다.
- [x] scanner/API 계약이 예시 곡의 artist를 `010_guitar`로 제공한다.
- [ ] 배포된 UI의 Artist 열과 player metadata에서 `010_guitar`를 확인한다.

## 범위 제외

- 모든 오디오 컨테이너의 범용 tag parser
- title/album/date/album_artist 표시 정책 변경
- root 이름 변경 또는 media-root migration
- 파일별 ffprobe 실행
