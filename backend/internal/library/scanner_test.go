package library

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"muzio/backend/internal/mediapath"
)

func newTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func writeFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func TestScanCollectsClassifiedFiles(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "movies", "Inception.mkv"), "v")
	writeFile(t, filepath.Join(dir, "music", "song.mp3"), "a")
	writeFile(t, filepath.Join(dir, "images", "cover.webp"), "i")
	writeFile(t, filepath.Join(dir, "notes.txt"), "ignored")
	writeFile(t, filepath.Join(dir, ".DS_Store"), "ignored")
	writeFile(t, filepath.Join(dir, "Thumbs.db"), "ignored")

	roots, err := mediapath.NewRoots([]string{dir})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}
	items, err := Scan(roots, newTestLogger())
	if err != nil {
		t.Fatalf("Scan returned error: %v", err)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].RelativePath < items[j].RelativePath })

	if len(items) != 3 {
		t.Fatalf("len(items) = %d, want 3; items = %#v", len(items), items)
	}

	image := items[0]
	if image.Type != MediaTypeImage {
		t.Errorf("Type = %q, want %q", image.Type, MediaTypeImage)
	}
	if image.MIMEType != "image/webp" {
		t.Errorf("MIMEType = %q, want image/webp", image.MIMEType)
	}
	if image.Metadata.Title != "cover" {
		t.Errorf("image Metadata.Title = %q, want cover", image.Metadata.Title)
	}

	video := items[0]
	for _, item := range items {
		if item.Type == MediaTypeVideo {
			video = item
			break
		}
	}
	if video.Type != MediaTypeVideo {
		t.Errorf("Type = %q, want %q", video.Type, MediaTypeVideo)
	}
	if video.Name != "Inception.mkv" {
		t.Errorf("Name = %q, want Inception.mkv", video.Name)
	}
	if video.MIMEType != "video/x-matroska" {
		t.Errorf("MIMEType = %q, want video/x-matroska", video.MIMEType)
	}
	if video.RelativePath != "Inception.mkv" && video.RelativePath != "movies/Inception.mkv" {
		t.Errorf("unexpected RelativePath: %q", video.RelativePath)
	}
	if video.RootName == "" {
		t.Errorf("RootName empty")
	}
	if video.ID == "" {
		t.Errorf("ID empty")
	}
	if video.SizeBytes == 0 {
		t.Errorf("SizeBytes = 0, want > 0")
	}
	if video.ModifiedAt.IsZero() {
		t.Errorf("ModifiedAt zero")
	}
}

func TestScanSkipsNodeModules(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "movie.mp4"), "video")
	writeFile(t, filepath.Join(dir, "project", "node_modules", "asset.mp4"), "dependency")

	roots, err := mediapath.NewRoots([]string{dir})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}
	items, err := Scan(roots, newTestLogger())
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(items) != 1 || items[0].Name != "movie.mp4" {
		t.Fatalf("items = %#v, want only movie.mp4", items)
	}
}

func TestScanDistinguishesMPEGTransportStreamFromTypeScript(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "source.ts"), "export const value = 1;\n")
	writeFile(t, filepath.Join(dir, "types.d.ts"), "export interface Value { id: string }\n")

	transportStream := make([]byte, 3*188)
	for offset := 0; offset < len(transportStream); offset += 188 {
		transportStream[offset] = 0x47
	}
	if err := os.WriteFile(filepath.Join(dir, "recording.ts"), transportStream, 0o600); err != nil {
		t.Fatalf("write recording.ts: %v", err)
	}

	roots, err := mediapath.NewRoots([]string{dir})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}
	items, err := Scan(roots, newTestLogger())
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(items) != 1 || items[0].Name != "recording.ts" ||
		items[0].MIMEType != "video/mp2t" {
		t.Fatalf("items = %#v, want only recording.ts", items)
	}
}

func TestScanAddsMetadataThumbnailAndSubtitles(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "Show", "Show.S01E02.2024.mkv"), "v")
	writeFile(t, filepath.Join(dir, "Show", "Show.S01E02.2024.en.srt"), "subtitle")
	writeFile(t, filepath.Join(dir, "Show", "other.en.srt"), "ignored")

	roots, err := mediapath.NewRoots([]string{dir})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}
	items, err := Scan(roots, newTestLogger())
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len = %d, want 1; items = %#v", len(items), items)
	}
	item := items[0]
	if item.Metadata.Season != 1 || item.Metadata.Episode != 2 || item.Metadata.Year != 2024 {
		t.Fatalf("metadata = %#v, want season/episode/year", item.Metadata)
	}
	if item.Thumbnail.URL == "" || item.Thumbnail.CacheKey == "" {
		t.Fatalf("thumbnail = %#v, want url and cache key", item.Thumbnail)
	}
	if len(item.Subtitles) != 1 {
		t.Fatalf("subtitles = %#v, want one sidecar", item.Subtitles)
	}
	if item.Subtitles[0].Language != "en" {
		t.Fatalf("Language = %q, want en", item.Subtitles[0].Language)
	}
}

