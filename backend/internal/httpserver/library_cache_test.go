package httpserver

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"muzio/backend/internal/library"
	"muzio/backend/internal/mediapath"
)

func TestLibraryAPIUsesPersistentCacheBeforeReconciliation(t *testing.T) {
	rootPath := t.TempDir()
	settings := library.MediaRootSettings{AudioRoots: []string{rootPath}}
	roots, err := mediapath.NewRoots([]string{rootPath})
	if err != nil {
		t.Fatal(err)
	}
	root := roots.All()[0]
	indexPath := filepath.Join(t.TempDir(), "library-index.v1.log")
	index, _, _ := library.OpenPersistentIndex(indexPath, settings)
	if err := index.Reset(settings, []library.Media{{
		ID:           "cached",
		Type:         library.MediaTypeAudio,
		RootName:     root.Name,
		RelativePath: "cached.mp3",
		Name:         "cached.mp3",
	}}, 12, time.Time{}); err != nil {
		t.Fatal(err)
	}
	service, err := library.NewPersistentService(
		settings,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
		indexPath,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()

	handler := NewHandler(slog.New(slog.NewTextHandler(io.Discard, nil)), service, nil)
	request := httptest.NewRequest(http.MethodGet, "/api/library?type=audio", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body libraryListResponse
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Items) != 1 || body.Items[0].ID != "cached" {
		t.Fatalf("items = %#v", body.Items)
	}
}
