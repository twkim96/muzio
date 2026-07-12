package httpserver

import (
	"compress/gzip"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWebAppHandlerServesIndexAndAssets(t *testing.T) {
	webDir := t.TempDir()
	writeStaticFile(t, webDir, "index.html", `<html><body>app shell</body></html>`)
	writeStaticFile(t, filepath.Join(webDir, "assets"), "app.js", `console.log("ok")`)
	handler := NewHandlerWithWeb(testLogger(), &stubLister{}, nil, webDir)

	for _, tc := range []struct {
		path string
		want string
	}{
		{path: "/", want: "app shell"},
		{path: "/library/video", want: "app shell"},
		{path: "/assets/app.js", want: `console.log("ok")`},
	} {
		req := httptest.NewRequest(http.MethodGet, tc.path, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d, body %q", tc.path, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), tc.want) {
			t.Fatalf("%s body = %q, want %q", tc.path, rec.Body.String(), tc.want)
		}
	}
}

func TestWebAppHandlerCompressesAndLongCachesHashedAssets(t *testing.T) {
	webDir := t.TempDir()
	writeStaticFile(t, webDir, "index.html", `<html><body>app shell</body></html>`)
	writeStaticFile(t, filepath.Join(webDir, "assets"), "app-abcdef12.js", strings.Repeat("console.log('ok');\n", 200))
	handler := NewHandlerWithWeb(testLogger(), &stubLister{}, nil, webDir)

	req := httptest.NewRequest(http.MethodGet, "/assets/app-abcdef12.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("Cache-Control = %q", got)
	}
	reader, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("open gzip response: %v", err)
	}
	body, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read gzip response: %v", err)
	}
	if err := reader.Close(); err != nil {
		t.Fatalf("close gzip response: %v", err)
	}
	if !strings.Contains(string(body), "console.log('ok')") {
		t.Fatalf("body = %q", body)
	}
}

func TestWebAppHandlerDoesNotLongCacheUnhashedAssets(t *testing.T) {
	webDir := t.TempDir()
	writeStaticFile(t, webDir, "index.html", `<html><body>app shell</body></html>`)
	writeStaticFile(t, filepath.Join(webDir, "assets"), "app.js", `console.log("ok")`)
	handler := NewHandlerWithWeb(testLogger(), &stubLister{}, nil, webDir)

	req := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Cache-Control"); got != "" {
		t.Fatalf("Cache-Control = %q, want unset", got)
	}
}

func TestWebAppHandlerDoesNotFallbackMissingAssetsToTheAppShell(t *testing.T) {
	webDir := t.TempDir()
	writeStaticFile(t, webDir, "index.html", `<html><body>app shell</body></html>`)
	handler := NewHandlerWithWeb(testLogger(), &stubLister{}, nil, webDir)

	req := httptest.NewRequest(http.MethodGet, "/assets/missing-abcdef12.js", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "" {
		t.Fatalf("Cache-Control = %q, want unset", got)
	}
	if strings.Contains(rec.Body.String(), "app shell") {
		t.Fatalf("missing asset served app shell: %q", rec.Body.String())
	}
}

func TestWebAppHandlerLongCachesViteURLSafeHashAssets(t *testing.T) {
	webDir := t.TempDir()
	writeStaticFile(t, webDir, "index.html", `<html><body>app shell</body></html>`)
	writeStaticFile(t, filepath.Join(webDir, "assets"), "PersistentVidstackPlayer-BKnPS_sC.js", `console.log("ok")`)
	writeStaticFile(t, filepath.Join(webDir, "assets"), "vidstack-CHcsWfRV-omUDu-Vk.js", `console.log("ok")`)
	handler := NewHandlerWithWeb(testLogger(), &stubLister{}, nil, webDir)

	for _, asset := range []string{
		"PersistentVidstackPlayer-BKnPS_sC.js",
		"vidstack-CHcsWfRV-omUDu-Vk.js",
	} {
		req := httptest.NewRequest(http.MethodGet, "/assets/"+asset, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
			t.Fatalf("%s Cache-Control = %q", asset, got)
		}
		if got := rec.Header().Get("Vary"); got != "Accept-Encoding" {
			t.Fatalf("%s Vary = %q", asset, got)
		}
	}
}

func TestWebAppHandlerPreservesAPIRoutes(t *testing.T) {
	webDir := t.TempDir()
	writeStaticFile(t, webDir, "index.html", `<html><body>app shell</body></html>`)
	handler := NewHandlerWithWeb(testLogger(), &stubLister{}, nil, webDir)

	req := httptest.NewRequest(http.MethodGet, "/api/library", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "app shell") {
		t.Fatalf("api route served web shell: %q", rec.Body.String())
	}
}

func TestWebAppHandlerRejectsNonReadMethod(t *testing.T) {
	webDir := t.TempDir()
	writeStaticFile(t, webDir, "index.html", `<html><body>app shell</body></html>`)
	handler := NewHandlerWithWeb(slog.Default(), &stubLister{}, nil, webDir)

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}

func TestWebAppHandlerServesManifestContentType(t *testing.T) {
	webDir := t.TempDir()
	writeStaticFile(t, webDir, "index.html", `<html><body>app shell</body></html>`)
	writeStaticFile(t, webDir, "manifest.webmanifest", `{"name":"Muzio"}`)
	handler := NewHandlerWithWeb(slog.Default(), &stubLister{}, nil, webDir)

	req := httptest.NewRequest(http.MethodGet, "/manifest.webmanifest", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/manifest+json; charset=utf-8" {
		t.Fatalf("Content-Type = %q, want manifest JSON", got)
	}
}

func writeStaticFile(t *testing.T, dir string, name string, content string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}
