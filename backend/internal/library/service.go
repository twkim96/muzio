package library

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"muzio/backend/internal/mediapath"
)

type MediaRootSettings struct {
	AudioRoots []string `json:"audioRoots"`
	VideoRoots []string `json:"videoRoots"`
	ImageRoots []string `json:"imageRoots"`
}

type MediaRootUpdateResult struct {
	Settings       MediaRootSettings
	ItemCount      int
	Persistent     bool
	Reconciliation ReconciliationResult
	DegradedRoots  []DegradedRoot
}

type DegradedRoot struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	Error string `json:"error"`
}

type IndexStatus struct {
	Enabled        bool       `json:"enabled"`
	LoadedItems    int        `json:"loadedItems"`
	LastVerifiedAt *time.Time `json:"lastVerifiedAt,omitempty"`
	LastError      string     `json:"lastError,omitempty"`
}

var ErrMediaRootUpdateSuperseded = errors.New("library: media root update superseded by a newer request")
var ErrMediaRootUpdateRetry = errors.New("library: media root update changed too much during scan; retry")

type MediaRootPersister func(MediaRootSettings) error
type mediaRootScanner func(MediaRootSettings, *slog.Logger) (*mediapath.Roots, []RootScanResult, error)

type Service struct {
	// Mutation paths take updateMu before briefly taking mu. Code holding mu
	// must not wait for updateMu or call external I/O.
	mu         sync.RWMutex
	roots      *mediapath.Roots
	snapshot   *Snapshot
	settings   MediaRootSettings
	logger     *slog.Logger
	persist    MediaRootPersister
	persistent bool
	degraded   []DegradedRoot
	index      indexCoordinator
	watcher    watcherManager

	updateMu sync.Mutex
	events   libraryEventBroker
	scans    scanCoordinator
	streams  streamActivity
	scanner  mediaRootScanner

	updateGeneration atomic.Uint64
}

func NewService(
	settings MediaRootSettings,
	logger *slog.Logger,
	persist MediaRootPersister,
) (*Service, error) {
	if logger == nil {
		logger = slog.Default()
	}
	normalized := NormalizeMediaRootSettings(settings)
	roots, results, err := scanMediaRootSettingsReport(normalized, logger)
	if err != nil {
		return nil, err
	}
	service := &Service{
		roots:      roots,
		snapshot:   NewSnapshot(flattenRootScanResults(results)),
		settings:   normalized,
		logger:     logger,
		persist:    persist,
		persistent: persist != nil,
		degraded:   degradedRoots(results),
	}
	service.initializeLifecycle()
	service.scanner = service.defaultScanner
	return service, nil
}

func NewPersistentService(
	settings MediaRootSettings,
	logger *slog.Logger,
	persist MediaRootPersister,
	indexPath string,
) (*Service, error) {
	if logger == nil {
		logger = slog.Default()
	}
	normalized := NormalizeMediaRootSettings(settings)
	_, paths, err := mediaRootTypeMap(normalized)
	if err != nil {
		return nil, err
	}
	roots, err := mediapath.NewRoots(paths)
	if err != nil {
		return nil, err
	}
	index, state, loadErr := OpenPersistentIndex(indexPath, normalized)
	if index == nil {
		return nil, loadErr
	}
	if loadErr != nil && !errors.Is(loadErr, os.ErrNotExist) {
		logger.Warn("persistent library index ignored", "path", indexPath, "error", loadErr)
	}
	state.Items = markUnavailableRootItems(state.Items, roots)
	service := &Service{
		roots:      roots,
		snapshot:   newSnapshotAtRevision(state.Items, state.Revision),
		settings:   normalized,
		logger:     logger,
		persist:    persist,
		persistent: persist != nil,
	}
	service.initializeLifecycle()
	service.scanner = service.defaultScanner
	writer := newIndexWriter(index, defaultIndexQuietWindow, service.indexCheckpoint)
	service.index = newIndexCoordinator(
		writer,
		IndexStatus{
			Enabled:        true,
			LoadedItems:    len(state.Items),
			LastVerifiedAt: timePointer(state.LastVerifiedAt),
		},
	)
	return service, nil
}

func (s *Service) initializeLifecycle() {
	s.scans = newScanCoordinator()
	s.streams = newStreamActivity()
}

