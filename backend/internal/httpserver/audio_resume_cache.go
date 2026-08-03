package httpserver

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"muzio/backend/internal/audioresume"
	"muzio/backend/internal/library"
)

type AudioResumeCache interface {
	Request(library.Media) (audioresume.Status, error)
	Ready(library.Media) (string, bool)
	Status() audioresume.Status
}

type AudioResumeCacheProvider interface {
	AudioResumeCache() AudioResumeCache
}

func audioResumeCacheStatusHandler(cache AudioResumeCache) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		status := cache.Status()
		status.URL = audioResumeCacheURL(status.MediaID)
		writeJSON(w, http.StatusOK, status)
	}
}

func audioResumeCacheRequestHandler(getter LibraryGetter, cache AudioResumeCache) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			w.Header().Set("Allow", http.MethodPut)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		id, ok := audioResumeCacheID(r.URL.Path, "/api/audio-resume-cache/")
		if !ok {
			http.NotFound(w, r)
			return
		}
		item, err := getter.Get(id)
		if err != nil {
			if errors.Is(err, library.ErrNotFound) {
				http.NotFound(w, r)
				return
			}
			http.Error(w, "audio resume cache unavailable", http.StatusInternalServerError)
			return
		}
		status, err := cache.Request(item)
		if errors.Is(err, audioresume.ErrUnsupported) {
			http.Error(w, "audio resume cache only supports AAC audio", http.StatusUnprocessableEntity)
			return
		}
		if err != nil {
			http.Error(w, "audio resume cache unavailable", http.StatusInternalServerError)
			return
		}
		status.URL = audioResumeCacheURL(status.MediaID)
		writeJSON(w, http.StatusAccepted, status)
	}
}

func audioResumeCacheMediaHandler(
	getter LibraryGetter,
	cache AudioResumeCache,
	fallback http.Handler,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		id, ok := audioResumeCacheID(r.URL.Path, "/api/audio-resume-cache/media/")
		if !ok {
			http.NotFound(w, r)
			return
		}
		item, err := getter.Get(id)
		if err != nil {
			if errors.Is(err, library.ErrNotFound) {
				http.NotFound(w, r)
				return
			}
			http.Error(w, "audio resume cache unavailable", http.StatusInternalServerError)
			return
		}
		path, ready := cache.Ready(item)
		if !ready {
			if fallback == nil {
				http.NotFound(w, r)
				return
			}
			clone := r.Clone(r.Context())
			clone.URL.Path = "/api/media/" + url.PathEscape(id)
			fallback.ServeHTTP(w, clone)
			return
		}
		file, err := os.Open(path)
		if err != nil {
			http.Error(w, "audio resume cache unavailable", http.StatusInternalServerError)
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			http.Error(w, "audio resume cache unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "audio/mp4")
		w.Header().Set("Cache-Control", "private, no-transform")
		w.Header().Set("ETag", fmt.Sprintf(`W/"resume-%s-%x-%x"`, item.ID, info.Size(), info.ModTime().UnixNano()))
		http.ServeContent(w, r, item.Name+".m4a", info.ModTime(), file)
	}
}

func audioResumeCacheID(path, prefix string) (string, bool) {
	raw := strings.TrimPrefix(path, prefix)
	if raw == "" || strings.Contains(raw, "/") {
		return "", false
	}
	id, err := url.PathUnescape(raw)
	return id, err == nil && id != "" && !strings.Contains(id, "/")
}

func audioResumeCacheURL(mediaID string) string {
	if mediaID == "" {
		return ""
	}
	return "/api/audio-resume-cache/media/" + url.PathEscape(mediaID)
}
