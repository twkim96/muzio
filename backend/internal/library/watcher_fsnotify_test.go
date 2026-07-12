//go:build (linux || windows) && !android

package library

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/fsnotify/fsnotify"
)

func TestFSNotifyDisablesRootAfterWatchLimit(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "first")
	second := filepath.Join(root, "second")
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatal(err)
	}
	defer watcher.Close()
	backend := &fsnotifyBackend{
		watcher: watcher,
		watches: make(map[string]struct{}),
		roots:   make(map[string]struct{}),
		limit:   2,
	}
	if err := backend.addTree(root); err != nil {
		t.Fatal(err)
	}
	backend.roots[root] = struct{}{}
	if err := os.Mkdir(first, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := backend.addTree(first); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(second, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := backend.addTree(second); !errors.Is(err, errWatchDirectoryLimit) {
		t.Fatalf("addTree error = %v", err)
	}
	if disabled := backend.disableRootForPath(second); disabled != root {
		t.Fatalf("disabled root = %q, want %q", disabled, root)
	}
	if len(backend.roots) != 0 || len(backend.watches) != 0 {
		t.Fatalf("root remained enabled: roots=%v watches=%v", backend.roots, backend.watches)
	}
}
