package httpserver

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"muzio/backend/internal/progress"
)

func newTestHandlerWithProgress(store ProgressStore) http.Handler {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewHandler(logger, &stubLister{}, nil, store)
}

func TestProgressPutGetListAndDelete(t *testing.T) {
	store := progress.NewStoreWithClock(func() time.Time {
		return time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	})
	handler := newTestHandlerWithProgress(store)

	body := `{
		"positionSec": 45,
		"durationSec": 600,
		"lastPlayedAt": "2026-06-01T09:30:00Z",
		"completed": false,
		"source": {
			"mediaType": "video",
			"name": "clip.mp4",
			"rootName": "video",
			"relativePath": "clip.mp4"
		}
	}`
	put := httptest.NewRequest(http.MethodPut, "/api/progress/m1", strings.NewReader(body))
	putRec := httptest.NewRecorder()
	handler.ServeHTTP(putRec, put)
	if putRec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body %q", putRec.Code, putRec.Body.String())
	}

	get := httptest.NewRequest(http.MethodGet, "/api/progress/m1", nil)
	getRec := httptest.NewRecorder()
	handler.ServeHTTP(getRec, get)
	if getRec.Code != http.StatusOK {
		t.Fatalf("GET status = %d", getRec.Code)
	}
	var got progress.Record
	if err := json.NewDecoder(getRec.Body).Decode(&got); err != nil {
		t.Fatalf("decode GET: %v", err)
	}
	if got.PositionSec != 45 || got.Source == nil || got.Source.Name != "clip.mp4" {
		t.Fatalf("record = %#v", got)
	}

	list := httptest.NewRequest(http.MethodGet, "/api/progress", nil)
	listRec := httptest.NewRecorder()
	handler.ServeHTTP(listRec, list)
	if listRec.Code != http.StatusOK {
		t.Fatalf("list status = %d", listRec.Code)
	}
	var listBody progressListResponse
	if err := json.NewDecoder(listRec.Body).Decode(&listBody); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(listBody.Records) != 1 || listBody.Records[0].MediaID != "m1" {
		t.Fatalf("records = %#v", listBody.Records)
	}

	del := httptest.NewRequest(http.MethodDelete, "/api/progress/m1", nil)
	delRec := httptest.NewRecorder()
	handler.ServeHTTP(delRec, del)
	if delRec.Code != http.StatusNoContent {
		t.Fatalf("DELETE status = %d", delRec.Code)
	}
	missingRec := httptest.NewRecorder()
	handler.ServeHTTP(missingRec, get)
	if missingRec.Code != http.StatusNotFound {
		t.Fatalf("missing status = %d", missingRec.Code)
	}
}

func TestProgressRejectsBadPayloads(t *testing.T) {
	handler := newTestHandlerWithProgress(progress.NewStore())

	tests := []struct {
		name string
		path string
		body string
	}{
		{
			name: "invalid json",
			path: "/api/progress/m1",
			body: "{",
		},
		{
			name: "mismatched id",
			path: "/api/progress/m1",
			body: `{"mediaId":"m2","positionSec":1,"durationSec":2}`,
		},
		{
			name: "negative position",
			path: "/api/progress/m1",
			body: `{"positionSec":-1,"durationSec":2}`,
		},
		{
			name: "unknown field",
			path: "/api/progress/m1",
			body: `{"positionSec":1,"durationSec":2,"unexpected":true}`,
		},
		{
			name: "trailing json",
			path: "/api/progress/m1",
			body: `{"positionSec":1,"durationSec":2} {}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPut, tt.path, strings.NewReader(tt.body))
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", rec.Code)
			}
		})
	}
}

func TestProgressRejectsOversizedJSONBody(t *testing.T) {
	handler := newTestHandlerWithProgress(progress.NewStore())
	body := `{"positionSec":1,"durationSec":2,"padding":"` +
		strings.Repeat("x", int(maxJSONBodyBytes)) + `"}`
	req := httptest.NewRequest(http.MethodPut, "/api/progress/m1", strings.NewReader(body))
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body = %q", rec.Code, rec.Body.String())
	}
}

func TestProgressRejectsUnsupportedMethods(t *testing.T) {
	handler := newTestHandlerWithProgress(progress.NewStore())
	req := httptest.NewRequest(http.MethodPost, "/api/progress/m1", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
	if got := rec.Header().Get("Allow"); got != "GET, PUT, DELETE" {
		t.Fatalf("Allow = %q", got)
	}
}
