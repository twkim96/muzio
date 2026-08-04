//go:build windows

package videoopt

import (
	"math"
	"path/filepath"

	"golang.org/x/sys/windows"
)

type systemSpaceChecker struct{}

func (systemSpaceChecker) AvailableBytes(path string) (int64, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return 0, err
	}
	pointer, err := windows.UTF16PtrFromString(absolute)
	if err != nil {
		return 0, err
	}
	var available uint64
	err = windows.GetDiskFreeSpaceEx(pointer, &available, nil, nil)
	if err != nil {
		return 0, err
	}
	if available > math.MaxInt64 {
		return math.MaxInt64, nil
	}
	return int64(available), nil
}

func syncDirectory(string) error { return nil }
