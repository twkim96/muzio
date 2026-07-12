package httpserver

import (
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
)

type cachedThumbnailLister struct {
	*stubLister
	path string
}

func (l *cachedThumbnailLister) ThumbnailPath(library.Media) (string, bool) {
	return l.path, l.path != ""
}

func TestThumbnailHandlerReturnsGeneratedSVG(t *testing.T) {
	item := library.Media{
		ID:         "song-id",
		Type:       library.MediaTypeAudio,
		Name:       "Song.mp3",
		ModifiedAt: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC),
		Metadata:   library.Metadata{Title: "Song"},
		Thumbnail: library.Thumbnail{
			CacheKey: "abc123",
		},
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewHandler(logger, &stubLister{items: []library.Media{item}}, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/thumbnails/song-id", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "image/svg+xml") {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := rec.Header().Get("ETag"); got != `"abc123"` {
		t.Fatalf("ETag = %q, want abc123", got)
	}
	if !strings.Contains(rec.Body.String(), "Song") {
		t.Fatalf("thumbnail body missing title: %s", rec.Body.String())
	}
}

func TestThumbnailHandlerHonorsCacheValidator(t *testing.T) {
	item := library.Media{
		ID:        "song-id",
		Type:      library.MediaTypeAudio,
		Name:      "Song.mp3",
		Metadata:  library.Metadata{Title: "Song"},
		Thumbnail: library.Thumbnail{CacheKey: "abc123"},
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewHandler(logger, &stubLister{items: []library.Media{item}}, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/thumbnails/song-id", nil)
	req.Header.Set("If-None-Match", `"abc123"`)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", rec.Code)
	}
}

func TestThumbnailHandlerServesCachedJPEG(t *testing.T) {
	item := library.Media{
		ID:        "video-id",
		Type:      library.MediaTypeVideo,
		Name:      "Video.mp4",
		Thumbnail: library.Thumbnail{CacheKey: "video-key"},
	}
	path := filepath.Join(t.TempDir(), "video-key.jpg")
	if err := os.WriteFile(path, []byte("jpeg-data"), 0o644); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	lister := &cachedThumbnailLister{
		stubLister: &stubLister{items: []library.Media{item}},
		path:       path,
	}
	handler := NewHandler(logger, lister, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/thumbnails/video-id", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "image/jpeg" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := rec.Header().Get("Cache-Control"); !strings.Contains(got, "immutable") {
		t.Fatalf("Cache-Control = %q", got)
	}
	if rec.Body.String() != "jpeg-data" {
		t.Fatalf("body = %q", rec.Body.String())
	}
}

func TestThumbnailHandlerDoesNotGzipCachedJPEG(t *testing.T) {
	item := library.Media{
		ID:        "video-id",
		Type:      library.MediaTypeVideo,
		Name:      "Video.mp4",
		Thumbnail: library.Thumbnail{CacheKey: "video-key"},
	}
	path := filepath.Join(t.TempDir(), "video-key.jpg")
	if err := os.WriteFile(path, []byte("jpeg-data"), 0o644); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	lister := &cachedThumbnailLister{
		stubLister: &stubLister{items: []library.Media{item}},
		path:       path,
	}
	handler := NewHandler(logger, lister, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/thumbnails/video-id", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want empty", got)
	}
	if rec.Body.String() != "jpeg-data" {
		t.Fatalf("body = %q", rec.Body.String())
	}
}

func TestThumbnailHandlerDoesNotLongCachePendingVideoFallback(t *testing.T) {
	item := library.Media{
		ID:   "video-id",
		Type: library.MediaTypeVideo,
		Name: "Video.mp4",
		Thumbnail: library.Thumbnail{
			CacheKey: "video-key",
			Status:   library.ThumbnailStatusPending,
		},
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewHandler(logger, &stubLister{items: []library.Media{item}}, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/thumbnails/video-id", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestThumbnailHandlerDoesNotLongCachePendingImageFallback(t *testing.T) {
	item := library.Media{
		ID:   "image-id",
		Type: library.MediaTypeImage,
		Name: "Image.png",
		Thumbnail: library.Thumbnail{
			CacheKey: "image-key",
			Status:   library.ThumbnailStatusPending,
		},
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := NewHandler(logger, &stubLister{items: []library.Media{item}}, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/thumbnails/image-id", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("Cache-Control = %q", got)
	}
}
