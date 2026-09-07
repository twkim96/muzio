package streaming

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"muzio/backend/internal/library"
	"muzio/backend/internal/videoopt"
)

const maxVideoIndexBytes int64 = 128 << 20

type videoIndexManifest struct {
	Eligible   bool   `json:"eligible"`
	Revision   string `json:"revision"`
	FileSize   int64  `json:"fileSize"`
	IndexBytes int64  `json:"indexBytes"`
	MIMEType   string `json:"mimeType"`
	ModifiedAt string `json:"modifiedAt"`
}

// Count header reads, including extended headers, to bound pathological files.
type boundedIndexReader struct {
	io.ReaderAt
	reads int
}

func (r *boundedIndexReader) ReadAt(p []byte, offset int64) (int, error) {
	if r.reads >= 4096 {
		return 0, fmt.Errorf("MP4 header limit exceeded")
	}
	r.reads++
	return r.ReaderAt.ReadAt(p, offset)
}

func mediaRevision(id string, info os.FileInfo) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%d", id, info.Size(), info.ModTime().UnixNano()))))
}

func serveVideoIndex(w http.ResponseWriter, r *http.Request, media library.Media, file *os.File, info os.FileInfo, mime, revision string) bool {
	mode := r.URL.Query().Get("index")
	if mode != "manifest" && mode != "data" {
		return false
	}
	w.Header().Set("Cache-Control", "no-store")
	manifest := videoIndexManifest{Revision: revision, FileSize: info.Size(), MIMEType: mime, ModifiedAt: info.ModTime().UTC().Format(http.TimeFormat)}
	ext := strings.ToLower(filepath.Ext(media.Name))
	if media.Type == library.MediaTypeVideo && (ext == ".mp4" || ext == ".mov") {
		inspected, err := videoopt.InspectMP4(&boundedIndexReader{ReaderAt: file}, info.Size())
		if err == nil && inspected.Layout == videoopt.LayoutFrontMoov && inspected.Movie != nil {
			end := inspected.Movie.Offset + inspected.Movie.Size
			if end <= maxVideoIndexBytes {
				manifest.Eligible = true
				manifest.IndexBytes = end
			}
		}
	}
	if mode == "manifest" {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodHead {
			_ = json.NewEncoder(w).Encode(manifest)
		}
		return true
	}
	if r.URL.Query().Get("revision") != revision {
		http.Error(w, "media revision changed", http.StatusConflict)
		return true
	}
	if !manifest.Eligible {
		http.Error(w, "video index unavailable", http.StatusNotFound)
		return true
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Length", strconv.FormatInt(manifest.IndexBytes, 10))
	if r.Method != http.MethodHead {
		_, _ = io.CopyN(w, file, manifest.IndexBytes)
	}
	return true
}
