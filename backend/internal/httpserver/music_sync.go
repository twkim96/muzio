package httpserver

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"muzio/backend/internal/musicsync"
)

// NewMusicSyncHandler adds the durable metadata API without changing existing routes.
func NewMusicSyncHandler(store *musicsync.Store, fallback http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/music-sync" {
			fallback.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		switch r.Method {
		case http.MethodGet:
			etag := `"music-sync-` + strconv.FormatInt(store.Revision(), 10) + `"`
			w.Header().Set("ETag", etag)
			for _, candidate := range strings.Split(r.Header.Get("If-None-Match"), ",") {
				if candidate = strings.TrimSpace(candidate); candidate == "*" || strings.TrimPrefix(candidate, "W/") == etag {
					w.WriteHeader(http.StatusNotModified)
					return
				}
			}
			snapshot := store.Snapshot()
			w.Header().Set("ETag", `"music-sync-`+strconv.FormatInt(snapshot.Revision, 10)+`"`)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(snapshot)
		case http.MethodPost:
			if !musicSyncSameOrigin(r) {
				http.Error(w, "cross-origin music sync mutation is not allowed", http.StatusForbidden)
				return
			}
			var body struct {
				Operations []musicsync.Operation `json:"operations"`
			}
			d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
			d.DisallowUnknownFields()
			if err := d.Decode(&body); err != nil {
				writeJSONDecodeError(w, err)
				return
			}
			if err := d.Decode(new(any)); err != io.EOF {
				writeJSONDecodeError(w, err)
				return
			}
			response, err := store.Apply(body.Operations)
			if err != nil {
				switch {
				case errors.Is(err, musicsync.ErrInvalid):
					http.Error(w, err.Error(), http.StatusBadRequest)
				case errors.Is(err, musicsync.ErrLimit):
					http.Error(w, err.Error(), http.StatusConflict)
				default:
					http.Error(w, "failed to persist music sync metadata", http.StatusInternalServerError)
				}
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(response)
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}
func musicSyncSameOrigin(r *http.Request) bool {
	if strings.EqualFold(r.Header.Get("Sec-Fetch-Site"), "cross-site") {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	// The app also runs behind a local TLS reverse proxy.
	if forwarded := r.Header.Get("X-Forwarded-Proto"); forwarded == "http" || forwarded == "https" {
		scheme = forwarded
	}
	return u.Scheme == scheme && strings.EqualFold(u.Host, r.Host)
}
