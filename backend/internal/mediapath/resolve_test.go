package mediapath

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestResolveAcceptsValidRelativePath(t *testing.T) {
	dir := t.TempDir()
	roots, err := NewRoots([]string{dir})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}
	root := roots.All()[0]

	got, err := roots.Resolve(root.Name, "movies/Inception.mkv")
	if err != nil {
		t.Fatalf("Resolve returned error: %v", err)
	}
	want := filepath.Join(root.Path, "movies", "Inception.mkv")
	if got != want {
		t.Fatalf("Resolve = %q, want %q", got, want)
	}
}

func TestResolveAcceptsEmptyRelativePathAsRoot(t *testing.T) {
	dir := t.TempDir()
	roots, err := NewRoots([]string{dir})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}
	root := roots.All()[0]

	got, err := roots.Resolve(root.Name, "")
	if err != nil {
		t.Fatalf("Resolve returned error: %v", err)
	}
	if got != root.Path {
		t.Fatalf("Resolve = %q, want %q", got, root.Path)
	}
}

func TestResolveRejectsTraversal(t *testing.T) {
	dir := t.TempDir()
	roots, err := NewRoots([]string{filepath.Join(dir, "media")})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}
	root := roots.All()[0]

	cases := []string{
		"../etc/passwd",
		"movies/../../escape.txt",
		"./../escape.txt",
	}
	for _, rel := range cases {
		_, err := roots.Resolve(root.Name, rel)
		if !errors.Is(err, ErrUnsafePath) {
			t.Errorf("Resolve(%q) err = %v, want ErrUnsafePath", rel, err)
		}
	}
}

func TestResolveRejectsAbsolutePath(t *testing.T) {
	dir := t.TempDir()
	roots, err := NewRoots([]string{dir})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}
	root := roots.All()[0]

	_, err = roots.Resolve(root.Name, filepath.Join(dir, "absolute.txt"))
	if !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("Resolve(abs) err = %v, want ErrUnsafePath", err)
	}
}

func TestResolveRejectsUnknownRoot(t *testing.T) {
	dir := t.TempDir()
	roots, err := NewRoots([]string{dir})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}

	_, err = roots.Resolve("missing", "anything.mp4")
	if !errors.Is(err, ErrUnknownRoot) {
		t.Fatalf("Resolve(missing) err = %v, want ErrUnknownRoot", err)
	}
}
