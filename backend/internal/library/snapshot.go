package library

import (
	"errors"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

const (
	defaultJournalBatchLimit  = 128
	defaultJournalRecordLimit = 10000
)

// ErrNotFound is returned when a media ID does not exist in the snapshot.
var ErrNotFound = errors.New("library: media not found")

type ReconciliationResult struct {
	Revision      uint64
	Added         int
	Updated       int
	Removed       int
	AffectedTypes []MediaType
	Full          bool
}

type SnapshotChanges struct {
	Revision      uint64   `json:"revision"`
	Upserts       []Media  `json:"upserts"`
	DeletedIDs    []string `json:"deletedIds"`
	ResetRequired bool     `json:"resetRequired"`
	ETagRevision  uint64   `json:"-"`
}

type snapshotDeletion struct {
	ID   string
	Type MediaType
}

type snapshotBatch struct {
	Revision uint64
	Upserts  []Media
	Deleted  []snapshotDeletion
}

// Snapshot is the atomically updated read model for the media library.
type Snapshot struct {
	mu sync.RWMutex

	orderedIDs []string
	byID       map[string]Media
	byPath     map[string]string

	revision      uint64
	typeRevisions map[MediaType]uint64

	journal            []snapshotBatch
	journalFloor       uint64
	journalBatchLimit  int
	journalRecordLimit int
}

// NewSnapshot returns a Snapshot seeded with the provided items.
func NewSnapshot(items []Media) *Snapshot {
	return newSnapshot(items, defaultJournalBatchLimit, defaultJournalRecordLimit)
}

func newSnapshotAtRevision(items []Media, revision uint64) *Snapshot {
	s := newSnapshot(items, defaultJournalBatchLimit, defaultJournalRecordLimit)
	if revision > s.revision {
		s.revision = revision
		for mediaType := range s.typeRevisions {
			s.typeRevisions[mediaType] = revision
		}
		s.journalFloor = revision
	}
	return s
}

func newSnapshot(items []Media, batchLimit, recordLimit int) *Snapshot {
	s := &Snapshot{
		byID:               make(map[string]Media),
		byPath:             make(map[string]string),
		typeRevisions:      make(map[MediaType]uint64),
		journalBatchLimit:  batchLimit,
		journalRecordLimit: recordLimit,
	}
	s.seed(items)
	return s
}

func (s *Snapshot) seed(items []Media) {
	orderedIDs, byID, byPath := buildSnapshotState(items)
	s.orderedIDs = orderedIDs
	s.byID = byID
	s.byPath = byPath
	if len(orderedIDs) > 0 {
		s.revision = 1
	}
	for _, item := range byID {
		s.typeRevisions[item.Type] = s.revision
	}
	s.journalFloor = s.revision
}

// Replace atomically reconciles the snapshot with a complete item set.
func (s *Snapshot) Replace(items []Media) ReconciliationResult {
	s.mu.Lock()
	defer s.mu.Unlock()

	nextByID := make(map[string]Media, len(items))
	for _, item := range items {
		item = cloneMedia(item)
		nextByID[item.ID] = item
	}

	upserts := make([]Media, 0)
	for id, item := range nextByID {
		current, ok := s.byID[id]
		if !ok || !mediaEqual(current, item) {
			upserts = append(upserts, item)
		}
	}
	deletedIDs := make([]string, 0)
	for id := range s.byID {
		if _, ok := nextByID[id]; !ok {
			deletedIDs = append(deletedIDs, id)
		}
	}
	return s.applyLocked(upserts, deletedIDs, true)
}

// Apply atomically upserts and deletes individual media records.
func (s *Snapshot) Apply(upserts []Media, deletedIDs []string) ReconciliationResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.applyLocked(upserts, deletedIDs, false)
}

