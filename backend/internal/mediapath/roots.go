package mediapath

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Root identifies a configured media folder by a stable name and an absolute path.
type Root struct {
	Name string
	Path string
}

// Roots is the registry of normalized media roots used by library and streaming.
type Roots struct {
	list   []Root
	byName map[string]Root
}

// ErrUnknownRoot is returned when a name does not match any registered root.
var ErrUnknownRoot = errors.New("mediapath: unknown root")

// NewRoots normalizes the given paths into absolute, cleaned roots and assigns
// stable names. Empty entries are skipped. Duplicate paths are deduplicated.
// Existence and directory checks are intentionally deferred to scan time so
// that a misconfigured root does not prevent the server from starting.
//
// Each root is named "<basename>-<pathHash8>" where pathHash8 is the first 8
// hex chars of sha256(absolutePath). The path-derived suffix keeps root names
// stable across config reorderings and across roots that share the same
// basename, so media IDs derived from (rootName, relPath) survive list-order
// changes without any per-file rewriting.
func NewRoots(paths []string) (*Roots, error) {
	r := &Roots{byName: make(map[string]Root)}
	seenPaths := make(map[string]struct{})

	for _, p := range paths {
		trimmed := strings.TrimSpace(p)
		if trimmed == "" {
			continue
		}
		abs, err := filepath.Abs(trimmed)
		if err != nil {
			return nil, fmt.Errorf("mediapath: resolve %q: %w", trimmed, err)
		}
		cleaned := filepath.Clean(abs)
		if _, dup := seenPaths[cleaned]; dup {
			continue
		}
		seenPaths[cleaned] = struct{}{}

		name := makeRootName(cleaned)
		root := Root{Name: name, Path: cleaned}
		r.list = append(r.list, root)
		r.byName[name] = root
	}
	return r, nil
}

// All returns the registered roots in registration order.
func (r *Roots) All() []Root {
	if r == nil {
		return nil
	}
	out := make([]Root, len(r.list))
	copy(out, r.list)
	return out
}

// ByName looks up a root by its assigned name.
func (r *Roots) ByName(name string) (Root, bool) {
	if r == nil {
		return Root{}, false
	}
	root, ok := r.byName[name]
	return root, ok
}

func (r *Roots) RootAvailable(name string) bool {
	root, ok := r.ByName(name)
	if !ok {
		return false
	}
	info, err := os.Stat(root.Path)
	return err == nil && info.IsDir()
}

func makeRootName(absPath string) string {
	base := filepath.Base(absPath)
	if base == "" || base == "." || base == string(filepath.Separator) {
		base = "root"
	}
	h := sha256.Sum256([]byte(absPath))
	return fmt.Sprintf("%s-%s", base, hex.EncodeToString(h[:4]))
}