func (s *Service) defaultScanner(
	settings MediaRootSettings,
	logger *slog.Logger,
) (*mediapath.Roots, []RootScanResult, error) {
	return scanMediaRootSettingsReportContext(
		s.scans.ctx,
		settings,
		logger,
		s.waitBeforeScanRoot,
	)
}

func (s *Service) MediaRootSettings() MediaRootSettings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneSettings(s.settings)
}

func (s *Service) MediaRootsPersistent() bool {
	return s.persistent
}

func (s *Service) DegradedRoots() []DegradedRoot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneDegradedRoots(s.degraded)
}

func (s *Service) IndexStatus() IndexStatus {
	return s.index.currentStatus()
}

func (s *Service) WatcherStatus() WatcherStatus {
	return s.watcher.status()
}

func (s *Service) StartWatcher() WatcherStatus {
	return s.watcher.start(s, s.logger, s.watchPaths())
}

func (s *Service) watchPaths() []string {
	s.mu.RLock()
	roots := s.roots
	s.mu.RUnlock()
	if roots == nil {
		return nil
	}
	all := roots.All()
	paths := make([]string, 0, len(all))
	for _, root := range all {
		paths = append(paths, root.Path)
	}
	return paths
}

func (s *Service) restartWatcher() {
	s.watcher.restart(s, s.logger, s.watchPaths())
}

func (s *Service) stopWatcher() error {
	return s.watcher.stop()
}

func (s *Service) setWatcherError(err error) {
	s.watcher.setError(err)
}

func (s *Service) UpdateMediaRoots(settings MediaRootSettings) (MediaRootUpdateResult, error) {
	generation := s.updateGeneration.Add(1)
	normalized := NormalizeMediaRootSettings(settings)
	s.mu.RLock()
	baseRevision := s.snapshot.Revision()
	s.mu.RUnlock()

	roots, results, err := s.scanSettings(normalized)
	if err != nil {
		return MediaRootUpdateResult{}, err
	}

	s.updateMu.Lock()
	restartWatcher := false
	defer func() {
		s.updateMu.Unlock()
		if restartWatcher {
			s.restartWatcher()
		}
	}()

	if generation != s.updateGeneration.Load() {
		return MediaRootUpdateResult{}, ErrMediaRootUpdateSuperseded
	}

	s.mu.RLock()
	snapshot := s.snapshot
	s.mu.RUnlock()
	items := mergeRootScanResults(snapshot, results, normalized)
	var replayed bool
	items, replayed = replayConcurrentChanges(snapshot, baseRevision, items, roots, normalized)
	if !replayed {
		return MediaRootUpdateResult{}, ErrMediaRootUpdateRetry
	}
	nextSnapshot, reconciliation := snapshot.Reconciled(items)
	degraded := degradedRoots(results)
	verifiedAt := successfulVerificationTime(results)

	if err := s.index.reset(
		normalized,
		items,
		reconciliation.Revision,
		verifiedAt,
		s.persist != nil,
	); err != nil {
		return MediaRootUpdateResult{}, err
	}
	if s.persist != nil {
		if err := s.persist(normalized); err != nil {
			if rollbackErr := s.index.finishPreparedReset(true); rollbackErr != nil {
				s.logger.Error(
					"persistent library index rollback failed",
					"error", rollbackErr,
				)
			}
			return MediaRootUpdateResult{}, err
		}
		if err := s.index.finishPreparedReset(false); err != nil {
			s.logger.Warn("persistent library index commit cleanup failed", "error", err)
		}
	}

	s.mu.Lock()
	s.snapshot = nextSnapshot
	s.roots = roots
	s.settings = normalized
	s.degraded = degraded
	s.mu.Unlock()
	s.index.updateSnapshotState(len(items), verifiedAt)
	restartWatcher = true
	s.publishLibraryEvent(reconciliation, "roots-updated")

	return MediaRootUpdateResult{
		Settings:       cloneSettings(normalized),
		ItemCount:      len(items),
		Persistent:     s.persistent,
		Reconciliation: reconciliation,
		DegradedRoots:  cloneDegradedRoots(degraded),
	}, nil
}

func (s *Service) RescanMediaRoots() (MediaRootUpdateResult, error) {
	return s.scans.rescanOnce(s.rescanMediaRoots)
}