// Reconciled builds a replacement snapshot without blocking readers of the
// current snapshot while the full item set is compared and applied.
func (s *Snapshot) Reconciled(items []Media) (*Snapshot, ReconciliationResult) {
	s.mu.RLock()
	if s.matchesItemsLocked(items) {
		result := ReconciliationResult{
			Revision: s.revision,
			Full:     true,
		}
		s.mu.RUnlock()
		return s, result
	}
	s.mu.RUnlock()

	orderedIDs, nextByID, nextByPath := buildNormalizedSnapshotState(items)

	s.mu.RLock()
	defer s.mu.RUnlock()
	if snapshotMediaEqual(s.byID, nextByID) {
		return s, ReconciliationResult{
			Revision: s.revision,
			Full:     true,
		}
	}

	next := &Snapshot{
		orderedIDs:         orderedIDs,
		byID:               nextByID,
		byPath:             nextByPath,
		revision:           s.revision,
		typeRevisions:      make(map[MediaType]uint64, len(s.typeRevisions)),
		journal:            make([]snapshotBatch, len(s.journal)),
		journalFloor:       s.journalFloor,
		journalBatchLimit:  s.journalBatchLimit,
		journalRecordLimit: s.journalRecordLimit,
	}
	for mediaType, revision := range s.typeRevisions {
		next.typeRevisions[mediaType] = revision
	}
	for i, batch := range s.journal {
		next.journal[i] = snapshotBatch{
			Revision: batch.Revision,
			Upserts:  cloneMediaSlice(batch.Upserts),
			Deleted:  append([]snapshotDeletion(nil), batch.Deleted...),
		}
	}
	result := next.recordFullReconciliation(s.byID)
	return next, result
}

func (s *Snapshot) matchesItemsLocked(items []Media) bool {
	if len(items) != len(s.byID) || len(s.byPath) != len(s.byID) {
		return false
	}
	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		if item.ID == "" {
			return false
		}
		if _, duplicate := seen[item.ID]; duplicate {
			return false
		}
		seen[item.ID] = struct{}{}
		current, ok := s.byID[item.ID]
		if !ok || !mediaEqual(current, item) {
			return false
		}
	}
	return true
}

func (s *Snapshot) recordFullReconciliation(
	previous map[string]Media,
) ReconciliationResult {
	journalUpserts := make([]Media, 0)
	deletions := make([]snapshotDeletion, 0)
	affected := make(map[MediaType]struct{})
	added := 0
	updated := 0
	removed := 0

	for id, item := range s.byID {
		current, exists := previous[id]
		if exists && mediaEqual(current, item) {
			continue
		}
		if exists {
			updated++
			if current.Type != item.Type {
				deletions = append(deletions, snapshotDeletion{
					ID:   id,
					Type: current.Type,
				})
				affected[current.Type] = struct{}{}
			}
		} else {
			added++
		}
		journalUpserts = append(journalUpserts, cloneMedia(item))
		affected[item.Type] = struct{}{}
	}
	for id, item := range previous {
		if _, exists := s.byID[id]; exists {
			continue
		}
		removed++
		deletions = append(deletions, snapshotDeletion{
			ID:   id,
			Type: item.Type,
		})
		affected[item.Type] = struct{}{}
	}

	sortMedia(journalUpserts)
	sort.Slice(deletions, func(i, j int) bool {
		return deletions[i].ID < deletions[j].ID
	})
	s.revision++
	for mediaType := range affected {
		s.typeRevisions[mediaType] = s.revision
	}
	s.appendJournalLocked(snapshotBatch{
		Revision: s.revision,
		Upserts:  journalUpserts,
		Deleted:  deletions,
	})
	return ReconciliationResult{
		Revision:      s.revision,
		Added:         added,
		Updated:       updated,
		Removed:       removed,
		AffectedTypes: sortedMediaTypes(affected),
		Full:          true,
	}
}

