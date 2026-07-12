package httpserver

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"muzio/backend/internal/library"
)

type stubMediaRootsManager struct {
	settings   library.MediaRootSettings
	result     library.MediaRootUpdateResult
	items      []library.Media
	persistent bool
	rescanned  bool
}

func (s *stubMediaRootsManager) List(filter library.MediaType) []library.Media {
	return s.items
}

func (s *stubMediaRootsManager) Get(id string) (library.Media, error) {
	return library.Media{}, library.ErrNotFound
}

func (s *stubMediaRootsManager) MediaRootSettings() library.MediaRootSettings {
	return s.settings
}

func (s *stubMediaRootsManager) MediaRootsPersistent() bool {
	return s.persistent
}

func (s *stubMediaRootsManager) DegradedRoots() []library.DegradedRoot {
	return s.result.DegradedRoots
}

func (s *stubMediaRootsManager) IndexStatus() library.IndexStatus {
	return library.IndexStatus{Enabled: true, LoadedItems: s.result.ItemCount}
}

func (s *stubMediaRootsManager) WatcherStatus() library.WatcherStatus {
	return library.WatcherStatus{
		Enabled: true,
		Backend: "test",
		Roots: []library.WatcherRootStatus{{
			Path:    "/music",
			Enabled: true,
			Backend: "test",
		}},
	}
}

func (s *stubMediaRootsManager) UpdateMediaRoots(settings library.MediaRootSettings) (library.MediaRootUpdateResult, error) {
	s.settings = settings
	if s.result.Settings.AudioRoots == nil && s.result.Settings.VideoRoots == nil {
		s.result.Settings = settings
	}
	return s.result, nil
}

func (s *stubMediaRootsManager) RescanMediaRoots() (library.MediaRootUpdateResult, error) {
	s.rescanned = true
	if s.result.Settings.AudioRoots == nil && s.result.Settings.VideoRoots == nil {
		s.result.Settings = s.settings
	}
	return s.result, nil
}

func TestMediaRootsGetReturnsCurrentSettings(t *testing.T) {
	manager := &stubMediaRootsManager{
		settings: library.MediaRootSettings{
			AudioRoots: []string{"/music"},
			VideoRoots: []string{"/video"},
			ImageRoots: []string{"/images"},
		},
		persistent: true,
		result: library.MediaRootUpdateResult{DegradedRoots: []library.DegradedRoot{{
			Name:  "video-deadbeef",
			Path:  "/video",
			Error: "connection reset",
		}}},
	}
	handler := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), manager, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/settings/media-roots", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body mediaRootsResponse
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.AudioRoots[0] != "/music" || body.VideoRoots[0] != "/video" || body.ImageRoots[0] != "/images" {
		t.Fatalf("body = %#v", body)
	}
	if !body.Persistent {
		t.Fatalf("Persistent = false, want true")
	}
	if len(body.Degraded) != 1 || body.Degraded[0].Path != "/video" {
		t.Fatalf("Degraded = %#v", body.Degraded)
	}
	if !body.Index.Enabled {
		t.Fatalf("Index = %#v", body.Index)
	}
	if !body.Watcher.Enabled || body.Watcher.Backend != "test" {
		t.Fatalf("Watcher = %#v", body.Watcher)
	}
}

func TestMediaRootsPutUpdatesSettings(t *testing.T) {
	manager := &stubMediaRootsManager{
		result: library.MediaRootUpdateResult{ItemCount: 2, Persistent: true},
	}
	handler := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), manager, nil)
	body := bytes.NewBufferString(`{"audioRoots":["/music"],"videoRoots":["/video"],"imageRoots":["/images"]}`)

	req := httptest.NewRequest(http.MethodPut, "/api/settings/media-roots", body)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if manager.settings.AudioRoots[0] != "/music" {
		t.Fatalf("settings = %#v", manager.settings)
	}
	if manager.settings.ImageRoots[0] != "/images" {
		t.Fatalf("settings = %#v", manager.settings)
	}
	var response mediaRootsResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if response.ItemCount != 2 || !response.Persistent {
		t.Fatalf("response = %#v", response)
	}
}

func TestMediaRootsPostRescansCurrentSettings(t *testing.T) {
	manager := &stubMediaRootsManager{
		settings: library.MediaRootSettings{AudioRoots: []string{"/music"}, ImageRoots: []string{"/images"}},
		result: library.MediaRootUpdateResult{
			ItemCount: 3,
			DegradedRoots: []library.DegradedRoot{{
				Name:  "music-deadbeef",
				Path:  "/music",
				Error: "permission denied",
			}},
		},
	}
	handler := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), manager, nil)

	req := httptest.NewRequest(http.MethodPost, "/api/settings/media-roots", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !manager.rescanned {
		t.Fatalf("RescanMediaRoots was not called")
	}
	var response mediaRootsResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if response.ItemCount != 3 || response.AudioRoots[0] != "/music" || response.ImageRoots[0] != "/images" {
		t.Fatalf("response = %#v", response)
	}
	if len(response.Degraded) != 1 || response.Degraded[0].Path != "/music" {
		t.Fatalf("degraded roots = %#v", response.Degraded)
	}
}
