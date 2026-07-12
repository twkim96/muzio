package library

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"muzio/backend/internal/mediapath"
)

const (
	watcherQuietWindow     = 250 * time.Millisecond
	maxPendingWatcherPaths = 1024
)

type WatcherRootStatus struct {
	Path    string `json:"path"`
	Enabled bool   `json:"enabled"`
	Backend string `json:"backend,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

type WatcherStatus struct {
	Enabled   bool                `json:"enabled"`
	Backend   string              `json:"backend,omitempty"`
	Roots     []WatcherRootStatus `json:"roots"`
	LastError string              `json:"lastError,omitempty"`
}

type watchEvent struct {
	Path       string
	FullRescan bool
}

type watchRootDisabledError struct {
	Path string
	Err  error
}

func (e *watchRootDisabledError) Error() string {
	return e.Err.Error()
}

func (e *watchRootDisabledError) Unwrap() error {
	return e.Err
}

type watchBackend interface {
	Events() <-chan watchEvent
	Errors() <-chan error
	Close() error
}

type watchJob struct {
	paths      []string
	fullRescan bool
}

type watchRuntime struct {
	service *Service
	logger  *slog.Logger
	backend watchBackend
	cancel  context.CancelFunc
	done    chan struct{}
}

func newWatchRuntime(
	service *Service,
	logger *slog.Logger,
	backend watchBackend,
) *watchRuntime {
	ctx, cancel := context.WithCancel(context.Background())
	runtime := &watchRuntime{
		service: service,
		logger:  logger,
		backend: backend,
		cancel:  cancel,
		done:    make(chan struct{}),
	}
	go runtime.run(ctx)
	return runtime
}

func (w *watchRuntime) Close() error {
	w.cancel()
	err := w.backend.Close()
	<-w.done
	return err
}

func (w *watchRuntime) run(ctx context.Context) {
	defer close(w.done)

	jobs := make(chan watchJob, 32)
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		for {
			select {
			case job := <-jobs:
				if job.fullRescan {
					if _, err := w.service.RescanMediaRoots(); err != nil &&
						!errors.Is(err, context.Canceled) {
						w.service.setWatcherError(err)
						w.logger.Warn("watcher full reconciliation failed", "error", err)
					}
					continue
				}
				for _, path := range job.paths {
					if err := w.service.reconcileWatchPath(ctx, path); err != nil &&
						!errors.Is(err, context.Canceled) {
						w.service.setWatcherError(err)
						w.logger.Warn("watcher path reconciliation failed", "path", path, "error", err)
					}
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	pending := make(map[string]struct{})
	fullRescan := false
	var timer *time.Timer
	var timerC <-chan time.Time
	stopTimer := func() {
		if timer == nil {
			return
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timerC = nil
	}
	schedule := func() {
		if timer == nil {
			timer = time.NewTimer(watcherQuietWindow)
		} else {
			stopTimer()
			timer.Reset(watcherQuietWindow)
		}
		timerC = timer.C
	}
	dispatch := func() {
		if !fullRescan && len(pending) == 0 {
			timerC = nil
			return
		}
		paths := make([]string, 0, len(pending))
		for path := range pending {
			paths = append(paths, path)
		}
		paths = w.coalesceDeletedWatchPaths(paths)
		sort.Strings(paths)
		paths = compactWatchPaths(paths)
		job := watchJob{paths: paths, fullRescan: fullRescan}
		select {
		case jobs <- job:
			pending = make(map[string]struct{})
			fullRescan = false
			timerC = nil
		default:
			timer.Reset(watcherQuietWindow)
			timerC = timer.C
		}
	}

	events := w.backend.Events()
	errors := w.backend.Errors()
	for {
		select {
		case event, ok := <-events:
			if !ok {
				w.cancel()
				<-workerDone
				return
			}
			if event.FullRescan {
				fullRescan = true
				pending = make(map[string]struct{})
			} else if path := filepath.Clean(event.Path); path != "." && path != "" {
				if !fullRescan {
					pending[path] = struct{}{}
					if len(pending) > maxPendingWatcherPaths {
						fullRescan = true
						pending = make(map[string]struct{})
					}
				}
			}
			schedule()
		case err, ok := <-errors:
			if !ok {
				errors = nil
				continue
			}
			if err != nil {
				w.service.setWatcherError(err)
				w.logger.Warn("filesystem watcher error", "error", err)
				fullRescan = true
				pending = make(map[string]struct{})
				schedule()
			}
		case <-timerC:
			dispatch()
		case <-ctx.Done():
			stopTimer()
			<-workerDone
			return
		}
	}
}

// Deleted files must be reconciled by scanning their parent directory. When a
// batch removes many siblings, normalize them before dispatch so one directory
// scan replaces one scan per removed path. Existing paths stay file-granular.
func (w *watchRuntime) coalesceDeletedWatchPaths(paths []string) []string {
	w.service.mu.RLock()
	var roots []mediapath.Root
	if w.service.roots != nil {
		roots = w.service.roots.All()
	}
	w.service.mu.RUnlock()
	return coalesceDeletedWatchPaths(paths, func(path string) bool {
		if len(roots) == 0 {
			return false
		}
		root, ok := rootForWatchPath(roots, path)
		return ok && hiddenWatchPath(root.Path, path)
	})
}

func coalesceDeletedWatchPaths(
	paths []string,
	isHidden func(string) bool,
) []string {
	coalesced := make([]string, 0, len(paths))
	for _, path := range paths {
		if !isHidden(path) {
			if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
				path = filepath.Dir(path)
			}
		}
		coalesced = append(coalesced, path)
	}
	sort.Strings(coalesced)
	return coalesced
}

func watchPathContainsHiddenComponent(path string) bool {
	for _, part := range strings.Split(filepath.ToSlash(filepath.Clean(path)), "/") {
		if strings.HasPrefix(part, ".") && part != "." && part != ".." {
			return true
		}
	}
	return false
}

func compactWatchPaths(paths []string) []string {
	compacted := paths[:0]
	kept := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		if _, exists := kept[path]; exists || hasCompactedAncestor(path, kept) {
			continue
		}
		compacted = append(compacted, path)
		kept[path] = struct{}{}
	}
	return compacted
}

func hasCompactedAncestor(path string, kept map[string]struct{}) bool {
	for parent := filepath.Dir(path); ; parent = filepath.Dir(parent) {
		if _, exists := kept[parent]; exists {
			return true
		}
		if parent == filepath.Dir(parent) {
			return false
		}
	}
}

func cloneWatcherStatus(status WatcherStatus) WatcherStatus {
	status.Roots = append([]WatcherRootStatus(nil), status.Roots...)
	return status
}

func watcherBackendName(statuses []WatcherRootStatus) string {
	for _, status := range statuses {
		if status.Enabled && status.Backend != "" {
			return status.Backend
		}
	}
	return ""
}

func watcherEnabled(statuses []WatcherRootStatus) bool {
	for _, status := range statuses {
		if status.Enabled {
			return true
		}
	}
	return false
}

func hiddenWatchPath(rootPath, path string) bool {
	relative, err := filepath.Rel(rootPath, path)
	if err != nil || relative == "." {
		return false
	}
	return watchPathContainsHiddenComponent(relative)
}