func (s *Snapshot) applyLocked(upserts []Media, deletedIDs []string, full bool) ReconciliationResult {
	if s.byID == nil {
		s.byID = make(map[string]Media)
	}
	if s.byPath == nil {
		s.byPath = make(map[string]string)
	}

	pendingUpserts := normalizeUpserts(upserts)
	removed := make(map[string]snapshotDeletion)
	journalDeleted := make(map[string]snapshotDeletion)
	removeFromList := make(map[string]struct{})
	orderChanged := false

	removeCurrent := func(id string) (Media, bool) {
		item, ok := s.byID[id]
		if !ok {
			return Media{}, false
		}
		delete(s.byID, id)
		delete(s.byPath, mediaPathKey(item.RootName, item.RelativePath))
		removeFromList[id] = struct{}{}
		orderChanged = true
		return item, true
	}

	for _, id := range deletedIDs {
		if _, upsertWins := pendingUpserts[id]; upsertWins {
			continue
		}
		if item, ok := removeCurrent(id); ok {
			deletion := snapshotDeletion{ID: id, Type: item.Type}
			removed[id] = deletion
			journalDeleted[id] = deletion
		}
	}

	added := 0
	updated := 0
	appliedUpserts := make(map[string]Media)
	for _, item := range pendingUpserts {
		pathKey := mediaPathKey(item.RootName, item.RelativePath)
		if previousID, ok := s.byPath[pathKey]; ok && previousID != item.ID {
			if previous, exists := removeCurrent(previousID); exists {
				deletion := snapshotDeletion{ID: previousID, Type: previous.Type}
				removed[previousID] = deletion
				journalDeleted[previousID] = deletion
			}
		}

		current, exists := s.byID[item.ID]
		if exists && mediaEqual(current, item) {
			continue
		}
		if exists &&
			current.RootName == item.RootName &&
			current.RelativePath == item.RelativePath {
			updated++
			if current.Type != item.Type {
				journalDeleted[item.ID] = snapshotDeletion{ID: item.ID, Type: current.Type}
			}
			s.byID[item.ID] = item
			s.byPath[pathKey] = item.ID
			appliedUpserts[item.ID] = item
			continue
		}
		if exists {
			_, _ = removeCurrent(item.ID)
			updated++
			if current.Type != item.Type {
				journalDeleted[item.ID] = snapshotDeletion{ID: item.ID, Type: current.Type}
			}
		} else if deletion, wasRemoved := removed[item.ID]; wasRemoved {
			updated++
			if deletion.Type != item.Type {
				journalDeleted[item.ID] = deletion
			}
		} else {
			added++
			orderChanged = true
		}
		s.byID[item.ID] = item
		s.byPath[pathKey] = item.ID
		appliedUpserts[item.ID] = item
		delete(removed, item.ID)
		if deletion, ok := journalDeleted[item.ID]; ok && deletion.Type == item.Type {
			delete(journalDeleted, item.ID)
		}
	}

	if len(appliedUpserts) == 0 && len(removed) == 0 {
		return ReconciliationResult{Revision: s.revision, Full: full}
	}

	journalUpserts := make([]Media, 0, len(appliedUpserts))
	affected := make(map[MediaType]struct{})
	for _, item := range appliedUpserts {
		journalUpserts = append(journalUpserts, cloneMedia(item))
		affected[item.Type] = struct{}{}
	}
	sortMedia(journalUpserts)
	nextOrderedIDs := s.orderedIDs
	if orderChanged {
		remaining := make([]string, 0, len(s.orderedIDs)-len(removeFromList))
		for _, id := range s.orderedIDs {
			if _, remove := removeFromList[id]; !remove {
				if _, upserted := appliedUpserts[id]; !upserted {
					remaining = append(remaining, id)
				}
			}
		}
		nextOrderedIDs = mergeSortedMediaIDs(remaining, journalUpserts, s.byID)
	}

	deletions := make([]snapshotDeletion, 0, len(journalDeleted))
	for _, deletion := range journalDeleted {
		deletions = append(deletions, deletion)
		affected[deletion.Type] = struct{}{}
	}
	sort.Slice(deletions, func(i, j int) bool {
		return deletions[i].ID < deletions[j].ID
	})

	s.orderedIDs = nextOrderedIDs
	s.revision++
	if s.typeRevisions == nil {
		s.typeRevisions = make(map[MediaType]uint64)
	}
	for mediaType := range affected {
		s.typeRevisions[mediaType] = s.revision
	}
	s.appendJournalLocked(snapshotBatch{
		Revision: s.revision,
		Upserts:  journalUpserts,
		Deleted:  deletions,
	})

	return ReconciliationResult{
		Revision:      s.revision,
		Added:         added,
		Updated:       updated,
		Removed:       len(removed),
		AffectedTypes: sortedMediaTypes(affected),
		Full:          full,
	}
}

