package httpserver

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"muzio/backend/internal/library"
	"muzio/backend/internal/videoopt"
)

type fakeVideoOptimization struct {
	status     videoopt.Status
	path       string
	readyKey   string
	requested  string
	cancelled  string
	clearedID  string
	clearedKey string
	releases   int
}

func (m *fakeVideoOptimization) Status(library.Media) videoopt.Status { return m.status }
func (m *fakeVideoOptimization) Request(item library.Media) (videoopt.Status, error) {
	m.requested = item.ID
	return m.status, nil
}
func (m *fakeVideoOptimization) Cancel(id string) bool { m.cancelled = id; return true }
func (m *fakeVideoOptimization) Clear(id, key string) bool {
	m.clearedID, m.clearedKey = id, key
	return true
}
func (m *fakeVideoOptimization) Acquire(_ library.Media, key string) (videoopt.ReadyFile, bool) {
	if key != m.readyKey || m.path == "" {
		return videoopt.ReadyFile{}, false
	}
	info, err := os.Stat(m.path)
	if err != nil {
		return videoopt.ReadyFile{}, false
	}
	return videoopt.ReadyFile{Path: m.path, CacheKey: key, Size: info.Size(), ModifiedAt: info.ModTime(), Release: func() { m.releases++ }}, true
}

type videoOptimizationLister struct {
	*stubLister
	manager VideoOptimization
	streams int
}

func (l *videoOptimizationLister) VideoOptimization() VideoOptimization { return l.manager }
func (l *videoOptimizationLister) BeginMediaStream() func() {
	l.streams++
	return func() { l.streams-- }
}

func TestVideoOptimizationRoutesStayUnregisteredForNilProvider(t *testing.T) {
	lister := &videoOptimizationLister{stubLister: &stubLister{}}
	handler := NewHandler(testLogger(), lister, nil)
	for _, path := range []string{
		"/api/video-optimization/video",
		"/api/video-optimization/media/video?v=key",
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("GET %s status=%d, want 404", path, recorder.Code)
		}
	}
}

func TestVideoOptimizationStatusPrepareCancelAndClearRoutes(t *testing.T) {
	item := library.Media{ID: "video id", Type: library.MediaTypeVideo, Name: "movie.mp4"}
	manager := &fakeVideoOptimization{status: videoopt.Status{State: "eligible", MediaID: item.ID, Eligible: true, CacheKind: videoopt.CacheKind}}
	lister := &videoOptimizationLister{stubLister: &stubLister{items: []library.Media{item}}, manager: manager}
	handler := NewHandler(testLogger(), lister, nil)

	for _, test := range []struct {
		method, path string
		want         int
	}{
		{http.MethodGet, "/api/video-optimization/video%20id", http.StatusOK},
		{http.MethodPut, "/api/video-optimization/video%20id", http.StatusAccepted},
		{http.MethodDelete, "/api/video-optimization/video%20id/build", http.StatusOK},
		{http.MethodDelete, "/api/video-optimization/video%20id/cache?v=key-a", http.StatusOK},
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(test.method, test.path, nil))
		if recorder.Code != test.want {
			t.Fatalf("%s %s status=%d body=%s", test.method, test.path, recorder.Code, recorder.Body.String())
		}
	}
	if manager.requested != item.ID || manager.cancelled != item.ID || manager.clearedID != item.ID || manager.clearedKey != "key-a" {
		t.Fatalf("manager calls=%#v", manager)
	}

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/video-optimization/video%20id", nil))
	var status videoopt.Status
	if err := json.NewDecoder(recorder.Body).Decode(&status); err != nil || status.MediaID != item.ID {
		t.Fatalf("status=%#v error=%v", status, err)
	}
}

