//go:build darwin && cgo

package library

import (
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/fsnotify/fsevents"
)

type fseventsBackend struct {
	stream *fsevents.EventStream
	events chan watchEvent
	errors chan error
	stop   chan struct{}
	done   chan struct{}
	once   sync.Once
	roots  []watchPathMapping
}

type watchPathMapping struct {
	configured string
	real       string
}

func newPlatformWatcher(paths []string) (watchBackend, []WatcherRootStatus, error) {
	statuses := make([]WatcherRootStatus, 0, len(paths))
	mappings := make([]watchPathMapping, 0, len(paths))
	watchedPaths := make([]string, 0, len(paths))
	seen := make(map[string]struct{})
	for _, path := range paths {
		realPath, local, reason := localWatchPath(path)
		status := WatcherRootStatus{Path: path, Backend: "fsevents"}
		if !local {
			status.Reason = reason
			statuses = append(statuses, status)
			continue
		}
		status.Enabled = true
		statuses = append(statuses, status)
		mappings = append(mappings, watchPathMapping{
			configured: filepath.Clean(path),
			real:       realPath,
		})
		if _, ok := seen[realPath]; !ok {
			seen[realPath] = struct{}{}
			watchedPaths = append(watchedPaths, realPath)
		}
	}
	if len(watchedPaths) == 0 {
		return nil, statuses, nil
	}

	streamEvents := make(chan []fsevents.Event, 128)
	stream := &fsevents.EventStream{
		Events:  streamEvents,
		Paths:   watchedPaths,
		Latency: 500 * time.Millisecond,
		Flags:   fsevents.WatchRoot,
	}
	if err := startFSEventStream(stream); err != nil {
		return nil, statuses, err
	}
	backend := &fseventsBackend{
		stream: stream,
		events: make(chan watchEvent, 512),
		errors: make(chan error, 1),
		stop:   make(chan struct{}),
		done:   make(chan struct{}),
		roots:  mappings,
	}
	go backend.run(streamEvents)
	return backend, statuses, nil
}

func startFSEventStream(stream *fsevents.EventStream) error {
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		if err = stream.Start(); err == nil {
			return nil
		}
		if attempt == 0 {
			time.Sleep(50 * time.Millisecond)
		}
	}
	return fmt.Errorf("start FSEvents stream after retry: %w", err)
}

func (b *fseventsBackend) Events() <-chan watchEvent { return b.events }
func (b *fseventsBackend) Errors() <-chan error      { return b.errors }

func (b *fseventsBackend) Close() error {
	b.once.Do(func() {
		close(b.stop)
		b.stream.Stop()
		<-b.done
	})
	return nil
}

func (b *fseventsBackend) run(source <-chan []fsevents.Event) {
	defer close(b.done)
	defer close(b.events)
	defer close(b.errors)
	for {
		select {
		case batch, ok := <-source:
			if !ok {
				return
			}
			for _, event := range batch {
				if event.Flags&fsevents.HistoryDone != 0 {
					continue
				}
				full := event.Flags&(fsevents.MustScanSubDirs|
					fsevents.RootChanged|
					fsevents.EventIDsWrapped|
					fsevents.Mount|
					fsevents.Unmount) != 0
				path := b.configuredPath(event.Path)
				select {
				case b.events <- watchEvent{Path: path, FullRescan: full}:
				case <-b.stop:
					return
				}
			}
		case <-b.stop:
			return
		}
	}
}

func (b *fseventsBackend) configuredPath(path string) string {
	path = filepath.Clean(path)
	var selected *watchPathMapping
	for _, root := range b.roots {
		if path != root.real && !strings.HasPrefix(path, root.real+string(filepath.Separator)) {
			continue
		}
		if selected != nil && len(root.real) <= len(selected.real) {
			continue
		}
		copy := root
		selected = &copy
	}
	if selected == nil {
		return path
	}
	relative, err := filepath.Rel(selected.real, path)
	if err != nil || relative == "." {
		return selected.configured
	}
	return filepath.Join(selected.configured, relative)
}

func localWatchPath(path string) (string, bool, string) {
	realPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", false, "root unavailable"
	}
	var stat syscallStatfs
	if err := stat.load(realPath); err != nil {
		return "", false, "filesystem type unavailable"
	}
	if !stat.local() {
		return "", false, "network filesystem uses manual refresh"
	}
	return filepath.Clean(realPath), true, ""
}

type syscallStatfs struct {
	flags uint32
}

func (s *syscallStatfs) load(path string) error {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return err
	}
	s.flags = stat.Flags
	return nil
}

func (s syscallStatfs) local() bool {
	const mntLocal = 0x00001000
	return s.flags&mntLocal != 0
}