func normalizeUpserts(upserts []Media) map[string]Media {
	byID := make(map[string]Media, len(upserts))
	byPath := make(map[string]string, len(upserts))
	for _, raw := range upserts {
		item := cloneMedia(raw)
		if item.ID == "" {
			continue
		}
		if previous, ok := byID[item.ID]; ok {
			previousPath := mediaPathKey(previous.RootName, previous.RelativePath)
			if byPath[previousPath] == item.ID {
				delete(byPath, previousPath)
			}
		}
		pathKey := mediaPathKey(item.RootName, item.RelativePath)
		if previousID, ok := byPath[pathKey]; ok && previousID != item.ID {
			delete(byID, previousID)
		}
		byID[item.ID] = item
		byPath[pathKey] = item.ID
	}
	return byID
}

func (s *Snapshot) appendJournalLocked(batch snapshotBatch) {
	recordCount := len(batch.Upserts) + len(batch.Deleted)
	if s.journalBatchLimit <= 0 ||
		s.journalRecordLimit <= 0 ||
		recordCount > s.journalRecordLimit {
		s.journal = nil
		s.journalFloor = batch.Revision
		return
	}

	s.journal = append(s.journal, batch)
	totalRecords := 0
	for _, item := range s.journal {
		totalRecords += len(item.Upserts) + len(item.Deleted)
	}
	for len(s.journal) > s.journalBatchLimit || totalRecords > s.journalRecordLimit {
		evicted := s.journal[0]
		totalRecords -= len(evicted.Upserts) + len(evicted.Deleted)
		s.journalFloor = evicted.Revision
		s.journal = s.journal[1:]
	}
}

// Revision returns the current snapshot revision.
func (s *Snapshot) Revision() uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.revision
}

// RevisionFor returns the revision that last changed the requested filter.
func (s *Snapshot) RevisionFor(filter MediaType) uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.revisionForLocked(filter)
}

func (s *Snapshot) Len() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.orderedIDs)
}

func (s *Snapshot) VisibleLen() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	count := 0
	for _, id := range s.orderedIDs {
		if !s.byID[id].Offline {
			count++
		}
	}
	return count
}

// ChangesSince returns the merged delta after a known revision.
func (s *Snapshot) ChangesSince(revision uint64, filter MediaType) SnapshotChanges {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := SnapshotChanges{
		Revision:     s.revision,
		ETagRevision: s.revisionForLocked(filter),
	}
	if revision == s.revision {
		return result
	}
	if revision > s.revision || revision < s.journalFloor {
		result.ResetRequired = true
		return result
	}

	upserts := make(map[string]Media)
	deleted := make(map[string]snapshotDeletion)
	for _, batch := range s.journal {
		if batch.Revision <= revision {
			continue
		}
		for _, deletion := range batch.Deleted {
			if filter != "" && deletion.Type != filter {
				continue
			}
			deleted[deletion.ID] = deletion
			delete(upserts, deletion.ID)
		}
		for _, item := range batch.Upserts {
			if filter != "" && item.Type != filter {
				continue
			}
			upserts[item.ID] = cloneMedia(item)
			delete(deleted, item.ID)
		}
	}

	result.Upserts = make([]Media, 0, len(upserts))
	for _, item := range upserts {
		result.Upserts = append(result.Upserts, item)
	}
	sortMedia(result.Upserts)
	result.DeletedIDs = make([]string, 0, len(deleted))
	for id := range deleted {
		result.DeletedIDs = append(result.DeletedIDs, id)
	}
	sort.Strings(result.DeletedIDs)
	return result
}

