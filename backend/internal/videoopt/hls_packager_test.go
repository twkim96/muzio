package videoopt

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateHLSPackageAcceptsOnlyReferencedSafeAssets(t *testing.T) {
	dir := writeHLSPackageFixture(t, false)
	result, err := validateHLSPackage(dir, HLSPlan{DurationSeconds: 12, TargetSegmentSeconds: 6})
	if err != nil {
		t.Fatal(err)
	}
	if result.ManifestName != hlsManifestName || result.SegmentCount != 2 || len(result.Assets) != 4 {
		t.Fatalf("result=%#v", result)
	}
	if result.SegmentDuration.Min != 6 || result.SegmentDuration.Max != 6 || result.OutputBytes <= 0 {
		t.Fatalf("result=%#v", result)
	}
	if hlsAssetMIME(result.Assets[hlsManifestName]) != "application/vnd.apple.mpegurl" || hlsAssetMIME(result.Assets[hlsInitName]) != "video/mp4" {
		t.Fatalf("asset MIME mismatch: %#v", result.Assets)
	}
	if hlsAssetMIME(result.Assets["seg-000000.m4s"]) != "video/iso.segment" {
		t.Fatalf("segment MIME mismatch: %#v", result.Assets["seg-000000.m4s"])
	}
}

func TestFFmpegProgressWriterReportsBoundedFraction(t *testing.T) {
	var values []float64
	writer := &ffmpegProgressWriter{durationSeconds: 10, onProgress: func(value float64) {
		values = append(values, value)
	}}
	_, _ = writer.Write([]byte("frame=10\nout_time_us=5000000\n"))
	_, _ = writer.Write([]byte("out_time_us=20000000\n"))
	if len(values) != 2 || values[0] != 0.5 || values[1] != 0.99 {
		t.Fatalf("values=%v", values)
	}
}

func TestFFmpegHLSPackagerStopsPostProcessingWhenContextIsCanceled(t *testing.T) {
	outputDir := writeHLSPackageFixture(t, false)
	command := func(ctx context.Context, name string, args ...string) *exec.Cmd {
		joined := strings.Join(args, " ")
		switch {
		case name == "ffmpeg":
			return exec.CommandContext(ctx, "sh", "-c", "true")
		case strings.Contains(joined, "frame=best_effort_timestamp_time"):
			return exec.CommandContext(ctx, "sh", "-c", `printf '%s' '{"frames":[{"best_effort_timestamp_time":"0"},{"best_effort_timestamp_time":"6"}]}'`)
		default:
			return exec.CommandContext(ctx, "sh", "-c", `printf '%s' '{"streams":[{"codec_type":"video","codec_name":"h264"}],"format":{"duration":"12"}}'`)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	syncCalls := 0
	progress := make([]float64, 0)
	packager := FFmpegHLSPackager{
		Planner: HLSPlanner{Probe: FFmpegBuilder{Path: "ffmpeg", ProbePath: "ffprobe", Command: command}},
		Command: command,
		SyncFile: func(string) error {
			syncCalls++
			cancel()
			return nil
		},
	}
	plan := HLSPlan{
		Eligible: true, CacheKind: HLSCacheKind, DurationSeconds: 12,
		VideoCodec: "h264", TargetSegmentSeconds: 6,
	}
	_, err := packager.Build(ctx, "source.mp4", outputDir, plan, func(value float64) {
		progress = append(progress, value)
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error=%v, want context cancellation", err)
	}
	if syncCalls != 1 {
		t.Fatalf("sync calls=%d, want cancellation after first asset", syncCalls)
	}
	for _, value := range progress {
		if value == 1 {
			t.Fatalf("canceled package reported completion: %v", progress)
		}
	}
}

func TestFFmpegHLSPackagerNormalizesCanceledFFmpegProcess(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "hls-ffmpeg-started")
	outputDir := filepath.Join(dir, "package")
	command := func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		return longRunningTestCommand(ctx, marker)
	}
	packager := FFmpegHLSPackager{
		Planner: HLSPlanner{Probe: FFmpegBuilder{Path: "ffmpeg", ProbePath: "ffprobe"}},
		Command: command,
	}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := packager.Build(ctx, "source.mp4", outputDir, HLSPlan{
			Eligible: true, CacheKind: HLSCacheKind, DurationSeconds: 12,
			VideoCodec: "h264", TargetSegmentSeconds: 6,
		}, nil)
		result <- err
	}()
	waitForCommandMarker(t, marker)
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("HLS FFmpeg error=%v, want context canceled", err)
	}
}