func (s *Service) rescanMediaRoots() (MediaRootUpdateResult, error) {
	s.mu.RLock()
	settings := cloneSettings(s.settings)
	baseRevision := s.snapshot.Revision()
	s.mu.RUnlock()

	roots, results, err := s.scanSettings(settings)
	if err != nil {
		return MediaRootUpdateResult{}, err
	}

	s.updateMu.Lock()
	defer s.updateMu.Unlock()

	s.mu.RLock()
	if !mediaRootSettingsEqual(s.settings, settings) {
		currentSettings := cloneSettings(s.settings)
		currentSnapshot := s.snapshot
		degraded := cloneDegradedRoots(s.degraded)
		s.mu.RUnlock()
		return MediaRootUpdateResult{
			Settings:      currentSettings,
			ItemCount:     currentSnapshot.Len(),
			Persistent:    s.persistent,
			DegradedRoots: degraded,
		}, nil
	}
	snapshot := s.snapshot
	s.mu.RUnlock()
	items := mergeRootScanResults(snapshot, results, settings)
	var replayed bool
	items, replayed = replayConcurrentChanges(snapshot, baseRevision, items, roots, settings)
	if !replayed {
		degraded := degradedRoots(results)
		s.mu.Lock()
		s.degraded = degraded
		s.mu.Unlock()
		return MediaRootUpdateResult{}, ErrMediaRootUpdateRetry
	}
	nextSnapshot, reconciliation := snapshot.Reconciled(items)
	degraded := degradedRoots(results)
	verifiedAt := successfulVerificationTime(results)
	if err := s.persistIndexChanges(
		nextSnapshot,
		snapshot.Revision(),
		settings,
		verifiedAt,
	); err != nil {
		s.logger.Warn("persistent library index update failed", "error", err)
	}

	s.mu.Lock()
	s.snapshot = nextSnapshot
	s.roots = roots
	s.degraded = degraded
	s.mu.Unlock()
	s.index.updateSnapshotState(len(items), verifiedAt)
	s.publishLibraryEvent(reconciliation, "rescan")

	return MediaRootUpdateResult{
		Settings:       cloneSettings(settings),
		ItemCount:      len(items),
		Persistent:     s.persistent,
		Reconciliation: reconciliation,
		DegradedRoots:  cloneDegradedRoots(degraded),
	}, nil
}

func (s *Service) Revision() uint64 {
	s.mu.RLock()
	snapshot := s.snapshot
	s.mu.RUnlock()
	if snapshot == nil {
		return 0
	}
	return snapshot.Revision()
}

func (s *Service) RevisionFor(filter MediaType) uint64 {
	s.mu.RLock()
	snapshot := s.snapshot
	s.mu.RUnlock()
	if snapshot == nil {
		return 0
	}
	return snapshot.RevisionFor(filter)
}

func (s *Service) ChangesSince(revision uint64, filter MediaType) SnapshotChanges {
	s.mu.RLock()
	snapshot := s.snapshot
	s.mu.RUnlock()
	if snapshot == nil {
		return SnapshotChanges{Revision: revision}
	}
	return visibleChanges(snapshot.ChangesSince(revision, filter))
}

func (s *Service) ApplyChanges(upserts []Media, deletedIDs []string) ReconciliationResult {
	return s.applyChanges(upserts, deletedIDs, "service")
}

func (s *Service) UpdateThumbnailStatus(id, cacheKey, status string) ReconciliationResult {
	s.updateMu.Lock()
	defer s.updateMu.Unlock()

	s.mu.RLock()
	snapshot := s.snapshot
	s.mu.RUnlock()
	if snapshot == nil {
		return ReconciliationResult{}
	}
	current, err := snapshot.Get(id)
	if err != nil ||
		(current.Type != MediaTypeVideo &&
			current.Type != MediaTypeImage &&
			current.Type != MediaTypeAudio) ||
		current.Thumbnail.CacheKey != cacheKey {
		return ReconciliationResult{Revision: snapshot.Revision()}
	}
	next := ThumbnailWithStatus(current.Thumbnail, current.ID, status)
	if current.Type == MediaTypeImage {
		next.Kind = ThumbnailKindImage
	} else if current.Type == MediaTypeAudio {
		next.Kind = ThumbnailKindAudio
	} else {
		next.Kind = ThumbnailKindVideo
	}
	if current.Thumbnail == next {
		return ReconciliationResult{Revision: snapshot.Revision()}
	}
	current.Thumbnail = next
	return s.applyChangesLocked([]Media{current}, nil, "thumbnail")
}

