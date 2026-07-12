package httpserver

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"muzio/backend/internal/library"
)

type stubLister struct {
	calledWith library.MediaType
	items      []library.Media
}

func (s *stubLister) List(filter library.MediaType) []library.Media {
	s.calledWith = filter
	return s.items
}

func (s *stubLister) Get(id string) (library.Media, error) {
	for _, item := range s.items {
		if item.ID == id {
			return item, nil
		}
	}
	return library.Media{}, library.ErrNotFound
}

func newTestHandlerWithLibrary(items []library.Media) (http.Handler, *stubLister) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	stub := &stubLister{items: items}
	return NewHandler(logger, stub, nil), stub
}

func sampleLibrary() []library.Media {
	now := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	return []library.Media{
		{
			ID:           "abcd1234",
			Type:         library.MediaTypeVideo,
			RootName:     "movies",
			RelativePath: "Inception/Inception.mkv",
			Name:         "Inception.mkv",
			MIMEType:     "video/x-matroska",
			SizeBytes:    8589934592,
			ModifiedAt:   now,
		},
		{
			ID:           "efgh5678",
			Type:         library.MediaTypeAudio,
			RootName:     "music",
			RelativePath: "Album/song.mp3",
			Name:         "song.mp3",
			MIMEType:     "audio/mpeg",
			SizeBytes:    5242880,
			ModifiedAt:   now,
		},
		{
			ID:           "ijkl9012",
			Type:         library.MediaTypeImage,
			RootName:     "images",
			RelativePath: "cover.jpg",
			Name:         "cover.jpg",
			MIMEType:     "image/jpeg",
			SizeBytes:    1048576,
			ModifiedAt:   now,
		},
	}
}

func TestLibraryListReturnsAllItems(t *testing.T) {
	handler, stub := newTestHandlerWithLibrary(sampleLibrary())

	req := httptest.NewRequest(http.MethodGet, "/api/library", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q", got)
	}
	if stub.calledWith != "" {
		t.Fatalf("filter = %q, want empty (all)", stub.calledWith)
	}

	var body libraryListResponse
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Items) != 3 {
		t.Fatalf("len(items) = %d, want 3", len(body.Items))
	}
}

func TestLibraryListSupportsGzip(t *testing.T) {
	handler, _ := newTestHandlerWithLibrary(sampleLibrary())

	req := httptest.NewRequest(http.MethodGet, "/api/library", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := rec.Header().Get("Vary"); got != "Accept-Encoding" {
		t.Fatalf("Vary = %q, want Accept-Encoding", got)
	}
	reader, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	defer reader.Close()
	var body libraryListResponse
	if err := json.NewDecoder(reader).Decode(&body); err != nil {
		t.Fatalf("decode gzip body: %v", err)
	}
	if len(body.Items) != 3 {
		t.Fatalf("len(items) = %d, want 3", len(body.Items))
	}
}

func TestLibraryListDoesNotGzipNotModified(t *testing.T) {
	handler, _ := newTestHandlerWithLibrary(sampleLibrary())

	first := httptest.NewRecorder()
	handler.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/api/library", nil))
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("missing ETag")
	}

	req := httptest.NewRequest(http.MethodGet, "/api/library", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("If-None-Match", etag)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotModified {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotModified)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want empty", got)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("body length = %d, want 0", rec.Body.Len())
	}
}

func TestLibraryListAcceptsTypeAll(t *testing.T) {
	handler, stub := newTestHandlerWithLibrary(sampleLibrary())

	req := httptest.NewRequest(http.MethodGet, "/api/library?type=all", nil)
	handler.ServeHTTP(httptest.NewRecorder(), req)

	if stub.calledWith != "" {
		t.Fatalf("filter = %q, want empty for type=all", stub.calledWith)
	}
}

