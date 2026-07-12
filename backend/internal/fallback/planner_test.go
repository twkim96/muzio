package fallback

import (
	"context"
	"testing"

	"muzio/backend/internal/library"
)

type fakeDetector struct {
	info FFmpegInfo
}

func (f fakeDetector) Detect(context.Context) FFmpegInfo {
	return f.info
}

func TestPlanDefaultsToDirectWhenBrowserSupportIsNotNo(t *testing.T) {
	plan := Planner{}.Plan(context.Background(), library.Media{
		ID:       "m1",
		Type:     library.MediaTypeVideo,
		Name:     "movie.mkv",
		MIMEType: "video/x-matroska",
	}, BrowserSupportMaybe)

	if plan.Action != ActionDirect || plan.Status != "direct" {
		t.Fatalf("plan = %#v, want direct", plan)
	}
}

func TestPlanDisablesFallbackWhenFFmpegMissing(t *testing.T) {
	plan := Planner{
		Detector: fakeDetector{info: FFmpegInfo{Available: false, Reason: "missing"}},
	}.Plan(context.Background(), library.Media{
		ID:       "m1",
		Type:     library.MediaTypeVideo,
		Name:     "movie.mkv",
		MIMEType: "video/x-matroska",
	}, BrowserSupportNo)

	if plan.Action != ActionDisabled || plan.Status != "disabled" {
		t.Fatalf("plan = %#v, want disabled", plan)
	}
}

func TestPlanChoosesRemuxBeforeTranscodeForVideoContainers(t *testing.T) {
	plan := Planner{
		Detector: fakeDetector{info: FFmpegInfo{Available: true, Path: "/usr/bin/ffmpeg"}},
	}.Plan(context.Background(), library.Media{
		ID:       "m1",
		Type:     library.MediaTypeVideo,
		Name:     "movie.mkv",
		MIMEType: "video/x-matroska",
	}, BrowserSupportNo)

	if plan.Action != ActionRemux || plan.Status != "available" {
		t.Fatalf("plan = %#v, want remux", plan)
	}
}

func TestPlanChoosesAudioTranscodeForUnsupportedAudio(t *testing.T) {
	plan := Planner{
		Detector: fakeDetector{info: FFmpegInfo{Available: true, Path: "/usr/bin/ffmpeg"}},
	}.Plan(context.Background(), library.Media{
		ID:       "a1",
		Type:     library.MediaTypeAudio,
		Name:     "song.wma",
		MIMEType: "audio/x-ms-wma",
	}, BrowserSupportNo)

	if plan.Action != ActionAudioTranscode {
		t.Fatalf("action = %q, want audio_transcode", plan.Action)
	}
}

func TestNormalizeBrowserSupport(t *testing.T) {
	if got := NormalizeBrowserSupport(" NO "); got != BrowserSupportNo {
		t.Fatalf("got %q", got)
	}
	if got := NormalizeBrowserSupport("wat"); got != BrowserSupportUnknown {
		t.Fatalf("got %q", got)
	}
}
