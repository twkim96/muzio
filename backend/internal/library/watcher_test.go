package library

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestServiceReconcilesWatcherSubtreeIncrementally(t *testing.T) {
	rootPath := t.TempDir()
	service, err := NewService(
		MediaRootSettings{AudioRoots: []string{rootPath}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()

	dir := filepath.Join(rootPath, "album")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	mediaPath := filepath.Join(dir, "Artist - Song.mp3")
	if err := os.WriteFile(mediaPath, []byte("one"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := service.reconcileWatchPath(context.Background(), dir); err != nil {
		t.Fatal(err)
	}
	root := service.roots.All()[0]
	item, err := service.GetByPath(root.Name, "album/Artist - Song.mp3")
	if err != nil || item.SizeBytes != 3 {
		t.Fatalf("created item = %#v, %v", item, err)
	}

	if err := os.WriteFile(mediaPath, []byte("longer"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(dir, "Artist - Song.en.srt"),
		[]byte("subtitle"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if err := service.reconcileWatchPath(context.Background(), dir); err != nil {
		t.Fatal(err)
	}
	item, err = service.Get(item.ID)
	if err != nil || item.SizeBytes != 6 || len(item.Subtitles) != 1 {
		t.Fatalf("updated item = %#v, %v", item, err)
	}

	if err := os.Remove(mediaPath); err != nil {
		t.Fatal(err)
	}
	if err := service.reconcileWatchPath(context.Background(), dir); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Get(item.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted item error = %v", err)
	}
}

func TestServiceWatcherUsesSingleFilePathForExistingMedia(t *testing.T) {
	rootPath := t.TempDir()
	firstPath := filepath.Join(rootPath, "first.mp3")
	secondPath := filepath.Join(rootPath, "second.mp3")
	if err := os.WriteFile(firstPath, []byte("one"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(secondPath, []byte("two"), 0o600); err != nil {
		t.Fatal(err)
	}
	service, err := NewService(
		MediaRootSettings{AudioRoots: []string{rootPath}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	root := service.roots.All()[0]
	second, err := service.GetByPath(root.Name, "second.mp3")
	if err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(firstPath, []byte("longer"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(secondPath); err != nil {
		t.Fatal(err)
	}
	if err := service.reconcileWatchPath(context.Background(), firstPath); err != nil {
		t.Fatal(err)
	}
	first, err := service.GetByPath(root.Name, "first.mp3")
	if err != nil || first.SizeBytes != 6 {
		t.Fatalf("first item = %#v, error = %v", first, err)
	}
	if _, err := service.Get(second.ID); err != nil {
		t.Fatalf("single-file reconciliation scanned sibling deletion: %v", err)
	}

	if err := service.reconcileWatchPath(context.Background(), secondPath); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Get(second.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted sibling error = %v", err)
	}
}

func TestServiceWatcherRejectsMediaReplacedBySymlink(t *testing.T) {
	rootPath := t.TempDir()
	mediaPath := filepath.Join(rootPath, "song.mp3")
	if err := os.WriteFile(mediaPath, []byte("song"), 0o600); err != nil {
		t.Fatal(err)
	}
	service, err := NewService(
		MediaRootSettings{AudioRoots: []string{rootPath}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	item := service.List(MediaTypeAudio)[0]

	outsidePath := filepath.Join(t.TempDir(), "outside.mp3")
	if err := os.WriteFile(outsidePath, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(mediaPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsidePath, mediaPath); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if err := service.reconcileWatchPath(context.Background(), mediaPath); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Get(item.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("symlinked item error = %v", err)
	}
}

func TestServiceWatcherPreservesReadyThumbnailForUnchangedVideo(t *testing.T) {
	rootPath := t.TempDir()
	mediaPath := filepath.Join(rootPath, "clip.mp4")
	if err := os.WriteFile(mediaPath, []byte("video"), 0o600); err != nil {
		t.Fatal(err)
	}
	service, err := NewService(
		MediaRootSettings{VideoRoots: []string{rootPath}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()

	item := service.List(MediaTypeVideo)[0]
	service.UpdateThumbnailStatus(
		item.ID,
		item.Thumbnail.CacheKey,
		ThumbnailStatusReady,
	)
	revision := service.Revision()
	if err := service.reconcileWatchPath(context.Background(), rootPath); err != nil {
		t.Fatal(err)
	}
	if got := service.Revision(); got != revision {
		t.Fatalf("revision = %d, want %d", got, revision)
	}
	updated, err := service.Get(item.ID)
	if err != nil || updated.Thumbnail.Status != ThumbnailStatusReady {
		t.Fatalf("item = %#v, error = %v", updated, err)
	}
}

func TestServiceWatcherPreservesUnavailableRoot(t *testing.T) {
	rootPath := t.TempDir()
	mediaPath := filepath.Join(rootPath, "song.mp3")
	if err := os.WriteFile(mediaPath, []byte("song"), 0o600); err != nil {
		t.Fatal(err)
	}
	service, err := NewService(
		MediaRootSettings{AudioRoots: []string{rootPath}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	item := service.List(MediaTypeAudio)[0]
	if err := os.RemoveAll(rootPath); err != nil {
		t.Fatal(err)
	}

	if err := service.reconcileWatchPath(context.Background(), rootPath); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Get(item.ID); err != nil {
		t.Fatalf("unavailable root removed cached item: %v", err)
	}
}

func TestServiceWatcherRetriesAfterSnapshotReplacement(t *testing.T) {
	rootPath := t.TempDir()
	service, err := NewService(
		MediaRootSettings{AudioRoots: []string{rootPath}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()

	mediaPath := filepath.Join(rootPath, "song.mp3")
	if err := os.WriteFile(mediaPath, []byte("song"), 0o600); err != nil {
		t.Fatal(err)
	}
	endStream := service.BeginMediaStream()
	reconciled := make(chan error, 1)
	go func() {
		reconciled <- service.reconcileWatchPath(context.Background(), rootPath)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for service.scans.workerMu.TryLock() {
		service.scans.workerMu.Unlock()
		if time.Now().After(deadline) {
			t.Fatal("watch reconciliation did not start scanning")
		}
		time.Sleep(time.Millisecond)
	}

	service.mu.Lock()
	service.snapshot = newSnapshotAtRevision(nil, service.snapshot.Revision())
	service.mu.Unlock()
	endStream()

	select {
	case err := <-reconciled:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("watch reconciliation did not finish")
	}
	if got := service.List(MediaTypeAudio); len(got) != 1 {
		t.Fatalf("items after snapshot replacement = %#v", got)
	}
}

func TestWatchRuntimeCoalescesDuplicateDirectoryEvents(t *testing.T) {
	rootPath := t.TempDir()
	service, err := NewService(
		MediaRootSettings{AudioRoots: []string{rootPath}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	backend := newFakeWatchBackend()
	runtime := newWatchRuntime(service, service.logger, backend)
	if err := os.WriteFile(filepath.Join(rootPath, "song.mp3"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 20; index++ {
		backend.events <- watchEvent{Path: rootPath}
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(service.List(MediaTypeAudio)) != 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := service.List(MediaTypeAudio); len(got) != 1 {
		t.Fatalf("items = %#v", got)
	}
	if revision := service.Revision(); revision != 1 {
		t.Fatalf("revision = %d, want one coalesced update", revision)
	}
	if err := runtime.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestCompactWatchPathsDropsDescendants(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "music")
	paths := []string{
		root,
		filepath.Join(root, "album"),
		filepath.Join(root, "album", "disc"),
		filepath.Join(string(filepath.Separator), "video"),
	}
	got := compactWatchPaths(paths)
	want := []string{root, filepath.Join(string(filepath.Separator), "video")}
	if len(got) != len(want) {
		t.Fatalf("paths = %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("paths = %#v, want %#v", got, want)
		}
	}
}

func TestCoalesceDeletedWatchPathsCombinesSiblingDeletes(t *testing.T) {
	directory := t.TempDir()
	deleted := []string{
		filepath.Join(directory, "first.mp3"),
		filepath.Join(directory, "second.mp3"),
	}

	got := coalesceDeletedWatchPaths(deleted, func(string) bool { return false })
	if len(got) != 2 || got[0] != directory || got[1] != directory {
		t.Fatalf("paths = %#v, want duplicate parent directory", got)
	}
	got = compactWatchPaths(got)
	if len(got) != 1 || got[0] != directory {
		t.Fatalf("compacted paths = %#v, want one parent directory", got)
	}
}

func TestCoalesceDeletedWatchPathsPreservesHiddenDeletes(t *testing.T) {
	directory := t.TempDir()
	hidden := filepath.Join(directory, ".hidden.mp3")

	got := coalesceDeletedWatchPaths([]string{hidden}, func(path string) bool {
		return hiddenWatchPath(directory, path)
	})
	if len(got) != 1 || got[0] != hidden {
		t.Fatalf("paths = %#v, want hidden file path", got)
	}
}

func TestCoalesceDeletedWatchPathsCoalescesWhenRootHasHiddenParent(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, ".media")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	deleted := []string{
		filepath.Join(root, "first.mp3"),
		filepath.Join(root, "second.mp3"),
	}

	got := coalesceDeletedWatchPaths(deleted, func(path string) bool {
		return hiddenWatchPath(root, path)
	})
	got = compactWatchPaths(got)
	if len(got) != 1 || got[0] != root {
		t.Fatalf("paths = %#v, want one root directory", got)
	}
}

func TestCompactWatchPathsDropsNestedPathAfterSibling(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "root")
	paths := []string{
		filepath.Join(root, "dir"),
		filepath.Join(root, "dir-other"),
		filepath.Join(root, "dir", "sub"),
	}
	got := compactWatchPaths(paths)
	want := []string{filepath.Join(root, "dir"), filepath.Join(root, "dir-other")}
	if len(got) != len(want) {
		t.Fatalf("paths = %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("paths = %#v, want %#v", got, want)
		}
	}
}

func TestServiceWatcherStatusDisablesReportedRoot(t *testing.T) {
	rootPath := t.TempDir()
	service := &Service{}
	service.watcher.state = WatcherStatus{
		Enabled: true,
		Backend: "fsnotify",
		Roots: []WatcherRootStatus{
			{Path: rootPath, Enabled: true, Backend: "fsnotify"},
		},
	}
	limitErr := errors.New("watch directory limit reached; manual refresh retained")
	service.setWatcherError(&watchRootDisabledError{Path: rootPath, Err: limitErr})

	status := service.WatcherStatus()
	if status.Enabled || status.Backend != "" {
		t.Fatalf("watcher status = %#v", status)
	}
	if status.Roots[0].Enabled || status.Roots[0].Reason != limitErr.Error() {
		t.Fatalf("root status = %#v", status.Roots[0])
	}
}

type fakeWatchBackend struct {
	events chan watchEvent
	errors chan error
}

func newFakeWatchBackend() *fakeWatchBackend {
	return &fakeWatchBackend{
		events: make(chan watchEvent, 64),
		errors: make(chan error, 1),
	}
}

func (f *fakeWatchBackend) Events() <-chan watchEvent { return f.events }
func (f *fakeWatchBackend) Errors() <-chan error      { return f.errors }
func (f *fakeWatchBackend) Close() error              { return nil }
