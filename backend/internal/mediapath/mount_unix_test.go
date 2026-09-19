//go:build darwin || linux

package mediapath

import "testing"

func TestMountGuardDetectsUnmountWithDirectoryStillPresent(t *testing.T) {
	devices := map[string]uint64{"/": 1, "/mnt": 1, "/mnt/disk": 2, "/mnt/disk/music": 2}
	device := func(path string) (uint64, bool) { id, ok := devices[path]; return id, ok }
	mount := findMountPath("/mnt/disk/music", device)
	if mount != "/mnt/disk" || !mountAvailableWith(mount, device) {
		t.Fatal("mounted media root unavailable")
	}
	devices["/mnt/disk"] = 1
	devices["/mnt/disk/music"] = 1
	if mountAvailableWith(mount, device) {
		t.Fatal("empty unmounted directory reported online")
	}
	devices["/mnt/disk"] = 3
	devices["/mnt/disk/music"] = 3
	if !mountAvailableWith(mount, device) {
		t.Fatal("remounted volume did not recover")
	}
	if findMountPath("/mnt", device) != "" || !mountAvailableWith("", device) {
		t.Fatal("ordinary empty directories must remain available")
	}
}