func (s *Service) applyChanges(
	upserts []Media,
	deletedIDs []string,
	reason string,
) ReconciliationResult {
	s.updateMu.Lock()
	defer s.updateMu.Unlock()
	return s.applyChangesLocked(upserts, deletedIDs, reason)
}

func (s *Service) applyChangesLocked(
	upserts []Media,
	deletedIDs []string,
	reason string,
) ReconciliationResult {
	s.mu.RLock()
	snapshot := s.snapshot
	s.mu.RUnlock()
	if snapshot == nil {
		return ReconciliationResult{}
	}
	before := snapshot.Revision()
	result := snapshot.Apply(upserts, deletedIDs)
	if result.Revision != before {
		matched := false
		s.mu.Lock()
		if s.snapshot == snapshot {
			matched = true
		}
		s.mu.Unlock()
		if matched {
			s.index.updateSnapshotState(snapshot.Len(), time.Time{})
		}
	}
	if err := s.persistIndexChanges(
		snapshot,
		before,
		s.MediaRootSettings(),
		time.Time{},
	); err != nil {
		s.logger.Warn("persistent library index update failed", "error", err)
	}
	s.publishLibraryEvent(result, reason)
	return result
}

func (s *Service) ReportMissingMedia(id string) {
	s.applyChanges(nil, []string{id}, "missing")
}

func (s *Service) SubscribeLibraryEvents() (<-chan LibraryEvent, func()) {
	return s.events.subscribe()
}

func (s *Service) publishLibraryEvent(result ReconciliationResult, reason string) {
	s.events.publish(result, reason)
}

func (s *Service) Close() error {
	return s.CloseContext(context.Background())
}