// List returns a copy of the snapshot filtered by the requested type.
func (s *Snapshot) List(filter MediaType) []Media {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.listLocked(filter)
}

func (s *Snapshot) ListAtRevision(revision uint64) ([]Media, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.revision != revision {
		return nil, false
	}
	return s.listLocked(""), true
}

func (s *Snapshot) ListTypes(filters ...MediaType) []Media {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(filters) == 0 {
		return s.listLocked("")
	}
	allowed := make(map[MediaType]struct{}, len(filters))
	for _, filter := range filters {
		allowed[filter] = struct{}{}
	}
	out := make([]Media, 0)
	for _, id := range s.orderedIDs {
		item := s.byID[id]
		if _, ok := allowed[item.Type]; ok {
			out = append(out, cloneMedia(item))
		}
	}
	return out
}

func (s *Snapshot) ListWithRevisions(filter MediaType) ([]Media, uint64, uint64) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.listLocked(filter), s.revision, s.revisionForLocked(filter)
}

func (s *Snapshot) revisionForLocked(filter MediaType) uint64 {
	if filter == "" {
		return s.revision
	}
	return s.typeRevisions[filter]
}

func (s *Snapshot) listLocked(filter MediaType) []Media {
	if filter == "" {
		out := make([]Media, 0, len(s.orderedIDs))
		for _, id := range s.orderedIDs {
			out = append(out, cloneMedia(s.byID[id]))
		}
		return out
	}
	count := 0
	for _, id := range s.orderedIDs {
		if s.byID[id].Type == filter {
			count++
		}
	}
	out := make([]Media, 0, count)
	for _, id := range s.orderedIDs {
		item := s.byID[id]
		if item.Type == filter {
			out = append(out, cloneMedia(item))
		}
	}
	return out
}

// ListRoot returns all records belonging to one configured root.
func (s *Snapshot) ListRoot(rootName string) []Media {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := make([]Media, 0)
	for _, id := range s.orderedIDs {
		item := s.byID[id]
		if item.RootName == rootName {
			out = append(out, cloneMedia(item))
		}
	}
	return out
}

// Get returns the media record for an ID, or ErrNotFound.
func (s *Snapshot) Get(id string) (Media, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if item, ok := s.byID[id]; ok {
		return cloneMedia(item), nil
	}
	return Media{}, ErrNotFound
}

// GetByPath returns a media record by its root-relative identity.
func (s *Snapshot) GetByPath(rootName, relativePath string) (Media, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	id, ok := s.byPath[mediaPathKey(rootName, relativePath)]
	if !ok {
		return Media{}, ErrNotFound
	}
	return cloneMedia(s.byID[id]), nil
}

func buildSnapshotState(items []Media) ([]string, map[string]Media, map[string]string) {
	byID := make(map[string]Media, len(items))
	for _, item := range items {
		item = cloneMedia(item)
		if item.ID == "" {
			continue
		}
		byID[item.ID] = item
	}
	orderedIDs := make([]string, 0, len(byID))
	byPath := make(map[string]string, len(byID))
	for id, item := range byID {
		orderedIDs = append(orderedIDs, id)
		byPath[mediaPathKey(item.RootName, item.RelativePath)] = item.ID
	}
	sort.Slice(orderedIDs, func(i, j int) bool {
		return mediaLess(byID[orderedIDs[i]], byID[orderedIDs[j]])
	})
	return orderedIDs, byID, byPath
}

func buildNormalizedSnapshotState(
	items []Media,
) ([]string, map[string]Media, map[string]string) {
	byID := make(map[string]Media, len(items))
	byPath := make(map[string]string, len(items))
	for _, raw := range items {
		item := cloneMedia(raw)
		if item.ID == "" {
			continue
		}
		if previous, ok := byID[item.ID]; ok {
			previousPath := mediaPathKey(previous.RootName, previous.RelativePath)
			if byPath[previousPath] == item.ID {
				delete(byPath, previousPath)
			}
		}
		pathKey := mediaPathKey(item.RootName, item.RelativePath)
		if previousID, ok := byPath[pathKey]; ok && previousID != item.ID {
			delete(byID, previousID)
		}
		byID[item.ID] = item
		byPath[pathKey] = item.ID
	}
	orderedIDs := make([]string, 0, len(byID))
	for id := range byID {
		orderedIDs = append(orderedIDs, id)
	}
	sort.Slice(orderedIDs, func(i, j int) bool {
		return mediaLess(byID[orderedIDs[i]], byID[orderedIDs[j]])
	})
	return orderedIDs, byID, byPath
}

