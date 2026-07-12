package library

import (
	"errors"
	"testing"
)

func TestClassifyWindowsDriveType(t *testing.T) {
	tests := []struct {
		name      string
		driveType uint32
		err       error
		local     bool
		reason    string
	}{
		{name: "fixed", driveType: windowsDriveFixed, local: true},
		{name: "removable", driveType: windowsDriveRemovable, local: true},
		{name: "cdrom", driveType: windowsDriveCDROM, local: true},
		{name: "ramdisk", driveType: windowsDriveRAMDisk, local: true},
		{
			name:      "remote",
			driveType: windowsDriveRemote,
			reason:    "network filesystem uses manual refresh",
		},
		{
			name:      "unknown",
			driveType: windowsDriveUnknown,
			reason:    "drive root unavailable",
		},
		{
			name:      "missing root",
			driveType: windowsDriveNoRootDir,
			reason:    "drive root unavailable",
		},
		{
			name:   "query error",
			err:    errors.New("query failed"),
			reason: "drive type unavailable",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			local, reason := classifyWindowsDriveType(test.driveType, test.err)
			if local != test.local || reason != test.reason {
				t.Fatalf(
					"classifyWindowsDriveType() = (%t, %q), want (%t, %q)",
					local,
					reason,
					test.local,
					test.reason,
				)
			}
		})
	}
}
