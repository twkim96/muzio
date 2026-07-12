package library

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func TestSubtitleCandidateIndexPreservesMatchingSemantics(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "library")
	mediaPath := filepath.Join(root, "Show.S01E02.2024.mkv")
	candidates := []subtitleCandidate{
		{name: "Show.S01E02.2024.srt", relativePath: "Show.S01E02.2024.srt"},
		{name: "Show.S01E02.2024.en.vtt", relativePath: "Show.S01E02.2024.en.vtt"},
		{name: "Show.S01E02.2024.en.forced.ass", relativePath: "Show.S01E02.2024.en.forced.ass"},
		{name: "Show.S01E02.2024extra.srt", relativePath: "Show.S01E02.2024extra.srt"},
		{name: "Show.S01E02.en.srt", relativePath: "Show.S01E02.en.srt"},
	}

	got := subtitlesFromCandidates(mediaPath, candidates)
	if len(got) != 3 {
		t.Fatalf("subtitles = %#v, want 3", got)
	}
	if got[0].RelativePath != "Show.S01E02.2024.en.forced.ass" ||
		got[0].Language != "" ||
		got[0].Label != "Subtitle" {
		t.Fatalf("invalid language suffix = %#v", got[0])
	}
	if got[1].RelativePath != "Show.S01E02.2024.en.vtt" ||
		got[1].Language != "en" ||
		got[1].Label != "EN" {
		t.Fatalf("language subtitle = %#v", got[1])
	}
	if got[2].RelativePath != "Show.S01E02.2024.srt" ||
		got[2].Language != "" {
		t.Fatalf("exact subtitle = %#v", got[2])
	}
}

func TestSubtitleCandidateIndexBuildHonorsCancellation(t *testing.T) {
	candidates := make([]subtitleCandidate, 1024)
	for i := range candidates {
		candidates[i] = subtitleCandidate{
			name:         "episode.en.srt",
			relativePath: "episode.en.srt",
		}
	}
	index := newSubtitleCandidateIndex(candidates)
	index.addMediaPath(filepath.Join("root", "episode.mkv"))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := index.buildContext(ctx, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("buildContext error = %v, want context.Canceled", err)
	}
	if err := index.buildContext(context.Background(), nil); err != nil {
		t.Fatalf("retry buildContext: %v", err)
	}
	got, err := subtitlesFromCandidateIndexContext(
		context.Background(),
		filepath.Join("root", "episode.mkv"),
		index,
		nil,
	)
	if err != nil || len(got) != len(candidates) {
		t.Fatalf("retry result len = %d, err = %v", len(got), err)
	}
}