func TestValidateHLSPackageRejectsMissingUnsafeAndUnverifiedAssets(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*testing.T, string)
		want   string
	}{
		{name: "missing segment", mutate: func(t *testing.T, dir string) {
			if err := os.Remove(filepath.Join(dir, "seg-000001.m4s")); err != nil {
				t.Fatal(err)
			}
		}, want: "missing"},
		{name: "unexpected file", mutate: func(t *testing.T, dir string) {
			if err := os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
		}, want: "unexpected"},
		{name: "absolute segment", mutate: func(t *testing.T, dir string) {
			manifest := "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6,\n/tmp/seg-000000.m4s\n#EXT-X-ENDLIST\n"
			if err := os.WriteFile(filepath.Join(dir, hlsManifestName), []byte(manifest), 0o600); err != nil {
				t.Fatal(err)
			}
		}, want: "unsafe"},
		{name: "independent claim", mutate: func(t *testing.T, dir string) {
			path := filepath.Join(dir, hlsManifestName)
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			data = []byte(strings.Replace(string(data), "#EXTM3U\n", "#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n", 1))
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
		}, want: "unverified"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			dir := writeHLSPackageFixture(t, false)
			test.mutate(t, dir)
			_, err := validateHLSPackage(dir, HLSPlan{DurationSeconds: 12, TargetSegmentSeconds: 6})
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error=%v, want %q", err, test.want)
			}
		})
	}
}

func TestFFmpegHLSPackagerProductionCreatesValidatedFMP4(t *testing.T) {
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg unavailable")
	}
	ffprobePath, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe unavailable")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "source.mp4")
	command := exec.Command(
		ffmpegPath, "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc=size=64x64:rate=30:duration=4",
		"-f", "lavfi", "-i", "sine=frequency=1000:duration=4",
		"-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264",
		"-pix_fmt", "yuv420p", "-g", "30", "-keyint_min", "30",
		"-sc_threshold", "0", "-c:a", "aac", "-movflags", "+faststart", "-y", source,
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Skipf("H.264/AAC fixture unavailable: %v: %s", err, output)
	}
	planner := HLSPlanner{
		Probe:   FFmpegBuilder{Path: ffmpegPath, ProbePath: ffprobePath},
		Options: HLSPlanOptions{MinimumMovieIndexBytes: 1, MaximumGOPSeconds: 2, TargetSegmentSeconds: 1},
	}
	packager := FFmpegHLSPackager{Planner: planner}
	plan, err := packager.Plan(context.Background(), source)
	if err != nil || !plan.Eligible {
		t.Fatalf("plan=%#v error=%v", plan, err)
	}
	outputDir := filepath.Join(dir, "package")
	var progress []float64
	result, err := packager.Build(context.Background(), source, outputDir, plan, func(value float64) {
		progress = append(progress, value)
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.SegmentCount < 3 || result.SegmentDuration.Max > 2 || !result.RandomAccessVerified || result.IndependentSegments {
		t.Fatalf("result=%#v", result)
	}
	if len(progress) == 0 || progress[len(progress)-1] != 1 {
		t.Fatalf("progress=%v", progress)
	}
	manifest, err := os.ReadFile(filepath.Join(outputDir, hlsManifestName))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(manifest), dir) || strings.Contains(string(manifest), "#EXT-X-INDEPENDENT-SEGMENTS") {
		t.Fatalf("unsafe or unverified manifest: %s", manifest)
	}
}

func writeHLSPackageFixture(t *testing.T, independent bool) string {
	t.Helper()
	dir := t.TempDir()
	manifest := "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI=\"init.mp4\"\n"
	if independent {
		manifest += "#EXT-X-INDEPENDENT-SEGMENTS\n"
	}
	manifest += "#EXTINF:6.000,\nseg-000000.m4s\n#EXTINF:6.000,\nseg-000001.m4s\n#EXT-X-ENDLIST\n"
	files := map[string][]byte{
		hlsManifestName:  []byte(manifest),
		hlsInitName:      []byte("init"),
		"seg-000000.m4s": []byte("segment-0"),
		"seg-000001.m4s": []byte("segment-1"),
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}
