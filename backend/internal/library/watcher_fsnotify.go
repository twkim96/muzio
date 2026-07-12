//go:build (linux || windows) && !android

package library

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/fsnotify/fsnotify"
)

const maxRecursiveWatches = 4096

var errWatchDirectoryLimit = errors.New("watch directory limit reached; manual refresh retained")

type fsnotifyBackend struct {
	watcher *fsnotify.Watcher
	events  chan watchEvent
	errors  chan error
	stop    chan struct{}
	done    chan struct{}
	once    sync.Once
	mu      sync.Mutex
	watches map[string]struct{}
	roots   map[string]struct{}
	limit   int
}

func newPlatformWatcher(paths []string) (watchBackend, []WatcherRootStatus, error) {
	statuses := make([]WatcherRootStatus, 0, len(paths))
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, statuses, err
	}
	backend := &fsnotifyBackend{
		watcher: watcher,
		events:  make(chan watchEvent, 512),
		errors:  make(chan error, 16),
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
		watches: make(map[string]struct{}),
		roots:   make(map[string]struct{}),
		limit:   maxRecursiveWatches,
	}
	for _, path := range paths {
		_, local, reason := localWatchPath(path)
		status := WatcherRootStatus{Path: path, Backend: "fsnotify"}
		if !local {
			status.Reason = reason
			statuses = append(statuses, status)
			continue
		}
		if err := backend.addTree(path); err != nil {
			status.Reason = err.Error()
			statuses = append(statuses, status)
			continue
		}
		status.Enabled = true
		backend.roots[filepath.Clean(path)] = struct{}{}
		statuses = append(statuses, status)
	}
	if len(backend.watches) == 0 {
		watcher.Close()
		return nil, statuses, nil
	}
	go backend.run()
	return backend, statuses, nil
}

func (b *fsnotifyBackend) Events() <-chan watchEvent { return b.events }
func (b *fsnotifyBackend) Errors() <-chan error      { return b.errors }

func (b *fsnotifyBackend) Close() error {
	var err error
	b.once.Do(func() {
		close(b.stop)
		err = b.watcher.Close()
		<-b.done
	})
	return err
}

func (b *fsnotifyBackend) run() {
	defer close(b.done)
	defer close(b.events)
	defer close(b.errors)
	for {
		select {
		case event, ok := <-b.watcher.Events:
			if !ok {
				return
			}
			if event.Op == fsnotify.Chmod {
				continue
			}
			if event.Op&fsnotify.Create != 0 {
				if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
					if err := b.addTree(event.Name); err != nil {
						if errors.Is(err, errWatchDirectoryLimit) {
							if root := b.disableRootForPath(event.Name); root != "" {
								err = &watchRootDisabledError{Path: root, Err: err}
							}
						}
						select {
						case b.errors <- err:
						default:
						}
					}
				}
			}
			if event.Op&(fsnotify.Remove|fsnotify.Rename) != 0 {
				if b.isRoot(event.Name) {
					err := errors.New("watched root moved or removed; manual refresh required")
					root := b.disableRootForPath(event.Name)
					if root != "" {
						err = &watchRootDisabledError{Path: root, Err: err}
					}
					select {
					case b.errors <- err:
					default:
					}
				} else {
					b.removeTree(event.Name)
				}
			}
			select {
			case b.events <- watchEvent{Path: event.Name}:
			case <-b.stop:
				return
			}
		case err, ok := <-b.watcher.Errors:
			if !ok {
				return
			}
			select {
			case b.errors <- err:
			default:
			}
		case <-b.stop:
			return
		}
	}
}

func (b *fsnotifyBackend) addTree(root string) error {
	var added []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			return nil
		}
		if path != root && shouldSkipDir(entry.Name()) {
			return filepath.SkipDir
		}
		b.mu.Lock()
		defer b.mu.Unlock()
		if _, exists := b.watches[path]; exists {
			return nil
		}
		if len(b.watches) >= b.limit {
			return errWatchDirectoryLimit
		}
		if err := b.watcher.Add(path); err != nil {
			return err
		}
		b.watches[path] = struct{}{}
		added = append(added, path)
		return nil
	})
	if err == nil {
		return nil
	}
	b.mu.Lock()
	for index := len(added) - 1; index >= 0; index-- {
		path := added[index]
		_ = b.watcher.Remove(path)
		delete(b.watches, path)
	}
	b.mu.Unlock()
	return err
}

func (b *fsnotifyBackend) removeTree(root string) {
	root = filepath.Clean(root)
	prefix := root + string(filepath.Separator)
	b.mu.Lock()
	defer b.mu.Unlock()
	for path := range b.watches {
		if path != root && !strings.HasPrefix(path, prefix) {
			continue
		}
		_ = b.watcher.Remove(path)
		delete(b.watches, path)
	}
}

func (b *fsnotifyBackend) isRoot(path string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, ok := b.roots[filepath.Clean(path)]
	return ok
}

func (b *fsnotifyBackend) disableRootForPath(path string) string {
	path = filepath.Clean(path)
	b.mu.Lock()
	var selected string
	for root := range b.roots {
		if pathWithinRoot(root, path) && len(root) > len(selected) {
			selected = root
		}
	}
	if selected != "" {
		delete(b.roots, selected)
	}
	b.mu.Unlock()
	if selected != "" {
		b.removeTree(selected)
	}
	return selected
}
