package streaming

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"muzio/backend/internal/library"
	"muzio/backend/internal/mediapath"
)

type fakeLookup struct {
	media     library.Media
	err       error
	missingID *string
}

func (f fakeLookup) ReportMissingMedia(id string) {
	if f.missingID != nil {
		*f.missingID = id
	}
}

func (f fakeLookup) Get(id string) (library.Media, error) {
	if f.err != nil {
		return library.Media{}, f.err
	}
	if id != f.media.ID {
		return library.Media{}, library.ErrNotFound
	}
	return f.media, nil
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func bufferLogger(buf *bytes.Buffer) *slog.Logger {
	return slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{
		AddSource: false,
		Level:     slog.LevelDebug,
	}))
}

func newFixture(t *testing.T, body string, name string) (*mediapath.Roots, library.Media) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	roots, err := mediapath.NewRoots([]string{dir})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}
	root := roots.All()[0]
	info, _ := os.Stat(path)
	media := library.Media{
		ID:           "fixture-id",
		Type:         library.MediaTypeAudio,
		RootName:     root.Name,
		RelativePath: name,
		Name:         name,
		SizeBytes:    info.Size(),
		ModifiedAt:   info.ModTime(),
	}
	return roots, media
}

func TestHandlerReturnsFullBodyWithoutRange(t *testing.T) {
	body := "0123456789abcdef"
	roots, media := newFixture(t, body, "song.mp3")
	h := Handler(roots, fakeLookup{media: media}, discardLogger())

	req := httptest.NewRequest(http.MethodGet, "/api/media/"+media.ID, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "audio/mpeg" {
		t.Fatalf("Content-Type = %q, want audio/mpeg", got)
	}
	if got := rec.Header().Get("Accept-Ranges"); got != "bytes" {
		t.Fatalf("Accept-Ranges = %q, want bytes", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, no-transform" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := rec.Header().Get("ETag"); got == "" || !strings.HasPrefix(got, `W/"fixture-id-`) {
		t.Fatalf("ETag = %q, want weak media validator", got)
	}
	if rec.Body.String() != body {
		t.Fatalf("body = %q, want %q", rec.Body.String(), body)
	}
}

func TestHandlerReturnsPartialContentForRangeRequest(t *testing.T) {
	body := "0123456789abcdef" // 16 bytes
	roots, media := newFixture(t, body, "song.mp3")
	h := Handler(roots, fakeLookup{media: media}, discardLogger())

	req := httptest.NewRequest(http.MethodGet, "/api/media/"+media.ID, nil)
	req.Header.Set("Range", "bytes=4-9")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", rec.Code)
	}
	if got := rec.Body.String(); got != "456789" {
		t.Fatalf("body = %q, want %q", got, "456789")
	}
	if got := rec.Header().Get("Content-Range"); got != fmt.Sprintf("bytes 4-9/%d", len(body)) {
		t.Fatalf("Content-Range = %q", got)
	}
	if got := rec.Header().Get("Content-Length"); got != "6" {
		t.Fatalf("Content-Length = %q, want 6", got)
	}
	if got := rec.Header().Get("ETag"); got == "" || !strings.HasPrefix(got, `W/"fixture-id-`) {
		t.Fatalf("ETag = %q, want weak media validator", got)
	}
}

func TestHandlerReturnsRandomSeekRangeWithCacheHeaders(t *testing.T) {
	body := "0123456789abcdefghijklmnopqrstuvwxyz"
	roots, media := newFixture(t, body, "song.mp3")
	h := Handler(roots, fakeLookup{media: media}, discardLogger())

	req := httptest.NewRequest(http.MethodGet, "/api/media/"+media.ID, nil)
	req.Header.Set("Range", "bytes=20-25")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", rec.Code)
	}
	if got := rec.Body.String(); got != "klmnop" {
		t.Fatalf("body = %q, want klmnop", got)
	}
	if got := rec.Header().Get("Content-Range"); got != fmt.Sprintf("bytes 20-25/%d", len(body)) {
		t.Fatalf("Content-Range = %q", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, no-transform" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := rec.Header().Get("ETag"); got == "" || !strings.HasPrefix(got, `W/"fixture-id-`) {
		t.Fatalf("ETag = %q, want weak media validator", got)
	}
}

func TestHandlerLogsRangeDiagnosticsWithoutLeakingPaths(t *testing.T) {
	body := "0123456789abcdef"
	roots, media := newFixture(t, body, "song.mp3")
	var logs bytes.Buffer
	h := Handler(roots, fakeLookup{media: media}, bufferLogger(&logs))

	req := httptest.NewRequest(http.MethodGet, "/api/media/"+media.ID, nil)
	req.Header.Set("Range", "bytes=4-9")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	logText := logs.String()
	for _, want := range []string{
		`msg="media stream"`,
		`id=fixture-id`,
		`type=audio`,
		`method=GET`,
		`request_kind=partial_get`,
		`range="bytes=4-9"`,
		`status=206`,
		`bytes=6`,
		`duration_ms=`,
	} {
		if !strings.Contains(logText, want) {
			t.Fatalf("log missing %q in %s", want, logText)
		}
	}
	for _, root := range roots.All() {
		if strings.Contains(logText, root.Path) {
			t.Fatalf("log leaked root path %q in %s", root.Path, logText)
		}
	}
	if strings.Contains(logText, media.RelativePath) {
		t.Fatalf("log leaked relative path %q in %s", media.RelativePath, logText)
	}
}

func TestHandlerLogsHeadDiagnostics(t *testing.T) {
	body := "0123456789"
	roots, media := newFixture(t, body, "song.mp3")
	var logs bytes.Buffer
	h := Handler(roots, fakeLookup{media: media}, bufferLogger(&logs))

	req := httptest.NewRequest(http.MethodHead, "/api/media/"+media.ID, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	logText := logs.String()
	for _, want := range []string{
		`method=HEAD`,
		`request_kind=head`,
		`status=200`,
		`bytes=0`,
	} {
		if !strings.Contains(logText, want) {
			t.Fatalf("log missing %q in %s", want, logText)
		}
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD returned body of len %d", rec.Body.Len())
	}
}

func TestMediaResponseRecorderUnwrapsUnderlyingWriter(t *testing.T) {
	rec := httptest.NewRecorder()
	wrapped := &mediaResponseRecorder{ResponseWriter: rec}
	if wrapped.Unwrap() != rec {
		t.Fatal("Unwrap did not return the underlying writer")
	}
}

type readFromResponseWriter struct {
	*httptest.ResponseRecorder
	readFromCalled bool
}

func (w *readFromResponseWriter) ReadFrom(r io.Reader) (int64, error) {
	w.readFromCalled = true
	return io.Copy(w.Body, r)
}

func TestMediaResponseRecorderDelegatesReadFrom(t *testing.T) {
	rec := &readFromResponseWriter{ResponseRecorder: httptest.NewRecorder()}
	wrapped := &mediaResponseRecorder{ResponseWriter: rec}

	n, err := wrapped.ReadFrom(strings.NewReader("abcdef"))
	if err != nil {
		t.Fatalf("ReadFrom returned error: %v", err)
	}
	if !rec.readFromCalled {
		t.Fatal("ReadFrom did not delegate to the underlying writer")
	}
	if n != 6 {
		t.Fatalf("ReadFrom bytes = %d, want 6", n)
	}
	if wrapped.bytes != 6 {
		t.Fatalf("recorded bytes = %d, want 6", wrapped.bytes)
	}
	if wrapped.statusOrOK() != http.StatusOK {
		t.Fatalf("status = %d, want 200", wrapped.statusOrOK())
	}
	if got := rec.Body.String(); got != "abcdef" {
		t.Fatalf("body = %q", got)
	}
}

func TestHandlerReturnsRangeNotSatisfiable(t *testing.T) {
	body := "abcdefghij"
	roots, media := newFixture(t, body, "song.mp3")
	h := Handler(roots, fakeLookup{media: media}, discardLogger())

	req := httptest.NewRequest(http.MethodGet, "/api/media/"+media.ID, nil)
	req.Header.Set("Range", "bytes=999-")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("status = %d, want 416", rec.Code)
	}
}

func TestHandlerHEADReturnsHeadersWithoutBody(t *testing.T) {
	body := "0123456789"
	roots, media := newFixture(t, body, "song.mp3")
	h := Handler(roots, fakeLookup{media: media}, discardLogger())

	req := httptest.NewRequest(http.MethodHead, "/api/media/"+media.ID, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD returned body of len %d", rec.Body.Len())
	}
	if got := rec.Header().Get("Content-Length"); got != "10" {
		t.Fatalf("Content-Length = %q, want 10", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, no-transform" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := rec.Header().Get("ETag"); got == "" || !strings.HasPrefix(got, `W/"fixture-id-`) {
		t.Fatalf("ETag = %q, want weak media validator", got)
	}
}

func TestMediaWeakETagSanitizesQuotedParts(t *testing.T) {
	etag := mediaWeakETag(`bad"id\part`, 16, time.Unix(10, 20))
	if strings.Contains(etag, `bad"id\part`) {
		t.Fatalf("ETag did not sanitize media id: %q", etag)
	}
	if !strings.HasPrefix(etag, `W/"bad_id_part-`) {
		t.Fatalf("ETag = %q", etag)
	}
}

func TestHandlerRejectsUnsupportedMethod(t *testing.T) {
	roots, media := newFixture(t, "x", "song.mp3")
	h := Handler(roots, fakeLookup{media: media}, discardLogger())

	req := httptest.NewRequest(http.MethodPost, "/api/media/"+media.ID, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
	if got := rec.Header().Get("Allow"); !strings.Contains(got, "GET") {
		t.Fatalf("Allow = %q", got)
	}
}

func TestHandlerReturns404ForMissingID(t *testing.T) {
	roots, media := newFixture(t, "x", "song.mp3")
	h := Handler(roots, fakeLookup{media: media}, discardLogger())

	req := httptest.NewRequest(http.MethodGet, "/api/media/nonexistent", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestHandlerReturns400ForEmptyID(t *testing.T) {
	roots, media := newFixture(t, "x", "song.mp3")
	h := Handler(roots, fakeLookup{media: media}, discardLogger())

	req := httptest.NewRequest(http.MethodGet, "/api/media/", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestHandlerRejectsTrailingPathSegment(t *testing.T) {
	// Regression: "/api/media/{id}/extra" must not be silently truncated to
	// "{id}". Doing so would let any URL longer than the canonical form serve
	// real bytes, which is a contract violation even if the same media is
	// reachable through the canonical URL.
	roots, media := newFixture(t, "0123456789abcdef", "song.mp3")
	h := Handler(roots, fakeLookup{media: media}, discardLogger())

	cases := []string{
		"/api/media/" + media.ID + "/extra",
		"/api/media/" + media.ID + "/",
		"/api/media/" + media.ID + "/nested/path",
	}
	for _, p := range cases {
		req := httptest.NewRequest(http.MethodGet, p, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("GET %q status = %d, want 400", p, rec.Code)
		}
		if rec.Body.Len() > 0 && strings.Contains(rec.Body.String(), "0123456789abcdef") {
			t.Errorf("GET %q leaked file content", p)
		}
	}
}

func TestHandlerReturns404WhenLibraryRecordPointsToMissingFile(t *testing.T) {
	dir := t.TempDir()
	roots, err := mediapath.NewRoots([]string{dir})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}
	media := library.Media{
		ID:           "fixture-id",
		Type:         library.MediaTypeAudio,
		RootName:     roots.All()[0].Name,
		RelativePath: "ghost.mp3",
		Name:         "ghost.mp3",
		ModifiedAt:   time.Now(),
	}
	var missingID string
	h := Handler(roots, fakeLookup{media: media, missingID: &missingID}, discardLogger())

	req := httptest.NewRequest(http.MethodGet, "/api/media/"+media.ID, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if missingID != media.ID {
		t.Fatalf("missing ID = %q, want %q", missingID, media.ID)
	}
}

func TestHandlerPreservesCachedRecordWhenRootIsUnavailable(t *testing.T) {
	dir := t.TempDir()
	roots, err := mediapath.NewRoots([]string{dir})
	if err != nil {
		t.Fatal(err)
	}
	media := library.Media{
		ID:           "fixture-id",
		Type:         library.MediaTypeAudio,
		RootName:     roots.All()[0].Name,
		RelativePath: "ghost.mp3",
		Name:         "ghost.mp3",
	}
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	var missingID string
	h := Handler(roots, fakeLookup{media: media, missingID: &missingID}, discardLogger())

	req := httptest.NewRequest(http.MethodGet, "/api/media/"+media.ID, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if missingID != "" {
		t.Fatalf("unavailable root removed cached ID %q", missingID)
	}
}

func TestHandlerReturns403WhenSymlinkEscapesRoot(t *testing.T) {
	dir := t.TempDir()
	external := t.TempDir()
	if err := os.WriteFile(filepath.Join(external, "secret.mp3"), []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.Symlink(filepath.Join(external, "secret.mp3"), filepath.Join(dir, "leak.mp3")); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	roots, _ := mediapath.NewRoots([]string{dir})
	media := library.Media{
		ID:           "fixture-id",
		Type:         library.MediaTypeAudio,
		RootName:     roots.All()[0].Name,
		RelativePath: "leak.mp3",
		Name:         "leak.mp3",
	}
	h := Handler(roots, fakeLookup{media: media}, discardLogger())

	req := httptest.NewRequest(http.MethodGet, "/api/media/"+media.ID, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

func TestHandlerReturns404ForUnknownRoot(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "song.mp3"), []byte("a"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	roots, _ := mediapath.NewRoots([]string{dir})
	media := library.Media{
		ID:           "fixture-id",
		Type:         library.MediaTypeAudio,
		RootName:     "stale-root-name",
		RelativePath: "song.mp3",
		Name:         "song.mp3",
	}
	h := Handler(roots, fakeLookup{media: media}, discardLogger())

	req := httptest.NewRequest(http.MethodGet, "/api/media/"+media.ID, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestHandlerReturns415WhenExtensionNotClassified(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "weird.xyz")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	roots, _ := mediapath.NewRoots([]string{dir})
	media := library.Media{
		ID:           "fixture-id",
		Type:         library.MediaTypeAudio,
		RootName:     roots.All()[0].Name,
		RelativePath: "weird.xyz",
		Name:         "weird.xyz",
	}
	h := Handler(roots, fakeLookup{media: media}, discardLogger())

	req := httptest.NewRequest(http.MethodGet, "/api/media/"+media.ID, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want 415", rec.Code)
	}
}

func TestHandlerSurfaces500OnUnexpectedLookupError(t *testing.T) {
	dir := t.TempDir()
	roots, _ := mediapath.NewRoots([]string{dir})
	h := Handler(roots, fakeLookup{err: errors.New("boom")}, discardLogger())

	req := httptest.NewRequest(http.MethodGet, "/api/media/anything", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}
