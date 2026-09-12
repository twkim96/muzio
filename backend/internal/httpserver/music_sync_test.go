package httpserver

import (
	"muzio/backend/internal/musicsync"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestMusicSyncHTTP(t *testing.T) {
	store, e := musicsync.Open(filepath.Join(t.TempDir(), "music.json"))
	if e != nil {
		t.Fatal(e)
	}
	handler := NewMusicSyncHandler(store, http.NotFoundHandler())
	call := func(method, body, etag, origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://muzio.test/api/music-sync", strings.NewReader(body))
		r.Header.Set("If-None-Match", etag)
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	first := call("GET", "", "", "")
	if first.Code != 200 {
		t.Fatal(first.Code)
	}
	unchanged := call("GET", "", first.Header().Get("ETag"), "")
	if unchanged.Code != 304 || unchanged.Body.Len() != 0 {
		t.Fatal("unchanged payload")
	}
	body := `{"operations":[{"id":"a","kind":"like","key":"song","value":true,"baseRevision":0}]}`
	if w := call("POST", body, "", "http://other.test"); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := call("POST", body, "", "http://muzio.test"); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := call("GET", "", first.Header().Get("ETag"), ""); w.Code != 200 {
		t.Fatal(w.Code)
	}
	for _, body := range []string{`{"operations":[{"id":"a","kind":"like","key":"song","value":true}]}`, `{"operations":[{"id":"a","kind":"like","key":"song","value":null,"baseRevision":0}]}`, `{"operations":[]} {}`} {
		if w := call("POST", body, "", ""); w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}
