package mediapath

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestNewRootsNormalizesPaths(t *testing.T) {
	dir := t.TempDir()
	roots, err := NewRoots([]string{filepath.Join(dir, "a", "..", "b")})
	if err != nil {
		t.Fatalf("NewRoots returned error: %v", err)
	}
	all := roots.All()
	if len(all) != 1 {
		t.Fatalf("len(All()) = %d, want 1", len(all))
	}
	want := filepath.Join(dir, "b")
	if all[0].Path != want {
		t.Fatalf("Path = %q, want %q", all[0].Path, want)
	}
	if !strings.HasPrefix(all[0].Name, "b-") {
		t.Fatalf("Name = %q, want prefix %q", all[0].Name, "b-")
	}
}

func TestNewRootsSkipsBlankAndDeduplicates(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "movies")
	roots, err := NewRoots([]string{
		"",
		"   ",
		target,
		filepath.Join(dir, ".", "movies"),
	})
	if err != nil {
		t.Fatalf("NewRoots returned error: %v", err)
	}
	all := roots.All()
	if len(all) != 1 {
		t.Fatalf("len(All()) = %d, want 1 (after dedupe)", len(all))
	}
	if all[0].Path != target {
		t.Fatalf("Path = %q, want %q", all[0].Path, target)
	}
}

func TestNewRootsAssignsDistinctNamesForSharedBasename(t *testing.T) {
	dirA := t.TempDir()
	dirB := t.TempDir()
	rootA := filepath.Join(dirA, "media")
	rootB := filepath.Join(dirB, "media")

	roots, err := NewRoots([]string{rootA, rootB})
	if err != nil {
		t.Fatalf("NewRoots returned error: %v", err)
	}
	all := roots.All()
	if len(all) != 2 {
		t.Fatalf("len(All()) = %d, want 2", len(all))
	}
	if all[0].Name == all[1].Name {
		t.Fatalf("expected distinct names for distinct paths, got %q twice", all[0].Name)
	}
	for _, r := range all {
		if !strings.HasPrefix(r.Name, "media-") {
			t.Errorf("Name = %q, want prefix %q", r.Name, "media-")
		}
		if got, ok := roots.ByName(r.Name); !ok || got.Path != r.Path {
			t.Errorf("ByName(%q) ok=%v path=%q, want hit with %q", r.Name, ok, got.Path, r.Path)
		}
	}
	if _, ok := roots.ByName("missing"); ok {
		t.Fatal("ByName(missing) returned ok, want not found")
	}
}

// Names must be derived from the absolute path, not registration order, so
// reordering VMA_MEDIA_ROOTS does not silently rewrite every media ID derived
// from (rootName, relPath). This is a hard contract for offline downloads and
// progress sync in later phases.
func TestRootNameIsIndependentOfRegistrationOrder(t *testing.T) {
	dirA := t.TempDir()
	dirB := t.TempDir()
	rootA := filepath.Join(dirA, "media")
	rootB := filepath.Join(dirB, "media")

	forward, err := NewRoots([]string{rootA, rootB})
	if err != nil {
		t.Fatalf("NewRoots forward: %v", err)
	}
	reversed, err := NewRoots([]string{rootB, rootA})
	if err != nil {
		t.Fatalf("NewRoots reversed: %v", err)
	}

	nameByPath := func(rs *Roots) map[string]string {
		out := make(map[string]string)
		for _, r := range rs.All() {
			out[r.Path] = r.Name
		}
		return out
	}

	got := nameByPath(forward)
	want := nameByPath(reversed)
	for path, name := range want {
		if got[path] != name {
			t.Fatalf("name for %q changed across orderings: %q vs %q", path, got[path], name)
		}
	}
}

func TestNewRootsHandlesEmptyList(t *testing.T) {
	roots, err := NewRoots(nil)
	if err != nil {
		t.Fatalf("NewRoots returned error: %v", err)
	}
	if len(roots.All()) != 0 {
		t.Fatalf("All() not empty: %v", roots.All())
	}
}
