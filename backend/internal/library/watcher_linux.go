//go:build linux && !android

package library

import (
	"path/filepath"
	"syscall"
)

func localWatchPath(path string) (string, bool, string) {
	realPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", false, "root unavailable"
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(realPath, &stat); err != nil {
		return "", false, "filesystem type unavailable"
	}
	switch uint64(stat.Type) {
	case 0x6969, 0xff534d42, 0xfe534d42, 0x65735546:
		return "", false, "network or FUSE filesystem uses manual refresh"
	default:
		return filepath.Clean(realPath), true, ""
	}
}
