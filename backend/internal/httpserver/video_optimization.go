package httpserver

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"muzio/backend/internal/library"
	"muzio/backend/internal/streaming"
	"muzio/backend/internal/videoopt"
)

type VideoOptimization interface {
	Status(library.Media) videoopt.Status
	StatusKind(library.Media, string) videoopt.Status
	Request(library.Media) (videoopt.Status, error)
	RequestKind(library.Media, string) (videoopt.Status, error)
	Cancel(string) bool
	Clear(string, string) bool
	Acquire(library.Media, string) (videoopt.ReadyFile, bool)
	AcquireHLSAsset(library.Media, string, string) (videoopt.ReadyAsset, bool)
}

type VideoOptimizationProvider interface {
	VideoOptimization() VideoOptimization
}

type mediaStreamActivity interface{ BeginMediaStream() func() }

func rejectHLSPathTraversal(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/video-optimization/hls/") {
			for _, part := range strings.Split(r.URL.Path, "/") {
				if part == "." || part == ".." {
					http.NotFound(w, r)
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

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
		kind, validKind := requestedVideoOptimizationKind(r)
		if !validKind {
			http.Error(w, "unsupported optimization kind", http.StatusBadRequest)
			return
		}
		switch {
		case action == "" && r.Method == http.MethodGet:
			writeJSON(w, http.StatusOK, manager.StatusKind(item, kind))
		case action == "" && r.Method == http.MethodPut:
			status, err := manager.RequestKind(item, kind)
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
			writeJSON(w, http.StatusOK, manager.StatusKind(item, kind))
		case action == "cache" && r.Method == http.MethodDelete:
			key := r.URL.Query().Get("v")
			if key == "" {
				http.Error(w, "cache key is required", http.StatusBadRequest)
				return
			}
			manager.Clear(id, key)
			writeJSON(w, http.StatusOK, manager.StatusKind(item, kind))
		default:
			w.Header().Set("Allow", allowedVideoOptimizationMethods(action))
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

func videoOptimizationHLSHandler(getter LibraryGetter, manager VideoOptimization, logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		id, cacheKey, assetName, ok := hlsAssetTarget(r.URL.Path)
		if !ok {
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
		ready, ok := manager.AcquireHLSAsset(item, cacheKey, assetName)
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
		w.Header().Set("Content-Type", hlsAssetContentType(ready.Asset.Kind))
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable, no-transform")
		w.Header().Set("ETag", fmt.Sprintf(`"videoopt-hls-%s-%s"`, ready.CacheKey, ready.Asset.Name))
		streaming.ServeContentWithDiagnostics(
			w, r, ready.Asset.Name, ready.ModifiedAt, file,
			logger, item.ID, string(item.Type), "hls-"+ready.Asset.Kind,
			hlsContentDiagnosticFields(ready.Asset),
		)
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

func requestedVideoOptimizationKind(r *http.Request) (string, bool) {
	kind := strings.TrimSpace(r.URL.Query().Get("kind"))
	if kind == "" || kind == videoopt.CacheKind {
		return videoopt.CacheKind, true
	}
	if kind == videoopt.HLSCacheKind {
		return videoopt.HLSCacheKind, true
	}
	return kind, false
}

func hlsAssetTarget(path string) (string, string, string, bool) {
	const prefix = "/api/video-optimization/hls/"
	raw := strings.TrimPrefix(path, prefix)
	if raw == path {
		return "", "", "", false
	}
	parts := strings.Split(raw, "/")
	if len(parts) != 3 || !isHexCacheKey(parts[1]) || filepath.Base(parts[2]) != parts[2] {
		return "", "", "", false
	}
	id, err := url.PathUnescape(parts[0])
	if err != nil || id == "" || strings.Contains(id, "/") {
		return "", "", "", false
	}
	asset, err := url.PathUnescape(parts[2])
	if err != nil || asset == "" || filepath.Base(asset) != asset {
		return "", "", "", false
	}
	return id, parts[1], asset, true
}

func isHexCacheKey(value string) bool {
	if len(value) != 24 {
		return false
	}
	for _, char := range value {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f')) {
			return false
		}
	}
	return true
}

func hlsAssetContentType(kind string) string {
	switch kind {
	case "manifest":
		return "application/vnd.apple.mpegurl"
	case "segment":
		return "video/iso.segment"
	default:
		return "video/mp4"
	}
}

func hlsContentDiagnosticFields(asset videoopt.HLSAsset) streaming.ContentDiagnosticFields {
	switch asset.Kind {
	case "manifest":
		return streaming.ContentDiagnosticFields{HLSAsset: hlsManifestDiagnosticName}
	case "init":
		return streaming.ContentDiagnosticFields{HLSAsset: "init.mp4"}
	case "segment":
		value := strings.TrimSuffix(strings.TrimPrefix(asset.Name, "seg-"), ".m4s")
		index, err := strconv.Atoi(value)
		if err == nil && index >= 0 && len(value) == 6 {
			return streaming.ContentDiagnosticFields{HLSSegmentIndex: &index}
		}
	}
	return streaming.ContentDiagnosticFields{}
}

const hlsManifestDiagnosticName = "index.m3u8"