func TestScanAttachesSubtitlesFromSingleDirectoryPass(t *testing.T) {
	dir := t.TempDir()
	showDir := filepath.Join(dir, "Show")
	writeFile(t, filepath.Join(showDir, "Episode 01.mkv"), "v")
	writeFile(t, filepath.Join(showDir, "Episode 01.srt"), "default")
	writeFile(t, filepath.Join(showDir, "Episode 01.en.vtt"), "english")
	writeFile(t, filepath.Join(showDir, "Episode 01.en.forced.ass"), "ignored language form")
	writeFile(t, filepath.Join(showDir, "Episode 02.mkv"), "v")
	writeFile(t, filepath.Join(showDir, "Episode 02.ko.srt"), "korean")
	writeFile(t, filepath.Join(showDir, "unrelated.srt"), "ignored")

	roots, err := mediapath.NewRoots([]string{dir})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}
	items, err := Scan(roots, newTestLogger())
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("len(items) = %d, want 2; items = %#v", len(items), items)
	}

	byName := make(map[string]Media, len(items))
	for _, item := range items {
		byName[item.Name] = item
	}
	first := byName["Episode 01.mkv"]
	if len(first.Subtitles) != 3 {
		t.Fatalf("Episode 01 subtitles = %#v, want 3", first.Subtitles)
	}
	if first.Subtitles[0].RelativePath != "Show/Episode 01.en.forced.ass" ||
		first.Subtitles[0].Language != "" {
		t.Fatalf("first sorted subtitle = %#v", first.Subtitles[0])
	}
	if first.Subtitles[1].Language != "en" {
		t.Fatalf("english subtitle = %#v", first.Subtitles[1])
	}
	if first.Subtitles[2].RelativePath != "Show/Episode 01.srt" {
		t.Fatalf("default subtitle = %#v", first.Subtitles[2])
	}

	second := byName["Episode 02.mkv"]
	if len(second.Subtitles) != 1 || second.Subtitles[0].Language != "ko" {
		t.Fatalf("Episode 02 subtitles = %#v, want one ko subtitle", second.Subtitles)
	}
}

func TestScanUsesForwardSlashRelativePath(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "Inception", "Inception.mkv"), "v")

	roots, err := mediapath.NewRoots([]string{dir})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}
	items, err := Scan(roots, newTestLogger())
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len = %d, want 1", len(items))
	}
	if items[0].RelativePath != "Inception/Inception.mkv" {
		t.Fatalf("RelativePath = %q, want forward-slash form", items[0].RelativePath)
	}
}

func TestScanSkipsHiddenAndJunkFiles(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "ok.mp3"), "a")
	writeFile(t, filepath.Join(dir, ".hidden.mp3"), "skip")
	writeFile(t, filepath.Join(dir, "._resource.mp3"), "skip")
	writeFile(t, filepath.Join(dir, ".DS_Store"), "skip")

	roots, _ := mediapath.NewRoots([]string{dir})
	items, err := Scan(roots, newTestLogger())
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len = %d, want 1; got %#v", len(items), items)
	}
	if items[0].Name != "ok.mp3" {
		t.Fatalf("Name = %q, want ok.mp3", items[0].Name)
	}
}

func TestScanSkipsHiddenDirectories(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, ".cache", "track.mp3"), "skip")
	writeFile(t, filepath.Join(dir, "music", "track.mp3"), "keep")

	roots, _ := mediapath.NewRoots([]string{dir})
	items, err := Scan(roots, newTestLogger())
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len = %d, want 1; got %#v", len(items), items)
	}
	if items[0].RelativePath != "music/track.mp3" {
		t.Fatalf("RelativePath = %q", items[0].RelativePath)
	}
}

func TestScanIgnoresMissingRoot(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "ok.mp3"), "a")
	missing := filepath.Join(dir, "does-not-exist")

	roots, _ := mediapath.NewRoots([]string{dir, missing})
	items, err := Scan(roots, newTestLogger())
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len = %d, want 1 (missing root tolerated)", len(items))
	}
}

func TestScanReportMarksMissingRootIncomplete(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing")
	settings := MediaRootSettings{AudioRoots: []string{missing}}

	_, results, err := scanMediaRootSettingsReport(settings, newTestLogger())
	if err != nil {
		t.Fatalf("scanMediaRootSettingsReport: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("len(results) = %d, want 1", len(results))
	}
	if results[0].Complete {
		t.Fatalf("result = %#v, want incomplete", results[0])
	}
	if results[0].Err == nil {
		t.Fatalf("result = %#v, want root error", results[0])
	}
	if !results[0].Unavailable {
		t.Fatalf("result = %#v, want unavailable root", results[0])
	}
}

func TestScanDoesNotFollowSymlinks(t *testing.T) {
	if _, err := os.Lstat("/"); err != nil {
		t.Skip("filesystem does not support stat")
	}
	dir := t.TempDir()
	external := t.TempDir()
	writeFile(t, filepath.Join(external, "outside.mp3"), "leak")
	writeFile(t, filepath.Join(dir, "inside.mp3"), "ok")

	if err := os.Symlink(external, filepath.Join(dir, "linked")); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}

	roots, _ := mediapath.NewRoots([]string{dir})
	items, err := Scan(roots, newTestLogger())
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	for _, it := range items {
		if it.Name == "outside.mp3" {
			t.Fatalf("scan followed symlink: %#v", it)
		}
	}
	if len(items) != 1 || items[0].Name != "inside.mp3" {
		t.Fatalf("unexpected items: %#v", items)
	}
}

func TestScanProducesStableIDsAcrossRuns(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "a.mp3"), "x")

	roots, _ := mediapath.NewRoots([]string{dir})
	first, err := Scan(roots, newTestLogger())
	if err != nil {
		t.Fatalf("Scan 1: %v", err)
	}
	time.Sleep(5 * time.Millisecond)
	second, err := Scan(roots, newTestLogger())
	if err != nil {
		t.Fatalf("Scan 2: %v", err)
	}
	if len(first) != 1 || len(second) != 1 {
		t.Fatalf("unexpected counts: %d / %d", len(first), len(second))
	}
	if first[0].ID != second[0].ID {
		t.Fatalf("IDs not stable: %q vs %q", first[0].ID, second[0].ID)
	}
}
