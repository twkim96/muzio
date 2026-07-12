//go:build windows

package library

import (
	"errors"
	"testing"
)

func TestLocalWatchPathWithDriveType(t *testing.T) {
	tests := []struct {
		name       string
		path       string
		driveType  uint32
		queryErr   error
		wantRoot   string
		wantPath   string
		wantLocal  bool
		wantReason string
	}{
		{
			name:       "empty path",
			path:       " ",
			wantReason: "root unavailable",
		},
		{
			name:       "UNC share",
			path:       `\\server\share\media`,
			wantReason: "network filesystem uses manual refresh",
		},
		{
			name:       "mapped remote drive",
			path:       `Z:\media`,
			driveType:  windowsDriveRemote,
			wantRoot:   `Z:\`,
			wantReason: "network filesystem uses manual refresh",
		},
		{
			name:      "fixed drive",
			path:      `C:\media`,
			driveType: windowsDriveFixed,
			wantRoot:  `C:\`,
			wantPath:  `C:\media`,
			wantLocal: true,
		},
		{
			name:      "removable drive",
			path:      `E:\music`,
			driveType: windowsDriveRemovable,
			wantRoot:  `E:\`,
			wantPath:  `E:\music`,
			wantLocal: true,
		},
		{
			name:       "invalid root",
			path:       `Q:\missing`,
			driveType:  windowsDriveNoRootDir,
			wantRoot:   `Q:\`,
			wantReason: "drive root unavailable",
		},
		{
			name:       "query failure",
			path:       `D:\media`,
			queryErr:   errors.New("query failed"),
			wantRoot:   `D:\`,
			wantReason: "drive type unavailable",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var gotRoot string
			reader := func(root string) (uint32, error) {
				gotRoot = root
				return test.driveType, test.queryErr
			}
			gotPath, local, reason := localWatchPathWithDriveType(test.path, reader)
			if gotRoot != test.wantRoot ||
				gotPath != test.wantPath ||
				local != test.wantLocal ||
				reason != test.wantReason {
				t.Fatalf(
					"localWatchPathWithDriveType() = (%q, %t, %q), root %q; want (%q, %t, %q), root %q",
					gotPath,
					local,
					reason,
					gotRoot,
					test.wantPath,
					test.wantLocal,
					test.wantReason,
					test.wantRoot,
				)
			}
		})
	}
}