func TestLibraryListFiltersByVideo(t *testing.T) {
	handler, stub := newTestHandlerWithLibrary(sampleLibrary())

	req := httptest.NewRequest(http.MethodGet, "/api/library?type=video", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if stub.calledWith != library.MediaTypeVideo {
		t.Fatalf("filter = %q, want %q", stub.calledWith, library.MediaTypeVideo)
	}
}

func TestLibraryListFiltersByAudio(t *testing.T) {
	handler, stub := newTestHandlerWithLibrary(sampleLibrary())

	req := httptest.NewRequest(http.MethodGet, "/api/library?type=audio", nil)
	handler.ServeHTTP(httptest.NewRecorder(), req)

	if stub.calledWith != library.MediaTypeAudio {
		t.Fatalf("filter = %q, want %q", stub.calledWith, library.MediaTypeAudio)
	}
}

func TestLibraryListFiltersByImage(t *testing.T) {
	handler, stub := newTestHandlerWithLibrary(sampleLibrary())

	req := httptest.NewRequest(http.MethodGet, "/api/library?type=image", nil)
	handler.ServeHTTP(httptest.NewRecorder(), req)

	if stub.calledWith != library.MediaTypeImage {
		t.Fatalf("filter = %q, want %q", stub.calledWith, library.MediaTypeImage)
	}
}

func TestLibraryListRejectsUnknownType(t *testing.T) {
	handler, _ := newTestHandlerWithLibrary(sampleLibrary())

	req := httptest.NewRequest(http.MethodGet, "/api/library?type=document", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestLibraryListRejectsNonGet(t *testing.T) {
	handler, _ := newTestHandlerWithLibrary(sampleLibrary())

	req := httptest.NewRequest(http.MethodPost, "/api/library", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}

func TestLibraryListReturnsEmptyArrayWhenNoItems(t *testing.T) {
	handler, _ := newTestHandlerWithLibrary(nil)

	req := httptest.NewRequest(http.MethodGet, "/api/library", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var body libraryListResponse
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Items == nil || len(body.Items) != 0 {
		t.Fatalf("body = %#v, want empty items array", body)
	}
}

func TestLibraryListUsesRevisionETag(t *testing.T) {
	service, err := library.NewService(
		library.MediaRootSettings{},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	service.ApplyChanges(sampleLibrary(), nil)
	handler := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), service, nil)

	first := httptest.NewRecorder()
	handler.ServeHTTP(
		first,
		httptest.NewRequest(http.MethodGet, "/api/library?type=audio", nil),
	)
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("missing ETag")
	}
	var body libraryListResponse
	if err := json.NewDecoder(first.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Revision != service.Revision() {
		t.Fatalf("revision = %d, want %d", body.Revision, service.Revision())
	}

	request := httptest.NewRequest(http.MethodGet, "/api/library?type=audio", nil)
	request.Header.Set("If-None-Match", etag)
	second := httptest.NewRecorder()
	handler.ServeHTTP(second, request)
	if second.Code != http.StatusNotModified || second.Body.Len() != 0 {
		t.Fatalf("response = %d %q", second.Code, second.Body.String())
	}

	video := sampleLibrary()[0]
	video.Name = "changed.mp4"
	service.ApplyChanges([]library.Media{video}, nil)
	unchangedAudio := httptest.NewRecorder()
	handler.ServeHTTP(unchangedAudio, request)
	if unchangedAudio.Code != http.StatusNotModified {
		t.Fatalf("audio response after video change = %d, want 304", unchangedAudio.Code)
	}
}

func TestLibraryChangesReturnsDeltaAndJournalGap(t *testing.T) {
	service, err := library.NewService(
		library.MediaRootSettings{},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	base := service.Revision()
	service.ApplyChanges(sampleLibrary(), nil)
	handler := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), service, nil)

	response := httptest.NewRecorder()
	handler.ServeHTTP(
		response,
		httptest.NewRequest(
			http.MethodGet,
			"/api/library/changes?since="+strconv.FormatUint(base, 10)+"&type=audio",
			nil,
		),
	)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var changes library.SnapshotChanges
	if err := json.NewDecoder(response.Body).Decode(&changes); err != nil {
		t.Fatal(err)
	}
	if changes.ResetRequired || len(changes.Upserts) != 1 ||
		changes.Upserts[0].Type != library.MediaTypeAudio {
		t.Fatalf("changes = %#v", changes)
	}
	deltaETag := response.Header().Get("ETag")
	full := httptest.NewRecorder()
	handler.ServeHTTP(
		full,
		httptest.NewRequest(http.MethodGet, "/api/library?type=audio", nil),
	)
	if deltaETag == "" || deltaETag != full.Header().Get("ETag") {
		t.Fatalf("delta ETag = %q, full ETag = %q", deltaETag, full.Header().Get("ETag"))
	}

	gap := httptest.NewRecorder()
	handler.ServeHTTP(
		gap,
		httptest.NewRequest(
			http.MethodGet,
			"/api/library/changes?since=999999&type=audio",
			nil,
		),
	)
	if err := json.NewDecoder(gap.Body).Decode(&changes); err != nil {
		t.Fatal(err)
	}
	if !changes.ResetRequired {
		t.Fatalf("gap changes = %#v", changes)
	}
}
