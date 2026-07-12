package mediapath

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"strings"
)

// EncodeID returns a stable opaque token for a (rootName, relPath) pair.
// The encoding is one-way; callers that need the original pair must keep
// their own ID -> record mapping. The path is normalized to forward slashes
// and lexically cleaned before hashing so equivalent paths share the same ID.
func EncodeID(rootName, relPath string) string {
	normalized := strings.TrimPrefix(filepath.ToSlash(filepath.Clean(filepath.FromSlash(relPath))), "/")
	h := sha256.Sum256([]byte(rootName + "\x00" + normalized))
	return hex.EncodeToString(h[:8])
}
