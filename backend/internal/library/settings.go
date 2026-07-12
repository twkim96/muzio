package library

import (
	"strconv"
	"strings"
)

func SettingsFromRoots(paths []string) MediaRootSettings {
	var settings MediaRootSettings
	for _, path := range cleanRootList(paths) {
		switch inferRootKind(path) {
		case MediaTypeVideo:
			settings.VideoRoots = append(settings.VideoRoots, path)
		case MediaTypeImage:
			settings.ImageRoots = append(settings.ImageRoots, path)
		default:
			settings.AudioRoots = append(settings.AudioRoots, path)
		}
	}
	return settings
}

func NormalizeMediaRootSettings(settings MediaRootSettings) MediaRootSettings {
	return MediaRootSettings{
		AudioRoots: cleanRootList(settings.AudioRoots),
		VideoRoots: cleanRootList(settings.VideoRoots),
		ImageRoots: cleanRootList(settings.ImageRoots),
	}
}

func (settings MediaRootSettings) EffectiveRoots() []string {
	roots := make([]string, 0, len(settings.AudioRoots)+len(settings.VideoRoots)+len(settings.ImageRoots))
	roots = append(roots, settings.AudioRoots...)
	roots = append(roots, settings.VideoRoots...)
	roots = append(roots, settings.ImageRoots...)
	return roots
}

func mediaRootSettingsEqual(left, right MediaRootSettings) bool {
	return stringSlicesEqual(left.AudioRoots, right.AudioRoots) &&
		stringSlicesEqual(left.VideoRoots, right.VideoRoots) &&
		stringSlicesEqual(left.ImageRoots, right.ImageRoots)
}

func stringSlicesEqual(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func mediaRootSettingsKey(settings MediaRootSettings) string {
	var builder strings.Builder
	appendList := func(label byte, values []string) {
		builder.WriteByte(label)
		builder.WriteString(strconv.Itoa(len(values)))
		builder.WriteByte(':')
		for _, value := range values {
			builder.WriteString(strconv.Itoa(len(value)))
			builder.WriteByte(':')
			builder.WriteString(value)
		}
	}
	appendList('a', settings.AudioRoots)
	appendList('v', settings.VideoRoots)
	appendList('i', settings.ImageRoots)
	return builder.String()
}

func cleanRootList(paths []string) []string {
	roots := make([]string, 0, len(paths))
	seen := make(map[string]struct{})
	for _, path := range paths {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		if _, ok := seen[path]; ok {
			continue
		}
		seen[path] = struct{}{}
		roots = append(roots, path)
	}
	return roots
}

func inferRootKind(path string) MediaType {
	lower := strings.ToLower(path)
	if strings.Contains(lower, "video") ||
		strings.Contains(lower, "movie") ||
		strings.Contains(lower, "film") {
		return MediaTypeVideo
	}
	if strings.Contains(lower, "image") ||
		strings.Contains(lower, "photo") ||
		strings.Contains(lower, "picture") {
		return MediaTypeImage
	}
	return MediaTypeAudio
}

func cloneSettings(settings MediaRootSettings) MediaRootSettings {
	return MediaRootSettings{
		AudioRoots: append([]string(nil), settings.AudioRoots...),
		VideoRoots: append([]string(nil), settings.VideoRoots...),
		ImageRoots: append([]string(nil), settings.ImageRoots...),
	}
}
