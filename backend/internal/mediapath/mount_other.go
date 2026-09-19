//go:build !darwin && !linux

package mediapath

func rootMountPath(string) string { return "" }
func mountAvailable(string) bool  { return true }
