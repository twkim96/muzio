package mediapath

import (
	"errors"
	"path/filepath"
	"strings"
)

// ErrUnsafePath is returned when a relative path attempts to escape its root
// or otherwise cannot be safely resolved within the configured boundary.
var ErrUnsafePath = errors.New("mediapath: unsafe path")

// Resolve returns the absolute path for (rootName, relPath) after verifying
// that the resulting path stays inside the named root. The check is purely
// lexical; callers that open the file (for example streaming handlers) must
// add an additional symlink and permission check before serving content.
func (r *Roots) Resolve(rootName, relPath string) (string, error) {
	root, ok := r.ByName(rootName)
	if !ok {
		return "", ErrUnknownRoot
	}
	if filepath.IsAbs(relPath) {
		return "", ErrUnsafePath
	}

	full := filepath.Clean(filepath.Join(root.Path, filepath.FromSlash(relPath)))

	if full != root.Path && !strings.HasPrefix(full, root.Path+string(filepath.Separator)) {
		return "", ErrUnsafePath
	}
	return full, nil
}

// ResolveStrict performs the same lexical check as Resolve and additionally
// evaluates filesystem symlinks to verify that the real on-disk location of
// the resolved path stays inside the real on-disk location of the root. This
// blocks symlink-based escapes that the lexical check alone cannot detect.
//
// The returned path is the fully-resolved real path, suitable for opening
// directly with os.Open. Filesystem errors (missing file, permission denied)
// are returned unwrapped so callers can branch with errors.Is(err, fs.ErrNotExist)
// and similar checks to decide HTTP status codes.
func (r *Roots) ResolveStrict(rootName, relPath string) (string, error) {
	lexical, err := r.Resolve(rootName, relPath)
	if err != nil {
		return "", err
	}
	root, _ := r.ByName(rootName)

	realRoot, err := filepath.EvalSymlinks(root.Path)
	if err != nil {
		return "", err
	}
	realTarget, err := filepath.EvalSymlinks(lexical)
	if err != nil {
		return "", err
	}
	if !insideOrEqual(realTarget, realRoot) {
		return "", ErrUnsafePath
	}
	return realTarget, nil
}

func insideOrEqual(target, root string) bool {
	if target == root {
		return true
	}
	return strings.HasPrefix(target, root+string(filepath.Separator))
}
