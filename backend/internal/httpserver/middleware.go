package httpserver

import (
	"compress/gzip"
	"io"
	"log/slog"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"
)

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (rec *statusRecorder) WriteHeader(status int) {
	rec.status = status
	rec.ResponseWriter.WriteHeader(status)
}

func (rec *statusRecorder) Unwrap() http.ResponseWriter {
	return rec.ResponseWriter
}

func (rec *statusRecorder) Flush() {
	if flusher, ok := rec.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// ReadFrom keeps io.Copy on the wrapped writer's optimized transfer path.
// In particular, net/http's response writer can use the platform sendfile
// path for regular-file media responses.
func (rec *statusRecorder) ReadFrom(reader io.Reader) (int64, error) {
	if readerFrom, ok := rec.ResponseWriter.(io.ReaderFrom); ok {
		return readerFrom.ReadFrom(reader)
	}
	return io.Copy(rec.ResponseWriter, reader)
}

type gzipResponseWriter struct {
	http.ResponseWriter
	writer      *gzip.Writer
	status      int
	wroteHeader bool
}

func (w *gzipResponseWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.status = status
	w.wroteHeader = true
}

func (w *gzipResponseWriter) Write(data []byte) (int, error) {
	if w.writer == nil {
		w.startGzip()
	}
	return w.writer.Write(data)
}

func (w *gzipResponseWriter) Close() error {
	if w.writer != nil {
		return w.writer.Close()
	}
	if w.wroteHeader {
		w.ResponseWriter.WriteHeader(w.status)
	}
	return nil
}

func (w *gzipResponseWriter) startGzip() {
	header := w.Header()
	header.Del("Content-Length")
	header.Set("Content-Encoding", "gzip")
	headerAddToken(header, "Vary", "Accept-Encoding")
	if !w.wroteHeader {
		w.status = http.StatusOK
		w.wroteHeader = true
	}
	w.ResponseWriter.WriteHeader(w.status)
	w.writer = gzip.NewWriter(w.ResponseWriter)
}

func (w *gzipResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (w *gzipResponseWriter) Flush() {
	if w.writer == nil {
		w.startGzip()
	}
	_ = w.writer.Flush()
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// quietPaths are excluded from access logs because they are polled by health
// checkers (the control server hits /healthz every two seconds) and would
// otherwise drown out signal in the log stream. The decision is intentionally
// scoped to a small allowlist; any new endpoint defaults to being logged.
var quietPaths = map[string]struct{}{
	"/healthz": {},
}

func quietRequest(requestPath string, status int) bool {
	if _, quiet := quietPaths[requestPath]; quiet {
		return true
	}
	return (strings.HasPrefix(requestPath, "/api/media/") ||
		strings.HasPrefix(requestPath, "/api/audio-resume-cache/media/") ||
		strings.HasPrefix(requestPath, "/api/video-optimization/media/") ||
		strings.HasPrefix(requestPath, "/api/video-optimization/hls/")) && status < 400
}

func loggingMiddleware(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{
			ResponseWriter: w,
			status:         http.StatusOK,
		}

		next.ServeHTTP(rec, r)

		if quietRequest(r.URL.Path, rec.status) {
			return
		}

		logger.Info(
			"http request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration_ms", time.Since(start).Milliseconds(),
		)
	})
}

func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !shouldGzipRequest(r) {
			next.ServeHTTP(w, r)
			return
		}
		headerAddToken(w.Header(), "Vary", "Accept-Encoding")
		gz := &gzipResponseWriter{ResponseWriter: w}
		next.ServeHTTP(gz, r)
		_ = gz.Close()
	})
}

func shouldGzipRequest(r *http.Request) bool {
	if r.Method == http.MethodHead || r.Header.Get("Range") != "" {
		return false
	}
	if !acceptsGzip(r.Header.Get("Accept-Encoding")) {
		return false
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		return compressibleStaticAsset(r.URL.Path)
	}
	switch {
	case strings.HasPrefix(r.URL.Path, "/api/video-optimization/hls/"):
		return strings.HasSuffix(r.URL.Path, "/index.m3u8")
	case strings.HasPrefix(r.URL.Path, "/api/media/"),
		strings.HasPrefix(r.URL.Path, "/api/audio-resume-cache/media/"),
		strings.HasPrefix(r.URL.Path, "/api/video-optimization/media/"),
		strings.HasPrefix(r.URL.Path, "/api/thumbnails/"),
		strings.HasPrefix(r.URL.Path, "/api/library/events"):
		return false
	default:
		return true
	}
}

func compressibleStaticAsset(requestPath string) bool {
	if !strings.HasPrefix(requestPath, "/assets/") {
		return false
	}
	switch path.Ext(requestPath) {
	case ".css", ".js", ".json", ".map", ".svg":
		return true
	default:
		return false
	}
}

func acceptsGzip(value string) bool {
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		token, _, _ := strings.Cut(part, ";")
		if strings.EqualFold(strings.TrimSpace(token), "gzip") && encodingAllowed(part) {
			return true
		}
	}
	return false
}

func encodingAllowed(value string) bool {
	_, parameters, hasParameters := strings.Cut(value, ";")
	if !hasParameters {
		return true
	}
	for _, parameter := range strings.Split(parameters, ";") {
		name, rawValue, found := strings.Cut(strings.TrimSpace(parameter), "=")
		if !found || !strings.EqualFold(strings.TrimSpace(name), "q") {
			continue
		}
		q, err := strconv.ParseFloat(strings.TrimSpace(rawValue), 64)
		return err != nil || q > 0
	}
	return true
}

func headerAddToken(header http.Header, key, token string) {
	for _, value := range header.Values(key) {
		for _, existing := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(existing), token) {
				return
			}
		}
	}
	header.Add(key, token)
}