func snapshotMediaEqual(left, right map[string]Media) bool {
	if len(left) != len(right) {
		return false
	}
	for id, item := range left {
		candidate, ok := right[id]
		if !ok || !mediaEqual(item, candidate) {
			return false
		}
	}
	return true
}

func sortMedia(items []Media) {
	sort.Slice(items, func(i, j int) bool {
		if items[i].RootName != items[j].RootName {
			return items[i].RootName < items[j].RootName
		}
		return items[i].RelativePath < items[j].RelativePath
	})
}

func mergeSortedMediaIDs(left []string, right []Media, byID map[string]Media) []string {
	out := make([]string, 0, len(left)+len(right))
	i, j := 0, 0
	for i < len(left) && j < len(right) {
		if mediaLess(byID[left[i]], right[j]) {
			out = append(out, left[i])
			i++
			continue
		}
		out = append(out, right[j].ID)
		j++
	}
	out = append(out, left[i:]...)
	for ; j < len(right); j++ {
		out = append(out, right[j].ID)
	}
	return out
}

func mediaLess(left, right Media) bool {
	if left.RootName != right.RootName {
		return left.RootName < right.RootName
	}
	return left.RelativePath < right.RelativePath
}

func sortedMediaTypes(values map[MediaType]struct{}) []MediaType {
	order := []MediaType{MediaTypeAudio, MediaTypeVideo, MediaTypeImage}
	out := make([]MediaType, 0, len(values))
	for _, mediaType := range order {
		if _, ok := values[mediaType]; ok {
			out = append(out, mediaType)
		}
	}
	return out
}

func mediaPathKey(rootName, relativePath string) string {
	cleaned := filepath.ToSlash(filepath.Clean(filepath.FromSlash(relativePath)))
	cleaned = strings.TrimPrefix(cleaned, "/")
	return rootName + "\x00" + cleaned
}

func cloneMedia(item Media) Media {
	if item.Metadata.DurationSec != nil {
		duration := *item.Metadata.DurationSec
		item.Metadata.DurationSec = &duration
	}
	item.Subtitles = append([]Subtitle(nil), item.Subtitles...)
	return item
}

func cloneMediaSlice(items []Media) []Media {
	out := make([]Media, len(items))
	for i, item := range items {
		out[i] = cloneMedia(item)
	}
	return out
}

func mediaEqual(left, right Media) bool {
	if left.ID != right.ID ||
		left.Type != right.Type ||
		left.RootName != right.RootName ||
		left.RelativePath != right.RelativePath ||
		left.Name != right.Name ||
		left.MIMEType != right.MIMEType ||
		left.SizeBytes != right.SizeBytes ||
		!left.ModifiedAt.Equal(right.ModifiedAt) ||
		left.Metadata.Title != right.Metadata.Title ||
		left.Metadata.Artist != right.Metadata.Artist ||
		left.Metadata.Album != right.Metadata.Album ||
		left.Metadata.Season != right.Metadata.Season ||
		left.Metadata.Episode != right.Metadata.Episode ||
		left.Metadata.Year != right.Metadata.Year ||
		!optionalFloatEqual(left.Metadata.DurationSec, right.Metadata.DurationSec) ||
		left.Thumbnail != right.Thumbnail ||
		left.Offline != right.Offline ||
		len(left.Subtitles) != len(right.Subtitles) {
		return false
	}
	for i := range left.Subtitles {
		if left.Subtitles[i] != right.Subtitles[i] {
			return false
		}
	}
	return true
}

func optionalFloatEqual(left, right *float64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