func TestVideoOptimizationMediaSupportsImmutableRangesAndNoGzip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sidecar.mp4")
	if err := os.WriteFile(path, []byte("0123456789"), 0o600); err != nil {
		t.Fatal(err)
	}
	item := library.Media{ID: "video", Type: library.MediaTypeVideo, Name: "movie.mp4", ModifiedAt: time.Now()}
	manager := &fakeVideoOptimization{path: path, readyKey: "immutable-key"}
	lister := &videoOptimizationLister{stubLister: &stubLister{items: []library.Media{item}}, manager: manager}
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	handler := NewHandler(logger, lister, nil)
	request := httptest.NewRequest(http.MethodGet, "/api/video-optimization/media/video?v=immutable-key", nil)
	request.AddCookie(&http.Cookie{Name: "muzioDiagnosticTransportId", Value: "0123456789abcdef0123456789abcdef"})
	request.AddCookie(&http.Cookie{Name: "muzioDiagnosticSampleId", Value: "abcdef0123456789abcdef0123456789"})
	request.Header.Set("Range", "bytes=4-6")
	request.Header.Set("Accept-Encoding", "gzip")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusPartialContent || recorder.Body.String() != "456" {
		t.Fatalf("status=%d body=%q", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Content-Encoding") != "" || recorder.Header().Get("Content-Type") != "video/mp4" {
		t.Fatalf("headers=%v", recorder.Header())
	}
	if recorder.Header().Get("Cache-Control") != "private, max-age=31536000, immutable, no-transform" {
		t.Fatalf("Cache-Control=%q", recorder.Header().Get("Cache-Control"))
	}
	if manager.releases != 1 || lister.streams != 0 {
		t.Fatalf("release=%d streams=%d", manager.releases, lister.streams)
	}
	logText := logs.String()
	for _, want := range []string{
		`msg="media stream"`,
		`id=video`,
		`source_kind=faststart-sidecar`,
		`diagnostic_transport_id=0123456789abcdef0123456789abcdef`,
		`diagnostic_sample_id=abcdef0123456789abcdef0123456789`,
		`request_kind=partial_get`,
		`range="bytes=4-6"`,
		`status=206`,
		`bytes=3`,
	} {
		if !strings.Contains(logText, want) {
			t.Fatalf("sidecar diagnostic missing %q: %s", want, logText)
		}
	}
}

func TestVideoOptimizationMediaFirstMiddleEndHeadAndUnsatisfiedRanges(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sidecar.mp4")
	if err := os.WriteFile(path, []byte("0123456789"), 0o600); err != nil {
		t.Fatal(err)
	}
	item := library.Media{ID: "video", Type: library.MediaTypeVideo, Name: "movie.mp4"}
	manager := &fakeVideoOptimization{path: path, readyKey: "key"}
	lister := &videoOptimizationLister{stubLister: &stubLister{items: []library.Media{item}}, manager: manager}
	handler := NewHandler(testLogger(), lister, nil)
	tests := []struct {
		method, rangeValue string
		wantStatus         int
		wantBody           string
	}{
		{http.MethodGet, "bytes=0-1", http.StatusPartialContent, "01"},
		{http.MethodGet, "bytes=4-5", http.StatusPartialContent, "45"},
		{http.MethodGet, "bytes=8-9", http.StatusPartialContent, "89"},
		{http.MethodHead, "", http.StatusOK, ""},
		{http.MethodGet, "bytes=20-30", http.StatusRequestedRangeNotSatisfiable, "invalid range: failed to overlap\n"},
	}
	for _, test := range tests {
		request := httptest.NewRequest(test.method, "/api/video-optimization/media/video?v=key", nil)
		if test.rangeValue != "" {
			request.Header.Set("Range", test.rangeValue)
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != test.wantStatus || recorder.Body.String() != test.wantBody {
			t.Fatalf("%s %s status=%d body=%q", test.method, test.rangeValue, recorder.Code, recorder.Body.String())
		}
	}
}

func TestVideoOptimizationMediaRejectsStaleKeyAndExtraSegments(t *testing.T) {
	item := library.Media{ID: "video", Type: library.MediaTypeVideo, Name: "movie.mp4"}
	manager := &fakeVideoOptimization{readyKey: "current"}
	lister := &videoOptimizationLister{stubLister: &stubLister{items: []library.Media{item}}, manager: manager}
	handler := NewHandler(testLogger(), lister, nil)
	for _, path := range []string{
		"/api/video-optimization/media/video?v=stale",
		"/api/video-optimization/media/video",
		"/api/video-optimization/media/video/extra?v=current",
		"/api/video-optimization/video/cache/extra",
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s status=%d", path, recorder.Code)
		}
	}
}
