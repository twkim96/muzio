package httpserver

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"

	"muzio/backend/internal/library"
	"muzio/backend/internal/streaming"
	"muzio/backend/internal/videoopt"
)

type VideoOptimization interface {
	Status(library.Media) videoopt.Status
	Request(library.Media) (videoopt.Status, error)
	Cancel(string) bool
	Clear(string, string) bool
	Acquire(library.Media, string) (videoopt.ReadyFile, bool)
}

type VideoOptimizationProvider interface {
	VideoOptimization() VideoOptimization
}

type mediaStreamActivity interface{ BeginMediaStream() func() }

func videoOptimizationHandler(getter LibraryGetter, manager VideoOptimization) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, action, ok := videoOptimizationTarget(r.URL.Path)
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
			http.Error(w, "video optimization unavailable", http.StatusInternalServerError)
			return
		}
		switch {
		case action == "" && r.Method == http.MethodGet:
			writeJSON(w, http.StatusOK, manager.Status(item))
		case action == "" && r.Method == http.MethodPut:
			status, err := manager.Request(item)
			switch {
			case errors.Is(err, videoopt.ErrUnsupported), errors.Is(err, videoopt.ErrNotEligible):
				writeJSON(w, http.StatusUnprocessableEntity, status)
			case errors.Is(err, videoopt.ErrInsufficientSpace):
				writeJSON(w, http.StatusInsufficientStorage, status)
			case err != nil:
				http.Error(w, "video optimization unavailable", http.StatusInternalServerError)
			default:
				writeJSON(w, http.StatusAccepted, status)
			}
		case action == "build" && r.Method == http.MethodDelete:
			manager.Cancel(id)
			writeJSON(w, http.StatusOK, manager.Status(item))
		case action == "cache" && r.Method == http.MethodDelete:
			key := r.URL.Query().Get("v")
			if key == "" {
				http.Error(w, "cache key is required", http.StatusBadRequest)
				return
			}
			manager.Clear(id, key)
			writeJSON(w, http.StatusOK, manager.Status(item))
		default:
			w.Header().Set("Allow", allowedVideoOptimizationMethods(action))
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

func videoOptimizationMediaHandler(getter LibraryGetter, manager VideoOptimization, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		id, ok := strictPathID(r.URL.Path, "/api/video-optimization/media/")
		if !ok {
			http.NotFound(w, r)
			return
		}
		key := r.URL.Query().Get("v")
		if key == "" {
			http.NotFound(w, r)
			return
		}
		item, err := getter.Get(id)
		if err != nil {
			if errors.Is(err, library.ErrNotFound) {
				http.NotFound(w, r)
			} else {
				http.Error(w, "video optimization unavailable", http.StatusInternalServerError)
			}
			return
		}
		if activity, ok := getter.(mediaStreamActivity); ok {
			end := activity.BeginMediaStream()
			defer end()
		}
		ready, ok := manager.Acquire(item, key)
		if !ok {
			http.NotFound(w, r)
			return
		}
		defer ready.Release()
		file, err := os.Open(ready.Path)
		if err != nil {
			http.Error(w, "video optimization unavailable", http.StatusInternalServerError)
			return
		}
		defer file.Close()
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable, no-transform")
		w.Header().Set("ETag", fmt.Sprintf(`"videoopt-%s"`, ready.CacheKey))
		streaming.ServeContentWithDiagnostics(
			w, r, item.Name+".faststart.mp4", ready.ModifiedAt, file,
			logger, item.ID, string(item.Type), "faststart-sidecar",
		)
	}
}

func videoOptimizationTarget(path string) (string, string, bool) {
	const prefix = "/api/video-optimization/"
	raw := strings.TrimPrefix(path, prefix)
	if raw == path || raw == "" || strings.HasPrefix(raw, "media/") {
		return "", "", false
	}
	parts := strings.Split(raw, "/")
	if len(parts) < 1 || len(parts) > 2 {
		return "", "", false
	}
	id, err := url.PathUnescape(parts[0])
	if err != nil || id == "" || strings.Contains(id, "/") {
		return "", "", false
	}
	action := ""
	if len(parts) == 2 {
		action = parts[1]
		if action != "build" && action != "cache" {
			return "", "", false
		}
	}
	return id, action, true
}

func strictPathID(path, prefix string) (string, bool) {
	raw := strings.TrimPrefix(path, prefix)
	if raw == path || raw == "" || strings.Contains(raw, "/") {
		return "", false
	}
	id, err := url.PathUnescape(raw)
	return id, err == nil && id != "" && !strings.Contains(id, "/")
}

func allowedVideoOptimizationMethods(action string) string {
	if action == "build" || action == "cache" {
		return http.MethodDelete
	}
	return "GET, PUT"
}
