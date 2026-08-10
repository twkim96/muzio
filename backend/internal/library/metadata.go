package library

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	artistTitleRE = regexp.MustCompile(`^(.+?)\s[-–—]\s(.+)$`)
	yearRE        = regexp.MustCompile(`(?:^|[^0-9])((?:19|20)[0-9]{2})(?:[^0-9]|$)`)
	seasonRE      = regexp.MustCompile(`(?i)\bS([0-9]{1,2})E([0-9]{1,3})\b|\b([0-9]{1,2})x([0-9]{1,3})\b`)
	hourMinuteRE  = regexp.MustCompile(`(?i)\b([0-9]{1,2})h\s*([0-9]{1,2})m?\b`)
	minuteRE      = regexp.MustCompile(`(?i)\b([0-9]{1,3})\s*(?:m|min|mins)\b`)
)

func ExtractMetadata(mediaType MediaType, relativePath, name string) Metadata {
	base := strings.TrimSuffix(name, filepath.Ext(name))
	title := cleanTitle(base, mediaType != MediaTypeVideo)
	meta := Metadata{
		Title: title,
		Year:  firstYear(relativePath),
	}

	switch mediaType {
	case MediaTypeAudio:
		if match := artistTitleRE.FindStringSubmatch(base); match != nil {
			meta.Artist = strings.TrimSpace(match[1])
			meta.Title = cleanTitle(match[2], true)
		}
		if album := albumFromPath(relativePath); album != "" {
			meta.Album = album
		}
	case MediaTypeVideo:
		if season, episode, ok := seasonEpisode(base); ok {
			meta.Season = season
			meta.Episode = episode
			meta.Title = cleanTitle(seasonRE.ReplaceAllString(base, ""), false)
		}
		if duration, ok := durationFromName(base); ok {
			meta.DurationSec = &duration
		}
	}

	if meta.Title == "" {
		meta.Title = title
	}
	return meta
}

func BuildThumbnail(mediaID string, mediaType MediaType, meta Metadata, modifiedAt time.Time, sizeBytes int64) Thumbnail {
	cacheKey := thumbnailCacheKey(mediaID, modifiedAt, sizeBytes)
	kind := ThumbnailKindFallback
	status := ThumbnailStatusReady
	if mediaType == MediaTypeVideo {
		kind = ThumbnailKindVideo
		status = ThumbnailStatusPending
	} else if mediaType == MediaTypeImage {
		kind = ThumbnailKindImage
		status = ThumbnailStatusPending
	} else if mediaType == MediaTypeAudio {
		kind = ThumbnailKindAudio
		status = ThumbnailStatusPending
	}
	return Thumbnail{
		URL:      thumbnailURL(mediaID, cacheKey, status),
		Kind:     kind,
		Status:   status,
		CacheKey: cacheKey,
	}
}

func ThumbnailWithStatus(thumbnail Thumbnail, mediaID, status string) Thumbnail {
	thumbnail.Status = status
	thumbnail.URL = thumbnailURL(mediaID, thumbnail.CacheKey, status)
	return thumbnail
}

func thumbnailURL(mediaID, cacheKey, status string) string {
	return fmt.Sprintf(
		"/api/thumbnails/%s?v=%s&state=%s",
		url.PathEscape(mediaID),
		url.QueryEscape(cacheKey),
		url.QueryEscape(status),
	)
}

func thumbnailCacheKey(mediaID string, modifiedAt time.Time, sizeBytes int64) string {
	h := sha1.New()
	_, _ = h.Write([]byte(mediaID))
	_, _ = h.Write([]byte("|"))
	_, _ = h.Write([]byte(modifiedAt.UTC().Format(time.RFC3339Nano)))
	_, _ = h.Write([]byte("|"))
	_, _ = h.Write([]byte(strconv.FormatInt(sizeBytes, 10)))
	return hex.EncodeToString(h.Sum(nil))[:12]
}

func cleanTitle(value string, stripYear bool) string {
	cleaned := strings.TrimSpace(value)
	cleaned = strings.ReplaceAll(cleaned, ".", " ")
	cleaned = strings.Join(strings.Fields(cleaned), " ")
	if stripYear {
		cleaned = yearRE.ReplaceAllString(cleaned, " ")
		cleaned = strings.Join(strings.Fields(cleaned), " ")
	}
	return strings.Trim(cleaned, " .-")
}

func firstYear(value string) int {
	match := yearRE.FindStringSubmatch(value)
	if match == nil {
		return 0
	}
	year, err := strconv.Atoi(match[1])
	if err != nil {
		return 0
	}
	return year
}

func albumFromPath(relativePath string) string {
	dir := filepath.ToSlash(filepath.Dir(relativePath))
	if dir == "." || dir == "" {
		return ""
	}
	parts := strings.Split(dir, "/")
	return cleanTitle(parts[len(parts)-1], true)
}

func seasonEpisode(base string) (int, int, bool) {
	match := seasonRE.FindStringSubmatch(base)
	if match == nil {
		return 0, 0, false
	}
	if match[1] != "" && match[2] != "" {
		return atoi(match[1]), atoi(match[2]), true
	}
	return atoi(match[3]), atoi(match[4]), true
}

func durationFromName(base string) (float64, bool) {
	if match := hourMinuteRE.FindStringSubmatch(base); match != nil {
		hours := atoi(match[1])
		minutes := atoi(match[2])
		return float64(hours*3600 + minutes*60), true
	}
	if match := minuteRE.FindStringSubmatch(base); match != nil {
		return float64(atoi(match[1]) * 60), true
	}
	return 0, false
}

func atoi(value string) int {
	n, err := strconv.Atoi(value)
	if err != nil {
		return 0
	}
	return n
}
