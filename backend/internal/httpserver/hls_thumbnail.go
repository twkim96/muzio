package httpserver

import (
	"bytes"
	"image/jpeg"
	"io"
	"net/http"
	"time"
)

// Thumbnails are disposable, bounded JPEG frames captured by a viewer. Neither
// reading the list image nor uploading it counts as a playback heartbeat.
func (c *hlsCache) serveThumbnail(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPut {
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
		if err != nil {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
		info, err := jpeg.DecodeConfig(bytes.NewReader(data))
		if err != nil || info.Width < 1 || info.Height < 1 || info.Width > 320 || info.Height > 180 {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.closed {
			w.WriteHeader(http.StatusGone)
			return
		}
		// Multiple tabs watching this HLS still retain just one small image.
		if len(c.thumbnail) == 0 || time.Since(c.thumbnailAt) >= 30*time.Second {
			c.thumbnail = data
			c.thumbnailAt = time.Now()
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	c.mu.Lock()
	data, closed := c.thumbnail, c.closed
	c.mu.Unlock()
	if closed {
		w.WriteHeader(http.StatusGone)
		return
	}
	if len(data) == 0 {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, "thumbnail.jpg", time.Time{}, bytes.NewReader(data))
}
