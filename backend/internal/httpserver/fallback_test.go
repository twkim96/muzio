package httpserver

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"muzio/backend/internal/fallback"
	"muzio/backend/internal/library"
)

func TestFallbackEndpointReturnsPlan(t *testing.T) {
	item := library.Media{
		ID:       "m1",
		Type:     library.MediaTypeVideo,
		Name:     "movie.mkv",
		MIMEType: "video/x-matroska",
	}
	handler := NewHandler(testLogger(), &stubLister{items: []library.Media{item}}, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/fallback/m1?browserSupport=no", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", rec.Code, rec.Body.String())
	}
	var plan fallback.Plan
	if err := json.NewDecoder(rec.Body).Decode(&plan); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if plan.MediaID != "m1" || plan.BrowserSupport != fallback.BrowserSupportNo {
		t.Fatalf("plan = %#v", plan)
	}
	if plan.Policy.Limits.MaxConcurrentJobs <= 0 {
		t.Fatalf("limits missing: %#v", plan.Policy.Limits)
	}
}

func TestFallbackEndpointRejectsUnsupportedMethod(t *testing.T) {
	handler := NewHandler(testLogger(), &stubLister{}, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/fallback/m1", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
