package mediapath

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveStrictAcceptsRegularFile(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "song.mp3")
	if err := os.WriteFile(target, []byte("a"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	roots, err := NewRoots([]string{dir})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}
	root := roots.All()[0]

	got, err := roots.ResolveStrict(root.Name, "song.mp3")
	if err != nil {
		t.Fatalf("ResolveStrict: %v", err)
	}
	wantReal, _ := filepath.EvalSymlinks(target)
	if got != wantReal {
		t.Fatalf("got %q, want %q", got, wantReal)
	}
}

func TestResolveStrictRejectsLexicalTraversal(t *testing.T) {
	dir := t.TempDir()
	roots, err := NewRoots([]string{filepath.Join(dir, "media")})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "media"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	root := roots.All()[0]

	_, err = roots.ResolveStrict(root.Name, "../etc/passwd")
	if !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("err = %v, want ErrUnsafePath", err)
	}
}

func TestResolveStrictRejectsSymlinkEscape(t *testing.T) {
	dir := t.TempDir()
	external := t.TempDir()
	secret := filepath.Join(external, "secret.mp4")
	if err := os.WriteFile(secret, []byte("leak"), 0o600); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	root := filepath.Join(dir, "media")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.Symlink(secret, filepath.Join(root, "sneak.mp4")); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}

	roots, err := NewRoots([]string{root})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}

	_, err = roots.ResolveStrict(roots.All()[0].Name, "sneak.mp4")
	if !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("err = %v, want ErrUnsafePath", err)
	}
}

func TestResolveStrictAcceptsInternalSymlink(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "media")
	target := filepath.Join(root, "real.mp4")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(target, []byte("ok"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.Symlink(target, filepath.Join(root, "alias.mp4")); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}

	roots, err := NewRoots([]string{root})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}

	got, err := roots.ResolveStrict(roots.All()[0].Name, "alias.mp4")
	if err != nil {
		t.Fatalf("ResolveStrict: %v", err)
	}
	wantReal, _ := filepath.EvalSymlinks(target)
	if got != wantReal {
		t.Fatalf("got %q, want %q", got, wantReal)
	}
}

func TestResolveStrictAcceptsRootThatIsItselfASymlink(t *testing.T) {
	// Common case on macOS where /tmp is a symlink to /private/tmp.
	parent := t.TempDir()
	real := filepath.Join(parent, "real_root")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(real, "song.mp3"), []byte("a"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	link := filepath.Join(parent, "link_root")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}

	roots, err := NewRoots([]string{link})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}
	got, err := roots.ResolveStrict(roots.All()[0].Name, "song.mp3")
	if err != nil {
		t.Fatalf("ResolveStrict: %v", err)
	}
	realResolved, err := filepath.EvalSymlinks(real)
	if err != nil {
		t.Fatalf("EvalSymlinks(real): %v", err)
	}
	if !strings.HasPrefix(got, realResolved) {
		t.Fatalf("real path %q does not live under %q", got, realResolved)
	}
}

func TestResolveStrictReportsMissingFile(t *testing.T) {
	dir := t.TempDir()
	roots, err := NewRoots([]string{dir})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}

	_, err = roots.ResolveStrict(roots.All()[0].Name, "missing.mp4")
	if err == nil {
		t.Fatal("expected error for missing file, got nil")
	}
	if errors.Is(err, ErrUnsafePath) || errors.Is(err, ErrUnknownRoot) {
		t.Fatalf("expected ENOENT-class error, got %v", err)
	}
	if !os.IsNotExist(err) {
		t.Fatalf("expected os.IsNotExist, got %v", err)
	}
}

func TestResolveStrictRejectsUnknownRoot(t *testing.T) {
	dir := t.TempDir()
	roots, err := NewRoots([]string{dir})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}

	_, err = roots.ResolveStrict("missing-root", "anything.mp4")
	if !errors.Is(err, ErrUnknownRoot) {
		t.Fatalf("err = %v, want ErrUnknownRoot", err)
	}
}
