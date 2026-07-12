package httpserver

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"muzio/backend/internal/library"
)

// LibraryLister is the read-side contract the listing handler depends on.
// Keeping this narrow makes the handler trivial to test with fakes and lets
// the snapshot implementation evolve without touching HTTP code.
type LibraryLister interface {
	List(filter library.MediaType) []library.Media
}

type LibraryRevisionReader interface {
	Revision() uint64
	ChangesSince(revision uint64, filter library.MediaType) library.SnapshotChanges
}

type LibrarySnapshotReader interface {
	ListWithRevisions(filter library.MediaType) ([]library.Media, uint64, uint64)
}

type libraryListResponse struct {
	Revision uint64          `json:"revision"`
	Items    []library.Media `json:"items"`
}

func libraryListHandler(lister LibraryLister) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		filter, err := parseTypeFilter(r.URL.Query().Get("type"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		if requestETag := r.Header.Get("If-None-Match"); requestETag != "" {
			revision := libraryFilterRevision(lister, filter)
			if requestETag == libraryETag(revision, filter) {
				w.Header().Set("ETag", requestETag)
				w.WriteHeader(http.StatusNotModified)
				return
			}
		}
		items, revision, etagRevision := libraryItemsWithRevisions(lister, filter)
		if items == nil {
			items = []library.Media{}
		}

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", libraryETag(etagRevision, filter))
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(libraryListResponse{
			Revision: revision,
			Items:    items,
		})
	}
}

func libraryItemsWithRevisions(
	lister LibraryLister,
	filter library.MediaType,
) ([]library.Media, uint64, uint64) {
	if reader, ok := lister.(LibrarySnapshotReader); ok {
		return reader.ListWithRevisions(filter)
	}
	revision := libraryRevision(lister)
	return lister.List(filter), revision, revision
}

func libraryChangesHandler(reader LibraryRevisionReader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		sinceValue := r.URL.Query().Get("since")
		since, err := strconv.ParseUint(sinceValue, 10, 64)
		if err != nil {
			http.Error(w, "since must be an unsigned revision", http.StatusBadRequest)
			return
		}
		filter, err := parseTypeFilter(r.URL.Query().Get("type"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		response := reader.ChangesSince(since, filter)
		if response.Upserts == nil {
			response.Upserts = []library.Media{}
		}
		if response.DeletedIDs == nil {
			response.DeletedIDs = []string{}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", libraryETag(response.ETagRevision, filter))
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(response)
	}
}

func libraryRevision(lister LibraryLister) uint64 {
	if reader, ok := lister.(interface{ Revision() uint64 }); ok {
		return reader.Revision()
	}
	return 0
}

func libraryFilterRevision(lister LibraryLister, filter library.MediaType) uint64 {
	if reader, ok := lister.(interface {
		RevisionFor(library.MediaType) uint64
	}); ok {
		return reader.RevisionFor(filter)
	}
	return libraryRevision(lister)
}

func libraryETag(revision uint64, filter library.MediaType) string {
	label := string(filter)
	if label == "" {
		label = "all"
	}
	return fmt.Sprintf(`W/"library-%d-%s"`, revision, label)
}

func parseTypeFilter(value string) (library.MediaType, error) {
	switch value {
	case "", "all":
		return "", nil
	case string(library.MediaTypeVideo):
		return library.MediaTypeVideo, nil
	case string(library.MediaTypeAudio):
		return library.MediaTypeAudio, nil
	case string(library.MediaTypeImage):
		return library.MediaTypeImage, nil
	default:
		return "", errBadTypeFilter
	}
}

type httpError string

func (e httpError) Error() string { return string(e) }

const errBadTypeFilter httpError = "type must be one of: video, audio, image, all"
