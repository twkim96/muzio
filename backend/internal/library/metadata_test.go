package library

import (
	"testing"
	"time"
)

func TestExtractMetadataForAudio(t *testing.T) {
	meta := ExtractMetadata(MediaTypeAudio, "Album/Lamp - Rainy Night 2024.flac", "Lamp - Rainy Night 2024.flac")

	if meta.Artist != "Lamp" {
		t.Fatalf("Artist = %q, want Lamp", meta.Artist)
	}
	if meta.Title != "Rainy Night" {
		t.Fatalf("Title = %q, want Rainy Night", meta.Title)
	}
	if meta.Album != "Album" {
		t.Fatalf("Album = %q, want Album", meta.Album)
	}
	if meta.Year != 2024 {
		t.Fatalf("Year = %d, want 2024", meta.Year)
	}
}

func TestExtractMetadataPreservesUnderscores(t *testing.T) {
	meta := ExtractMetadata(MediaTypeAudio, "_ku_yu2525(260630).aac", "_ku_yu2525(260630).aac")

	if meta.Title != "_ku_yu2525(260630)" {
		t.Fatalf("Title = %q, want _ku_yu2525(260630)", meta.Title)
	}
}

func TestExtractMetadataForVideo(t *testing.T) {
	meta := ExtractMetadata(MediaTypeVideo, "Show/Show.S02E03.2021.45min.mkv", "Show.S02E03.2021.45min.mkv")

	if meta.Title != "Show 2021 45min" {
		t.Fatalf("Title = %q, want Show 2021 45min", meta.Title)
	}
	if meta.Season != 2 || meta.Episode != 3 {
		t.Fatalf("Season/Episode = %d/%d, want 2/3", meta.Season, meta.Episode)
	}
	if meta.Year != 2021 {
		t.Fatalf("Year = %d, want 2021", meta.Year)
	}
	if meta.DurationSec == nil || *meta.DurationSec != 2700 {
		t.Fatalf("DurationSec = %#v, want 2700", meta.DurationSec)
	}
}

func TestBuildThumbnailUsesStableCacheKey(t *testing.T) {
	meta := Metadata{Title: "Song"}
	now := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	first := BuildThumbnail("id", MediaTypeAudio, meta, now, 10)
	second := BuildThumbnail("id", MediaTypeAudio, meta, now, 10)

	if first.CacheKey == "" || first.CacheKey != second.CacheKey {
		t.Fatalf("CacheKey = %q / %q, want stable non-empty", first.CacheKey, second.CacheKey)
	}
	if first.URL == "" {
		t.Fatalf("URL empty")
	}
}

func TestBuildVideoThumbnailStartsPendingAndReadyChangesURL(t *testing.T) {
	now := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	pending := BuildThumbnail("video-id", MediaTypeVideo, Metadata{}, now, 10)
	if pending.Kind != ThumbnailKindVideo || pending.Status != ThumbnailStatusPending {
		t.Fatalf("pending thumbnail = %#v", pending)
	}
	ready := ThumbnailWithStatus(
		pending,
		"video-id",
		ThumbnailStatusReady,
	)
	if ready.URL == pending.URL {
		t.Fatalf("ready URL = pending URL = %q", ready.URL)
	}
	if ready.CacheKey != pending.CacheKey {
		t.Fatalf("ready cache key = %q, want %q", ready.CacheKey, pending.CacheKey)
	}
}

func TestBuildImageThumbnailStartsPending(t *testing.T) {
	now := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	pending := BuildThumbnail("image-id", MediaTypeImage, Metadata{}, now, 10)
	if pending.Kind != ThumbnailKindImage ||
		pending.Status != ThumbnailStatusPending {
		t.Fatalf("pending image thumbnail = %#v", pending)
	}
}
