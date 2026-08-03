package httpserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"muzio/backend/internal/audioresume"
	"muzio/backend/internal/library"
)

type fakeAudioResumeCache struct {
	status    audioresume.Status
	path      string
	ready     bool
	requested string
}

func (c *fakeAudioResumeCache) Request(item library.Media) (audioresume.Status, error) {
	c.requested = item.ID
	return c.status, nil
}

func (c *fakeAudioResumeCache) Ready(library.Media) (string, bool) {
	return c.path, c.ready
}

func (c *fakeAudioResumeCache) Status() audioresume.Status { return c.status }

type audioResumeCacheLister struct {
	*stubLister
	cache AudioResumeCache
}

func (l *audioResumeCacheLister) AudioResumeCache() AudioResumeCache {
	return l.cache
}

func TestAudioResumeCacheStatusAndRequestRoutes(t *testing.T) {
	item := library.Media{ID: "aac1", Type: library.MediaTypeAudio, Name: "long.aac"}
	cache := &fakeAudioResumeCache{status: audioresume.Status{
		State:           "ready",
		MediaID:         "old",
		BuildingMediaID: "aac1",
	}}
	lister := &audioResumeCacheLister{
		stubLister: &stubLister{items: []library.Media{item}},
		cache:      cache,
	}
	handler := NewHandler(testLogger(), lister, nil)

	request := httptest.NewRequest(http.MethodPut, "/api/audio-resume-cache/aac1", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusAccepted || cache.requested != "aac1" {
		t.Fatalf("PUT status=%d requested=%q", recorder.Code, cache.requested)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/audio-resume-cache", nil)
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	var status audioresume.Status
	if err := json.NewDecoder(recorder.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status.URL != "/api/audio-resume-cache/media/old" || status.BuildingMediaID != "aac1" {
		t.Fatalf("status = %#v", status)
	}
}

func TestAudioResumeCacheMediaSupportsRangeAndSkipsGzip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cached.m4a")
	if err := os.WriteFile(path, []byte("0123456789"), 0o600); err != nil {
		t.Fatal(err)
	}
	item := library.Media{
		ID:         "aac1",
		Type:       library.MediaTypeAudio,
		Name:       "long.aac",
		SizeBytes:  10,
		ModifiedAt: time.Now(),
	}
	cache := &fakeAudioResumeCache{path: path, ready: true}
	lister := &audioResumeCacheLister{
		stubLister: &stubLister{items: []library.Media{item}},
		cache:      cache,
	}
	handler := NewHandler(testLogger(), lister, nil)
	request := httptest.NewRequest(http.MethodGet, "/api/audio-resume-cache/media/aac1", nil)
	request.Header.Set("Range", "bytes=4-6")
	request.Header.Set("Accept-Encoding", "gzip")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusPartialContent || recorder.Body.String() != "456" {
		t.Fatalf("range status=%d body=%q", recorder.Code, recorder.Body.String())
	}
	if encoding := recorder.Header().Get("Content-Encoding"); encoding != "" {
		t.Fatalf("Content-Encoding = %q", encoding)
	}
	if contentType := recorder.Header().Get("Content-Type"); contentType != "audio/mp4" {
		t.Fatalf("Content-Type = %q", contentType)
	}
}

func TestAudioResumeCacheMediaFallsBackToOriginalStream(t *testing.T) {
	item := library.Media{ID: "aac1", Type: library.MediaTypeAudio, Name: "long.aac"}
	cache := &fakeAudioResumeCache{}
	lister := &audioResumeCacheLister{
		stubLister: &stubLister{items: []library.Media{item}},
		cache:      cache,
	}
	var observedPath string
	fallback := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observedPath = r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	})
	handler := NewHandler(testLogger(), lister, fallback)
	request := httptest.NewRequest(http.MethodGet, "/api/audio-resume-cache/media/aac1", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNoContent || observedPath != "/api/media/aac1" {
		t.Fatalf("fallback status=%d path=%q", recorder.Code, observedPath)
	}
}
