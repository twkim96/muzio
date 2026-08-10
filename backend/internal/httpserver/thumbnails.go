package httpserver

import (
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"muzio/backend/internal/library"
)

type LibraryGetter interface {
	Get(id string) (library.Media, error)
}

type ThumbnailCache interface {
	ThumbnailPath(library.Media) (string, bool)
}

type ThumbnailPreparer interface {
	PrepareThumbnail(library.Media)
}

func thumbnailHandler(getter LibraryGetter) http.HandlerFunc {
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
		rawID := strings.TrimPrefix(r.URL.Path, "/api/thumbnails/")
		id, err := url.PathUnescape(rawID)
		if rawID == "" || err != nil {
			http.NotFound(w, r)
			return
		}
		item, err := getter.Get(id)
		if err != nil {
			if errors.Is(err, library.ErrNotFound) {
				http.NotFound(w, r)
				return
			}
			http.Error(w, "thumbnail unavailable", http.StatusInternalServerError)
			return
		}
		if cache, ok := getter.(ThumbnailCache); ok {
			if path, ready := cache.ThumbnailPath(item); ready &&
				serveThumbnailFile(w, r, item, path) {
				return
			}
		}
		if preparer, ok := getter.(ThumbnailPreparer); ok {
			preparer.PrepareThumbnail(item)
		}
		etag := fmt.Sprintf("%q", item.Thumbnail.CacheKey)
		w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
		if item.Thumbnail.Status == library.ThumbnailStatusPending {
			w.Header().Set("Cache-Control", "no-cache")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=86400")
		}
		if item.Thumbnail.CacheKey != "" {
			w.Header().Set("ETag", etag)
		}
		if item.Thumbnail.CacheKey != "" && r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		_, _ = w.Write([]byte(renderThumbnailSVG(item)))
	}
}

func serveThumbnailFile(
	w http.ResponseWriter,
	r *http.Request,
	item library.Media,
	path string,
) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		return false
	}
	etag := fmt.Sprintf("%q", item.Thumbnail.CacheKey)
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return true
	}
	w.Header().Set("Content-Length", fmt.Sprintf("%d", info.Size()))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, file)
	return true
}

func renderThumbnailSVG(item library.Media) string {
	accent := "#64748b"
	if item.Type == library.MediaTypeAudio {
		accent = "#0f766e"
	}
	title := item.Metadata.Title
	if title == "" {
		title = item.Name
	}
	initial := "?"
	for _, r := range title {
		if r != ' ' {
			initial = strings.ToUpper(string(r))
			break
		}
	}
	return fmt.Sprintf(
		`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180" role="img" aria-label="%s"><rect width="320" height="180" fill="#111827"/><rect x="16" y="16" width="288" height="148" rx="10" fill="%s" opacity="0.85"/><text x="160" y="100" text-anchor="middle" font-family="system-ui, -apple-system, BlinkMacSystemFont, sans-serif" font-size="58" font-weight="700" fill="#fff">%s</text><text x="160" y="135" text-anchor="middle" font-family="system-ui, -apple-system, BlinkMacSystemFont, sans-serif" font-size="16" fill="#e5e7eb">%s</text></svg>`,
		html.EscapeString(title),
		accent,
		html.EscapeString(initial),
		html.EscapeString(truncate(title, 28)),
	)
}

func truncate(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max-1]) + "…"
}
