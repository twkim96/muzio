package httpserver

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"muzio/backend/internal/fallback"
	"muzio/backend/internal/library"
)

func fallbackHandler(getter LibraryGetter, planner fallback.Planner) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if getter == nil {
			http.NotFound(w, r)
			return
		}
		mediaID, ok := fallbackIDFromPath(r.URL.Path)
		if !ok {
			http.NotFound(w, r)
			return
		}
		item, err := getter.Get(mediaID)
		if err != nil {
			if errors.Is(err, library.ErrNotFound) {
				http.NotFound(w, r)
				return
			}
			http.Error(w, "fallback unavailable", http.StatusInternalServerError)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		support := fallback.NormalizeBrowserSupport(r.URL.Query().Get("browserSupport"))
		writeJSON(w, http.StatusOK, planner.Plan(ctx, item, support))
	}
}

func fallbackIDFromPath(path string) (string, bool) {
	rawID := strings.TrimPrefix(path, "/api/fallback/")
	id, err := url.PathUnescape(rawID)
	if rawID == "" || err != nil || strings.Contains(id, "/") {
		return "", false
	}
	return id, true
}
