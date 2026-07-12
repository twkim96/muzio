package httpserver

import (
	"encoding/json"
	"net/http"

	"muzio/backend/internal/library"
)

type MediaRootsManager interface {
	MediaRootSettings() library.MediaRootSettings
	RescanMediaRoots() (library.MediaRootUpdateResult, error)
	UpdateMediaRoots(library.MediaRootSettings) (library.MediaRootUpdateResult, error)
}

type MediaRootsPersistenceReporter interface {
	MediaRootsPersistent() bool
}

type MediaRootsHealthReporter interface {
	DegradedRoots() []library.DegradedRoot
}

type MediaRootsIndexReporter interface {
	IndexStatus() library.IndexStatus
}

type MediaRootsWatcherReporter interface {
	WatcherStatus() library.WatcherStatus
}

type mediaRootsResponse struct {
	AudioRoots []string               `json:"audioRoots"`
	VideoRoots []string               `json:"videoRoots"`
	ImageRoots []string               `json:"imageRoots"`
	ItemCount  int                    `json:"itemCount,omitempty"`
	Persistent bool                   `json:"persistent"`
	Degraded   []library.DegradedRoot `json:"degradedRoots,omitempty"`
	Index      library.IndexStatus    `json:"index"`
	Watcher    library.WatcherStatus  `json:"watcher"`
}

type mediaRootsRequest struct {
	AudioRoots []string `json:"audioRoots"`
	VideoRoots []string `json:"videoRoots"`
	ImageRoots []string `json:"imageRoots"`
}

func mediaRootsHandler(manager MediaRootsManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			settings := manager.MediaRootSettings()
			persistent := false
			if reporter, ok := manager.(MediaRootsPersistenceReporter); ok {
				persistent = reporter.MediaRootsPersistent()
			}
			var degraded []library.DegradedRoot
			if reporter, ok := manager.(MediaRootsHealthReporter); ok {
				degraded = reporter.DegradedRoots()
			}
			index := library.IndexStatus{}
			if reporter, ok := manager.(MediaRootsIndexReporter); ok {
				index = reporter.IndexStatus()
			}
			writeMediaRootsResponse(w, mediaRootsResponse{
				AudioRoots: settings.AudioRoots,
				VideoRoots: settings.VideoRoots,
				ImageRoots: settings.ImageRoots,
				Persistent: persistent,
				Degraded:   degraded,
				Index:      index,
				Watcher:    mediaRootsWatcherStatus(manager),
			})
		case http.MethodPut:
			var body mediaRootsRequest
			if !decodeJSONBody(w, r, &body) {
				return
			}
			result, err := manager.UpdateMediaRoots(library.MediaRootSettings{
				AudioRoots: body.AudioRoots,
				VideoRoots: body.VideoRoots,
				ImageRoots: body.ImageRoots,
			})
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			writeMediaRootsResponse(w, mediaRootsResponse{
				AudioRoots: result.Settings.AudioRoots,
				VideoRoots: result.Settings.VideoRoots,
				ImageRoots: result.Settings.ImageRoots,
				ItemCount:  result.ItemCount,
				Persistent: result.Persistent,
				Degraded:   result.DegradedRoots,
				Index:      mediaRootsIndexStatus(manager),
				Watcher:    mediaRootsWatcherStatus(manager),
			})
		case http.MethodPost:
			result, err := manager.RescanMediaRoots()
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			writeMediaRootsResponse(w, mediaRootsResponse{
				AudioRoots: result.Settings.AudioRoots,
				VideoRoots: result.Settings.VideoRoots,
				ImageRoots: result.Settings.ImageRoots,
				ItemCount:  result.ItemCount,
				Persistent: result.Persistent,
				Degraded:   result.DegradedRoots,
				Index:      mediaRootsIndexStatus(manager),
				Watcher:    mediaRootsWatcherStatus(manager),
			})
		default:
			w.Header().Set("Allow", "GET, PUT, POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

func mediaRootsWatcherStatus(manager MediaRootsManager) library.WatcherStatus {
	if reporter, ok := manager.(MediaRootsWatcherReporter); ok {
		return reporter.WatcherStatus()
	}
	return library.WatcherStatus{}
}

func mediaRootsIndexStatus(manager MediaRootsManager) library.IndexStatus {
	if reporter, ok := manager.(MediaRootsIndexReporter); ok {
		return reporter.IndexStatus()
	}
	return library.IndexStatus{}
}

func writeMediaRootsResponse(w http.ResponseWriter, body mediaRootsResponse) {
	if body.AudioRoots == nil {
		body.AudioRoots = []string{}
	}
	if body.VideoRoots == nil {
		body.VideoRoots = []string{}
	}
	if body.ImageRoots == nil {
		body.ImageRoots = []string{}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(body)
}
