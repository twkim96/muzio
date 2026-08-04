// Package streaming serves media files with HTTP Range support. The handler
// treats the request as opaque "give me bytes for media id X"; whether the
// client used a Range header for seeking, resumed a download, or fetched the
// whole file is decided by net/http.ServeContent.
package streaming

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"muzio/backend/internal/library"
	"muzio/backend/internal/mediapath"
)

const diagnosticTransportCookieName = "muzioDiagnosticTransportId"
const diagnosticSampleCookieName = "muzioDiagnosticSampleId"

// Lookup is the read-side dependency the streaming handler needs from the
// library snapshot. Keeping this narrow lets tests substitute a fake without
// pulling in scan logic.
type Lookup interface {
	Get(id string) (library.Media, error)
}

// PathResolver hides the strict-resolve boundary so the streaming handler
// stays focused on HTTP concerns.
type PathResolver interface {
	ResolveStrict(rootName, relPath string) (string, error)
}

type MissingMediaReporter interface {
	ReportMissingMedia(id string)
}

type RootAvailability interface {
	RootAvailable(rootName string) bool
}

type StreamActivityReporter interface {
	BeginMediaStream() func()
}

type mediaResponseRecorder struct {
	http.ResponseWriter
	status         int
	bytes          int64
	started        time.Time
	firstBodyWrite time.Duration
	wroteBody      bool
	writeErr       bool
}

func (rec *mediaResponseRecorder) WriteHeader(status int) {
	if rec.status == 0 {
		rec.status = status
		rec.ResponseWriter.WriteHeader(status)
	}
}

func (rec *mediaResponseRecorder) Write(data []byte) (int, error) {
	if rec.status == 0 {
		rec.status = http.StatusOK
	}
	rec.markBodyWrite()
	n, err := rec.ResponseWriter.Write(data)
	rec.bytes += int64(n)
	if err != nil {
		rec.writeErr = true
	}
	return n, err
}

func (rec *mediaResponseRecorder) ReadFrom(r io.Reader) (int64, error) {
	if rec.status == 0 {
		rec.status = http.StatusOK
	}
	rec.markBodyWrite()
	if readerFrom, ok := rec.ResponseWriter.(io.ReaderFrom); ok {
		n, err := readerFrom.ReadFrom(r)
		rec.bytes += n
		if err != nil {
			rec.writeErr = true
		}
		return n, err
	}
	n, err := io.Copy(rec.ResponseWriter, r)
	rec.bytes += n
	if err != nil {
		rec.writeErr = true
	}
	return n, err
}

func (rec *mediaResponseRecorder) Unwrap() http.ResponseWriter {
	return rec.ResponseWriter
}

func (rec *mediaResponseRecorder) statusOrOK() int {
	if rec.status == 0 {
		return http.StatusOK
	}
	return rec.status
}

func (rec *mediaResponseRecorder) markBodyWrite() {
	if rec.wroteBody {
		return
	}
	rec.wroteBody = true
	if rec.started.IsZero() {
		rec.firstBodyWrite = 0
		return
	}
	rec.firstBodyWrite = time.Since(rec.started)
}

func (rec *mediaResponseRecorder) firstBodyWriteMillis() any {
	if !rec.wroteBody {
		return nil
	}
	return rec.firstBodyWrite.Milliseconds()
}

