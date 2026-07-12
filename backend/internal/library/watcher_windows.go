//go:build windows

package library

import (
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

func localWatchPath(path string) (string, bool, string) {
	return localWatchPathWithDriveType(path, getWindowsDriveType)
}

type windowsDriveTypeReader func(root string) (uint32, error)

func localWatchPathWithDriveType(
	path string,
	readDriveType windowsDriveTypeReader,
) (string, bool, string) {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return "", false, "root unavailable"
	}
	cleaned, err := filepath.Abs(trimmed)
	if err != nil {
		return "", false, "root unavailable"
	}
	cleaned = filepath.Clean(cleaned)
	if strings.HasPrefix(cleaned, `\\`) {
		return "", false, "network filesystem uses manual refresh"
	}
	volume := filepath.VolumeName(cleaned)
	if len(volume) != 2 || volume[1] != ':' {
		return "", false, "drive root unavailable"
	}
	root := volume + `\`
	local, reason := classifyWindowsDriveType(readDriveType(root))
	if !local {
		return "", false, reason
	}
	return cleaned, true, ""
}

func getWindowsDriveType(root string) (uint32, error) {
	rootPath, err := windows.UTF16PtrFromString(root)
	if err != nil {
		return windowsDriveUnknown, err
	}
	return windows.GetDriveType(rootPath), nil
}
