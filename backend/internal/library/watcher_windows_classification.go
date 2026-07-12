package library

const (
	windowsDriveUnknown   = 0
	windowsDriveNoRootDir = 1
	windowsDriveRemovable = 2
	windowsDriveFixed     = 3
	windowsDriveRemote    = 4
	windowsDriveCDROM     = 5
	windowsDriveRAMDisk   = 6
)

func classifyWindowsDriveType(driveType uint32, err error) (bool, string) {
	if err != nil {
		return false, "drive type unavailable"
	}
	switch driveType {
	case windowsDriveRemote:
		return false, "network filesystem uses manual refresh"
	case windowsDriveUnknown, windowsDriveNoRootDir:
		return false, "drive root unavailable"
	default:
		return true, ""
	}
}
