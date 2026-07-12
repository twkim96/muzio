//go:build darwin && cgo

package library

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFSEventsWatcherUpdatesSnapshotWithoutManualRefresh(t *testing.T) {
	rootPath := t.TempDir()
	service, err := NewPersistentService(
		MediaRootSettings{AudioRoots: []string{rootPath}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
		filepath.Join(t.TempDir(), "library-index.v1.log"),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	status := service.StartWatcher()
	if !status.Enabled || status.Backend != "fsevents" {
		t.Skipf("FSEvents unavailable: %#v", status)
	}

	albumPath := filepath.Join(rootPath, "album")
	if err := os.Mkdir(albumPath, 0o700); err != nil {
		t.Fatal(err)
	}
	mediaPath := filepath.Join(albumPath, "live.mp3")
	if err := os.WriteFile(mediaPath, []byte("live"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitForWatcher(t, 5*time.Second, func() bool {
		return len(service.List(MediaTypeAudio)) == 1
	})
	item := service.List(MediaTypeAudio)[0]

	if err := os.WriteFile(mediaPath, []byte("updated"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitForWatcher(t, 5*time.Second, func() bool {
		updated, err := service.Get(item.ID)
		return err == nil && updated.SizeBytes == 7
	})

	renamedPath := filepath.Join(albumPath, "renamed.mp3")
	if err := os.Rename(mediaPath, renamedPath); err != nil {
		t.Fatal(err)
	}
	waitForWatcher(t, 5*time.Second, func() bool {
		items := service.List(MediaTypeAudio)
		return len(items) == 1 && items[0].RelativePath == "album/renamed.mp3"
	})
	renamed := service.List(MediaTypeAudio)[0]

	nestedPath := filepath.Join(albumPath, "disc-two")
	if err := os.Mkdir(nestedPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(nestedPath, "nested.mp3"),
		[]byte("nested"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	waitForWatcher(t, 5*time.Second, func() bool {
		return len(service.List(MediaTypeAudio)) == 2
	})

	if err := os.Remove(renamedPath); err != nil {
		t.Fatal(err)
	}
	waitForWatcher(t, 5*time.Second, func() bool {
		_, err := service.Get(renamed.ID)
		return err == ErrNotFound
	})
}

func TestFSEventsWatcherRestartsWhenMediaRootsChange(t *testing.T) {
	oldRoot := t.TempDir()
	newRoot := t.TempDir()
	service, err := NewPersistentService(
		MediaRootSettings{AudioRoots: []string{oldRoot}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
		filepath.Join(t.TempDir(), "library-index.v1.log"),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	status := service.StartWatcher()
	if !status.Enabled || status.Backend != "fsevents" {
		t.Skipf("FSEvents unavailable: %#v", status)
	}

	if _, err := service.UpdateMediaRoots(
		MediaRootSettings{AudioRoots: []string{newRoot}},
	); err != nil {
		t.Fatal(err)
	}
	status = service.WatcherStatus()
	if !status.Enabled || len(status.Roots) != 1 || status.Roots[0].Path != newRoot {
		t.Fatalf("watcher status after root update = %#v", status)
	}

	if err := os.WriteFile(
		filepath.Join(oldRoot, "obsolete.mp3"),
		[]byte("old"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(newRoot, "current.mp3"),
		[]byte("new"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	waitForWatcher(t, 5*time.Second, func() bool {
		items := service.List(MediaTypeAudio)
		return len(items) == 1 && items[0].RelativePath == "current.mp3"
	})
	time.Sleep(750 * time.Millisecond)
	items := service.List(MediaTypeAudio)
	if len(items) != 1 || items[0].RelativePath != "current.mp3" {
		t.Fatalf("obsolete root event changed snapshot: %#v", items)
	}
}

func waitForWatcher(t *testing.T, timeout time.Duration, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("watcher update timed out")
}
