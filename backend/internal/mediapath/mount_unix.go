//go:build darwin || linux

package mediapath

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
)

func deviceID(path string) (uint64, bool) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return uint64(stat.Dev), true
}

func rootMountPath(path string) string {
	// macOS volume paths remain recognizable even when starting offline.
	if runtime.GOOS == "darwin" && strings.HasPrefix(path, "/Volumes/") {
		name := strings.Split(strings.TrimPrefix(path, "/Volumes/"), "/")[0]
		if name != "" {
			return filepath.Join("/Volumes", name)
		}
	}
	return findMountPath(path, deviceID)
}

func findMountPath(path string, device func(string) (uint64, bool)) string {
	for path != filepath.Dir(path) {
		parent := filepath.Dir(path)
		current, ok := device(path)
		above, parentOK := device(parent)
		if ok && parentOK && current != above {
			return path
		}
		path = parent
	}
	return "" // Ordinary folders on the system filesystem need no mount guard.
}

func mountAvailable(path string) bool {
	return mountAvailableWith(path, deviceID)
}

func mountAvailableWith(path string, device func(string) (uint64, bool)) bool {
	if path == "" {
		return true
	}
	current, ok := device(path)
	parent, parentOK := device(filepath.Dir(path))
	return ok && parentOK && current != parent
}