// Handler returns the streaming HTTP handler. It accepts GET and HEAD; every
// other method is rejected with 405. Clients drive seeking and resumable
// downloads by sending or omitting Range, which is handled by net/http.
func Handler(roots PathResolver, lookup Lookup, logger *slog.Logger) http.HandlerFunc {
	if logger == nil {
		logger = slog.Default()
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if reporter, ok := lookup.(StreamActivityReporter); ok {
			end := reporter.BeginMediaStream()
			defer end()
		}

		id := mediaIDFromPath(r.URL.Path)
		if id == "" {
			http.Error(w, "missing media id", http.StatusBadRequest)
			return
		}

		media, err := lookup.Get(id)
		if errors.Is(err, library.ErrNotFound) {
			http.Error(w, "media not found", http.StatusNotFound)
			return
		}
		if err != nil {
			logger.Error("library lookup failed", "id", id, "error", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		realPath, err := roots.ResolveStrict(media.RootName, media.RelativePath)
		switch {
		case errors.Is(err, mediapath.ErrUnsafePath):
			// Refuse the request without leaking whether the file exists.
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		case errors.Is(err, mediapath.ErrUnknownRoot), errors.Is(err, fs.ErrNotExist):
			reportMissingMediaIfRootAvailable(roots, lookup, media)
			http.Error(w, "media not found", http.StatusNotFound)
			return
		case errors.Is(err, fs.ErrPermission):
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		case err != nil:
			logger.Error("resolve failed", "id", id, "error", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		file, err := os.Open(realPath)
		if err != nil {
			switch {
			case errors.Is(err, fs.ErrNotExist):
				reportMissingMediaIfRootAvailable(roots, lookup, media)
				http.Error(w, "media not found", http.StatusNotFound)
			case errors.Is(err, fs.ErrPermission):
				http.Error(w, "forbidden", http.StatusForbidden)
			default:
				logger.Error("open media failed", "id", id, "error", err)
				http.Error(w, "internal error", http.StatusInternalServerError)
			}
			return
		}
		defer file.Close()

		info, err := file.Stat()
		if err != nil {
			logger.Error("stat media failed", "id", id, "error", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		if !info.Mode().IsRegular() {
			// Directories, devices, sockets are never servable.
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		mime, ok := library.MIMEFor(media.Name)
		if !ok {
			// A media record exists but its extension is no longer classified.
			// Refuse rather than guess so the API contract stays honest.
			http.Error(w, "unsupported media type", http.StatusUnsupportedMediaType)
			return
		}
		w.Header().Set("Content-Type", mime)
		w.Header().Set("Cache-Control", "private, no-transform")
		w.Header().Set("ETag", mediaWeakETag(media.ID, info.Size(), info.ModTime()))

		ServeContentWithDiagnostics(w, r, media.Name, info.ModTime(), file, logger, media.ID, string(media.Type), "direct")
	}
}

// ServeContentWithDiagnostics keeps direct and optimized media streams on the
// same bounded Range telemetry contract without logging filesystem paths or
// arbitrary query/cookie values.
func ServeContentWithDiagnostics(
	w http.ResponseWriter,
	r *http.Request,
	name string,
	modifiedAt time.Time,
	content io.ReadSeeker,
	logger *slog.Logger,
	mediaID string,
	mediaType string,
	sourceKind string,
) {
	if logger == nil {
		logger = slog.Default()
	}
	started := time.Now()
	rec := &mediaResponseRecorder{ResponseWriter: w, started: started}
	http.ServeContent(rec, r, name, modifiedAt, content)
	diagnosticTransportID := mediaDiagnosticTransportID(r)
	diagnosticSampleID := ""
	logLevel := slog.LevelDebug
	if diagnosticTransportID != "" {
		diagnosticSampleID = mediaDiagnosticCookieID(r, diagnosticSampleCookieName)
		logLevel = slog.LevelInfo
	}
	logger.Log(
		r.Context(),
		logLevel,
		"media stream",
		"id", mediaID,
		"type", mediaType,
		"source_kind", sourceKind,
		"protocol", r.Proto,
		"diagnostic_transport_id", diagnosticTransportID,
		"diagnostic_sample_id", diagnosticSampleID,
		"method", r.Method,
		"request_kind", mediaRequestKind(r),
		"range", r.Header.Get("Range"),
		"status", rec.statusOrOK(),
		"bytes", rec.bytes,
		"started_at_unix_ms", started.UnixMilli(),
		"first_body_write_ms", rec.firstBodyWriteMillis(),
		"duration_ms", time.Since(started).Milliseconds(),
		"request_canceled", r.Context().Err() != nil,
		"write_error", rec.writeErr,
	)
}

func mediaDiagnosticTransportID(r *http.Request) string {
	return mediaDiagnosticCookieID(r, diagnosticTransportCookieName)
}

func mediaDiagnosticCookieID(r *http.Request, cookieName string) string {
	value := ""
	count := 0
	for _, cookie := range r.Cookies() {
		if cookie.Name != cookieName {
			continue
		}
		count++
		value = cookie.Value
	}
	if count != 1 || len(value) != 32 {
		return ""
	}
	for _, char := range value {
		if !((char >= '0' && char <= '9') ||
			(char >= 'a' && char <= 'f') ||
			(char >= 'A' && char <= 'F')) {
			return ""
		}
	}
	return strings.ToLower(value)
}

func mediaRequestKind(r *http.Request) string {
	if r.Method == http.MethodHead {
		return "head"
	}
	if r.Header.Get("Range") != "" {
		return "partial_get"
	}
	return "full_get"
}

func mediaWeakETag(mediaID string, size int64, modTime time.Time) string {
	return fmt.Sprintf(`W/"%s-%x-%x"`, sanitizeETagPart(mediaID), size, modTime.UnixNano())
}

func sanitizeETagPart(value string) string {
	value = strings.ReplaceAll(value, `\`, `_`)
	value = strings.ReplaceAll(value, `"`, `_`)
	return value
}

func reportMissingMediaIfRootAvailable(roots PathResolver, lookup Lookup, media library.Media) {
	availability, ok := roots.(RootAvailability)
	if !ok || !availability.RootAvailable(media.RootName) {
		return
	}
	if reporter, ok := lookup.(MissingMediaReporter); ok {
		reporter.ReportMissingMedia(media.ID)
	}
}

// mediaIDFromPath extracts the ID segment after "/api/media/". The ID must be
// the entire trailing portion: any further path segments (for example
// "/api/media/{id}/extra") yield an empty string so the handler can reject
// the request with 400 instead of silently truncating to the first segment.
//
// r.URL.Path never contains a query or fragment, so this only needs to guard
// against extra slashes.
func mediaIDFromPath(path string) string {
	const prefix = "/api/media/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	rest := strings.TrimPrefix(path, prefix)
	if rest == "" || strings.Contains(rest, "/") {
		return ""
	}
	return rest
}
