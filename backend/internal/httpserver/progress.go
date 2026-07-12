package httpserver

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"muzio/backend/internal/progress"
)

type ProgressStore interface {
	List() []progress.Record
	Get(mediaID string) (progress.Record, error)
	Put(record progress.Record) (progress.Record, error)
	Delete(mediaID string)
}

type progressListResponse struct {
	Records []progress.Record `json:"records"`
}

func progressCollectionHandler(store ProgressStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if store == nil {
			http.NotFound(w, r)
			return
		}
		records := store.List()
		if records == nil {
			records = []progress.Record{}
		}
		writeJSON(w, http.StatusOK, progressListResponse{Records: records})
	}
}

func progressItemHandler(store ProgressStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if store == nil {
			http.NotFound(w, r)
			return
		}
		mediaID, ok := progressIDFromPath(r.URL.Path)
		if !ok {
			http.NotFound(w, r)
			return
		}

		switch r.Method {
		case http.MethodGet:
			record, err := store.Get(mediaID)
			if err != nil {
				if errors.Is(err, progress.ErrNotFound) {
					http.NotFound(w, r)
					return
				}
				http.Error(w, "progress unavailable", http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, record)
		case http.MethodPut:
			var record progress.Record
			if !decodeJSONBody(w, r, &record) {
				return
			}
			if record.MediaID != "" && record.MediaID != mediaID {
				http.Error(w, "mediaId must match request path", http.StatusBadRequest)
				return
			}
			record.MediaID = mediaID
			saved, err := store.Put(record)
			if err != nil {
				if errors.Is(err, progress.ErrInvalid) {
					http.Error(w, "invalid progress payload", http.StatusBadRequest)
					return
				}
				http.Error(w, "progress unavailable", http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, saved)
		case http.MethodDelete:
			store.Delete(mediaID)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.Header().Set("Allow", "GET, PUT, DELETE")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

func progressIDFromPath(path string) (string, bool) {
	rawID := strings.TrimPrefix(path, "/api/progress/")
	id, err := url.PathUnescape(rawID)
	if rawID == "" || err != nil || strings.Contains(id, "/") {
		return "", false
	}
	return id, true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
