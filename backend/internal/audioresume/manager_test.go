package audioresume

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"muzio/backend/internal/library"
)

type mapResolver map[string]string

func (r mapResolver) ResolveStrict(_ string, relativePath string) (string, error) {
	return r[relativePath], nil
}

type blockingCopyRemuxer struct {
	blockName string
	started   chan string
	release   chan struct{}
}

func (r *blockingCopyRemuxer) Remux(ctx context.Context, source, output string) error {
	r.started <- filepath.Base(source)
	if filepath.Base(source) == r.blockName {
		select {
		case <-r.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	return os.WriteFile(output, append([]byte("m4a:"), data...), 0o600)
}

func TestManagerReplacesTheSingleReadyEntryOnlyAfterNewRemuxCompletes(t *testing.T) {
	root := t.TempDir()
	cacheDir := filepath.Join(root, "cache")
	firstPath := filepath.Join(root, "first.aac")
	secondPath := filepath.Join(root, "second.aac")
	if err := os.WriteFile(firstPath, []byte("first"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(secondPath, []byte("second"), 0o600); err != nil {
		t.Fatal(err)
	}
	remuxer := &blockingCopyRemuxer{
		blockName: "second.aac",
		started:   make(chan string, 2),
		release:   make(chan struct{}),
	}
	manager, err := NewManager(Options{
		CacheDir: cacheDir,
		Resolver: mapResolver{"first.aac": firstPath, "second.aac": secondPath},
		Remuxer:  remuxer,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()

	first := mediaForFile(t, "first", "first.aac", firstPath)
	second := mediaForFile(t, "second", "second.aac", secondPath)
	if _, err := manager.Request(first); err != nil {
		t.Fatal(err)
	}
	<-remuxer.started
	waitForStatus(t, manager, func(status Status) bool {
		return status.State == "ready" && status.MediaID == first.ID
	})
	firstCache, ready := manager.Ready(first)
	if !ready {
		t.Fatal("first cache was not ready")
	}

	if _, err := manager.Request(second); err != nil {
		t.Fatal(err)
	}
	<-remuxer.started
	status := manager.Status()
	if status.MediaID != first.ID || status.BuildingMediaID != second.ID {
		t.Fatalf("status while replacing = %#v", status)
	}
	if _, ready := manager.Ready(first); !ready {
		t.Fatal("previous cache disappeared before replacement completed")
	}

	close(remuxer.release)
	waitForStatus(t, manager, func(status Status) bool {
		return status.State == "ready" && status.MediaID == second.ID && status.BuildingMediaID == ""
	})
	if _, ready := manager.Ready(second); !ready {
		t.Fatal("second cache was not ready")
	}
	if _, err := os.Stat(firstCache); !os.IsNotExist(err) {
		t.Fatalf("previous cache still exists: %v", err)
	}
}

func TestManagerRejectsNonAACWithoutReplacingCurrentState(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "song.mp3")
	if err := os.WriteFile(path, []byte("mp3"), 0o600); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(Options{
		CacheDir: filepath.Join(root, "cache"),
		Resolver: mapResolver{"song.mp3": path},
		Remuxer: &blockingCopyRemuxer{
			started: make(chan string, 1),
			release: make(chan struct{}),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	item := mediaForFile(t, "mp3", "song.mp3", path)
	if _, err := manager.Request(item); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Request error = %v, want ErrUnsupported", err)
	}
	if status := manager.Status(); status.State != "empty" {
		t.Fatalf("status = %#v", status)
	}
}

func TestNewManagerRecoversPreviousEntryFromBackup(t *testing.T) {
	root := t.TempDir()
	cacheDir := filepath.Join(root, "cache")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		t.Fatal(err)
	}
	sourcePath := filepath.Join(root, "song.aac")
	if err := os.WriteFile(sourcePath, []byte("source"), 0o600); err != nil {
		t.Fatal(err)
	}
	item := mediaForFile(t, "song", "song.aac", sourcePath)
	cacheName := "audio-existing.m4a"
	if err := os.WriteFile(filepath.Join(cacheDir, cacheName), []byte("cached"), 0o600); err != nil {
		t.Fatal(err)
	}
	entryData, err := json.Marshal(cacheEntry{
		MediaID:       item.ID,
		SourceSize:    item.SizeBytes,
		SourceModTime: item.ModifiedAt,
		FileName:      cacheName,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cacheDir, stateBackupFileName), entryData, 0o600); err != nil {
		t.Fatal(err)
	}

	manager, err := NewManager(Options{
		CacheDir: cacheDir,
		Resolver: mapResolver{"song.aac": sourcePath},
		Remuxer:  &blockingCopyRemuxer{started: make(chan string, 1), release: make(chan struct{})},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	if _, ready := manager.Ready(item); !ready {
		t.Fatal("backup entry was not restored")
	}
	if _, err := os.Stat(filepath.Join(cacheDir, stateFileName)); err != nil {
		t.Fatalf("restored state file: %v", err)
	}
}

func mediaForFile(t *testing.T, id, name, path string) library.Media {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return library.Media{
		ID:           id,
		Type:         library.MediaTypeAudio,
		RootName:     "root",
		RelativePath: name,
		Name:         name,
		MIMEType:     "audio/aac",
		SizeBytes:    info.Size(),
		ModifiedAt:   info.ModTime(),
	}
}

func waitForStatus(t *testing.T, manager *Manager, predicate func(Status) bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if predicate(manager.Status()) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("status did not converge: %#v", manager.Status())
}
