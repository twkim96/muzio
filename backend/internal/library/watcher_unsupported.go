//go:build (!darwin && !linux && !windows) || (darwin && !cgo) || android

package library

func newPlatformWatcher(paths []string) (watchBackend, []WatcherRootStatus, error) {
	statuses := make([]WatcherRootStatus, 0, len(paths))
	for _, path := range paths {
		statuses = append(statuses, WatcherRootStatus{
			Path:   path,
			Reason: "filesystem watcher unavailable on this build",
		})
	}
	return nil, statuses, nil
}