func (s *Service) CloseContext(ctx context.Context) error {
	s.scans.stop()

	watcherErr := s.stopWatcher()
	if err := s.scans.wait(ctx); err != nil {
		if s.index.enabled() {
			go func() {
				_ = s.index.close()
			}()
		}
		return err
	}
	if !s.index.enabled() {
		return watcherErr
	}
	indexDone := make(chan error, 1)
	go func() {
		indexDone <- s.index.close()
	}()
	select {
	case err := <-indexDone:
		if watcherErr != nil {
			return watcherErr
		}
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Service) BeginMediaStream() func() {
	return s.streams.begin()
}

func (s *Service) WaitForMediaIdle(ctx context.Context) error {
	return s.streams.waitUntilIdle(ctx, true)
}

// WaitForMediaQuiet keeps expensive background work behind a quiet window.
// Root scanning continues to use WaitForMediaIdle so watcher reconciliation
// resumes promptly once an active transfer finishes.
func (s *Service) WaitForMediaQuiet(
	ctx context.Context,
	quietWindow time.Duration,
) error {
	return s.streams.waitUntilQuiet(ctx, quietWindow)
}

// BackgroundWorkContext is canceled when a new media response begins. The
// thumbnail manager uses it to stop ffmpeg/image work that would otherwise
// continue competing with resumed playback.
func (s *Service) BackgroundWorkContext(
	parent context.Context,
) (context.Context, context.CancelFunc) {
	return s.streams.backgroundWorkContext(parent)
}

func (s *Service) List(filter MediaType) []Media {
	s.mu.RLock()
	snapshot := s.snapshot
	s.mu.RUnlock()
	if snapshot == nil {
		return nil
	}
	return visibleMedia(snapshot.List(filter))
}

// Len returns the number of visible media records without cloning them.
func (s *Service) Len() int {
	s.mu.RLock()
	snapshot := s.snapshot
	s.mu.RUnlock()
	if snapshot == nil {
		return 0
	}
	return snapshot.VisibleLen()
}

func (s *Service) ListWithRevisions(filter MediaType) ([]Media, uint64, uint64) {
	s.mu.RLock()
	snapshot := s.snapshot
	s.mu.RUnlock()
	if snapshot == nil {
		return nil, 0, 0
	}
	items, revision, typeRevision := snapshot.ListWithRevisions(filter)
	return visibleMedia(items), revision, typeRevision
}

// ListStored returns the complete index state for backend maintenance tasks.
// Offline-root records are included even though public list APIs hide them.
func (s *Service) ListStored(filter MediaType) []Media {
	s.mu.RLock()
	snapshot := s.snapshot
	s.mu.RUnlock()
	if snapshot == nil {
		return nil
	}
	return snapshot.List(filter)
}

// ListStoredTypes returns complete records for the requested media types in
// one snapshot traversal. Offline-root records are included.
func (s *Service) ListStoredTypes(filters ...MediaType) []Media {
	s.mu.RLock()
	snapshot := s.snapshot
	s.mu.RUnlock()
	if snapshot == nil {
		return nil
	}
	return snapshot.ListTypes(filters...)
}

func (s *Service) ListStoredTypesWithRevision(
	filters ...MediaType,
) ([]Media, uint64) {
	s.mu.RLock()
	snapshot := s.snapshot
	s.mu.RUnlock()
	if snapshot == nil {
		return nil, 0
	}
	return snapshot.ListTypesWithRevision(filters...)
}

func (s *Service) Get(id string) (Media, error) {
	s.mu.RLock()
	snapshot := s.snapshot
	s.mu.RUnlock()
	if snapshot == nil {
		return Media{}, ErrNotFound
	}
	return snapshot.Get(id)
}

func (s *Service) GetByPath(rootName, relativePath string) (Media, error) {
	s.mu.RLock()
	snapshot := s.snapshot
	s.mu.RUnlock()
	if snapshot == nil {
		return Media{}, ErrNotFound
	}
	return snapshot.GetByPath(rootName, relativePath)
}

func (s *Service) ResolveStrict(rootName, relPath string) (string, error) {
	s.mu.RLock()
	roots := s.roots
	s.mu.RUnlock()
	return roots.ResolveStrict(rootName, relPath)
}

func (s *Service) RootAvailable(rootName string) bool {
	s.mu.RLock()
	roots := s.roots
	s.mu.RUnlock()
	return roots != nil && roots.RootAvailable(rootName)
}

func (s *Service) scanSettings(settings MediaRootSettings) (*mediapath.Roots, []RootScanResult, error) {
	return s.scans.scan(settings, s.scanner, s.logger)
}

func (s *Service) waitBeforeScanRoot(ctx context.Context, first bool) error {
	return s.streams.waitUntilIdle(ctx, first)
}

func mergeRootScanResults(
	snapshot *Snapshot,
	results []RootScanResult,
	settings MediaRootSettings,
) []Media {
	allowedByPath, _, _ := mediaRootTypeMap(settings)
	var items []Media
	for _, result := range results {
		if result.Complete {
			scanned := withOfflineState(result.Items, false)
			items = append(items, preserveRuntimeMediaFields(snapshot, scanned)...)
			continue
		}
		previous := snapshot.ListRoot(result.Root.Name)
		allowed := allowedByPath[result.Root.Path]
		filtered := previous[:0]
		for _, item := range previous {
			if allowed.allows(item.Type) {
				item.Offline = result.Unavailable
				filtered = append(filtered, item)
			}
		}
		merged := NewSnapshot(filtered)
		scanned := withOfflineState(result.Items, result.Unavailable)
		merged.Apply(preserveRuntimeMediaFields(snapshot, scanned), nil)
		items = append(items, merged.List("")...)
	}
	return items
}

func preserveRuntimeMediaFields(snapshot *Snapshot, items []Media) []Media {
	if snapshot == nil {
		return items
	}
	snapshot.mu.RLock()
	defer snapshot.mu.RUnlock()
	for index := range items {
		current, exists := snapshot.byID[items[index].ID]
		if !exists ||
			current.Thumbnail.CacheKey == "" ||
			current.Thumbnail.CacheKey != items[index].Thumbnail.CacheKey ||
			current.Thumbnail.Kind != items[index].Thumbnail.Kind {
			continue
		}
		items[index].Thumbnail = current.Thumbnail
	}
	return items
}

func withOfflineState(items []Media, offline bool) []Media {
	out := cloneMediaSlice(items)
	for index := range out {
		out[index].Offline = offline
	}
	return out
}

func markUnavailableRootItems(items []Media, roots *mediapath.Roots) []Media {
	out := cloneMediaSlice(items)
	if roots == nil {
		return out
	}
	unavailable := make(map[string]bool)
	for _, root := range roots.All() {
		unavailable[root.Name] = !roots.RootAvailable(root.Name)
	}
	for index := range out {
		out[index].Offline = unavailable[out[index].RootName]
	}
	return out
}

func visibleMedia(items []Media) []Media {
	visible := items[:0]
	for _, item := range items {
		if !item.Offline {
			visible = append(visible, item)
		}
	}
	return visible
}

func visibleChanges(changes SnapshotChanges) SnapshotChanges {
	if changes.ResetRequired {
		return changes
	}
	deleted := make(map[string]struct{}, len(changes.DeletedIDs))
	for _, id := range changes.DeletedIDs {
		deleted[id] = struct{}{}
	}
	upserts := changes.Upserts[:0]
	for _, item := range changes.Upserts {
		if item.Offline {
			deleted[item.ID] = struct{}{}
			continue
		}
		upserts = append(upserts, item)
		delete(deleted, item.ID)
	}
	changes.Upserts = upserts
	changes.DeletedIDs = changes.DeletedIDs[:0]
	for id := range deleted {
		changes.DeletedIDs = append(changes.DeletedIDs, id)
	}
	sort.Strings(changes.DeletedIDs)
	return changes
}

func replayConcurrentChanges(
	snapshot *Snapshot,
	baseRevision uint64,
	items []Media,
	roots *mediapath.Roots,
	settings MediaRootSettings,
) ([]Media, bool) {
	if snapshot.Revision() == baseRevision {
		return items, true
	}
	concurrent := snapshot.ChangesSince(baseRevision, "")
	if concurrent.ResetRequired {
		return nil, false
	}
	allowedByPath, _, _ := mediaRootTypeMap(settings)
	allowedByName := make(map[string]mediaTypeSet)
	for _, root := range roots.All() {
		allowedByName[root.Name] = allowedByPath[root.Path]
	}
	upserts := concurrent.Upserts[:0]
	for _, item := range concurrent.Upserts {
		if allowed, configured := allowedByName[item.RootName]; configured && allowed.allows(item.Type) {
			upserts = append(upserts, item)
		}
	}
	candidate := NewSnapshot(items)
	candidate.Apply(upserts, concurrent.DeletedIDs)
	return candidate.List(""), true
}

func degradedRoots(results []RootScanResult) []DegradedRoot {
	var degraded []DegradedRoot
	for _, result := range results {
		if result.Complete {
			continue
		}
		message := "incomplete scan"
		if result.Err != nil {
			message = result.Err.Error()
		}
		degraded = append(degraded, DegradedRoot{
			Name:  result.Root.Name,
			Path:  result.Root.Path,
			Error: message,
		})
	}
	return degraded
}

func cloneDegradedRoots(values []DegradedRoot) []DegradedRoot {
	return append([]DegradedRoot(nil), values...)
}

func timePointer(value time.Time) *time.Time {
	if value.IsZero() {
		return nil
	}
	copy := value
	return &copy
}

func successfulVerificationTime(results []RootScanResult) time.Time {
	if len(results) == 0 {
		return time.Now().UTC()
	}
	for _, result := range results {
		if !result.Complete {
			return time.Time{}
		}
	}
	return time.Now().UTC()
}

func (s *Service) persistIndexChanges(
	snapshot *Snapshot,
	fromRevision uint64,
	settings MediaRootSettings,
	verifiedAt time.Time,
) error {
	return s.index.persistChanges(snapshot, fromRevision, settings, verifiedAt)
}

func (s *Service) indexCheckpoint(revision uint64) (indexCheckpoint, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.snapshot == nil {
		return indexCheckpoint{}, false
	}
	items, ok := s.snapshot.ListAtRevision(revision)
	if !ok {
		return indexCheckpoint{}, false
	}
	var verifiedAt time.Time
	s.index.mu.RLock()
	if s.index.status.LastVerifiedAt != nil {
		verifiedAt = *s.index.status.LastVerifiedAt
	}
	s.index.mu.RUnlock()
	return indexCheckpoint{
		settings:   cloneSettings(s.settings),
		items:      items,
		revision:   revision,
		verifiedAt: verifiedAt,
	}, true
}
