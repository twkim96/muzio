package videoopt

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestEvaluateHLSPlanAcceptsMeasuredFrontMoovH264AAC(t *testing.T) {
	inspection := hlsFrontInspection(32 << 20)
	probe := hlsProbe(
		[]probeStream{{CodecType: "video", CodecName: "h264"}, {CodecType: "audio", CodecName: "aac"}},
		"20",
	)
	options := measuredHLSOptions()
	options.ExistingCacheBytes = 1234
	plan := evaluateHLSPlan(inspection, 1000, probe, []float64{0, 5, 10, 15}, options)
	if !plan.Eligible || plan.Reason != "" {
		t.Fatalf("plan=%#v", plan)
	}
	if plan.CacheKind != HLSCacheKind || plan.VideoCodec != "h264" || plan.AudioCodec != "aac" {
		t.Fatalf("codecs/kind=%#v", plan)
	}
	if plan.GOP.Count != 4 || plan.GOP.Min != 5 || plan.GOP.Median != 5 || plan.GOP.P95 != 5 || plan.GOP.Max != 5 {
		t.Fatalf("GOP stats=%#v", plan.GOP)
	}
	if plan.EstimatedOutputBytes != 1000 || plan.PeakCacheBytes != 2234 || plan.RequiredFreeBytes <= plan.EstimatedOutputBytes {
		t.Fatalf("storage plan=%#v", plan)
	}
}

func TestEvaluateHLSPlanRejectsUnsupportedContainersAndTracks(t *testing.T) {
	validProbe := hlsProbe([]probeStream{{CodecType: "video", CodecName: "h264"}}, "20")
	tests := []struct {
		name       string
		inspection Inspection
		probe      probeDocument
		want       string
	}{
		{name: "small front index", inspection: hlsFrontInspection(1024), probe: validProbe, want: "below the measured"},
		{name: "fragmented", inspection: Inspection{Layout: LayoutFragmented}, probe: validProbe, want: "already fragmented"},
		{name: "end moov", inspection: Inspection{Layout: LayoutEndMoov}, probe: validProbe, want: "faststart"},
		{name: "HEVC", inspection: hlsFrontInspection(32 << 20), probe: hlsProbe([]probeStream{{CodecType: "video", CodecName: "hevc"}}, "20"), want: "H.264"},
		{name: "two videos", inspection: hlsFrontInspection(32 << 20), probe: hlsProbe([]probeStream{{CodecType: "video", CodecName: "h264"}, {CodecType: "video", CodecName: "h264"}}, "20"), want: "exactly one video"},
		{name: "two audios", inspection: hlsFrontInspection(32 << 20), probe: hlsProbe([]probeStream{{CodecType: "video", CodecName: "h264"}, {CodecType: "audio", CodecName: "aac"}, {CodecType: "audio", CodecName: "aac"}}, "20"), want: "at most one audio"},
		{name: "non AAC", inspection: hlsFrontInspection(32 << 20), probe: hlsProbe([]probeStream{{CodecType: "video", CodecName: "h264"}, {CodecType: "audio", CodecName: "opus"}}, "20"), want: "AAC"},
		{name: "subtitle", inspection: hlsFrontInspection(32 << 20), probe: hlsProbe([]probeStream{{CodecType: "video", CodecName: "h264"}, {CodecType: "subtitle", CodecName: "mov_text"}}, "20"), want: "subtitles"},
		{name: "data", inspection: hlsFrontInspection(32 << 20), probe: hlsProbe([]probeStream{{CodecType: "video", CodecName: "h264"}, {CodecType: "data", CodecName: "bin_data"}}, "20"), want: "data tracks"},
		{name: "chapters", inspection: hlsFrontInspection(32 << 20), probe: probeDocument{Streams: []probeStream{{CodecType: "video", CodecName: "h264", Profile: "High", Level: 40, PixelFormat: "yuv420p", CodecTag: "avc1", FieldOrder: "progressive", AvgFrameRate: "30/1", RFrameRate: "30/1"}}, Chapters: []probeChapter{{}}, Format: probeFormat{Duration: "20"}}, want: "chapters"},
		{name: "High 10", inspection: hlsFrontInspection(32 << 20), probe: hlsProbe([]probeStream{{CodecType: "video", CodecName: "h264", Profile: "High 10", PixelFormat: "yuv420p10le"}}, "20"), want: "profile"},
		{name: "unsupported pixel format", inspection: hlsFrontInspection(32 << 20), probe: hlsProbe([]probeStream{{CodecType: "video", CodecName: "h264", PixelFormat: "yuv444p"}}, "20"), want: "8-bit 4:2:0"},
		{name: "interlaced", inspection: hlsFrontInspection(32 << 20), probe: hlsProbe([]probeStream{{CodecType: "video", CodecName: "h264", FieldOrder: "tt"}}, "20"), want: "progressive"},
		{name: "over 60fps", inspection: hlsFrontInspection(32 << 20), probe: hlsProbe([]probeStream{{CodecType: "video", CodecName: "h264", AvgFrameRate: "120/1"}}, "20"), want: "60fps"},
		{name: "avc3 unverified", inspection: hlsFrontInspection(32 << 20), probe: hlsProbe([]probeStream{{CodecType: "video", CodecName: "h264", CodecTag: "avc3"}}, "20"), want: "avc1"},
		{name: "unsupported AAC profile", inspection: hlsFrontInspection(32 << 20), probe: hlsProbe([]probeStream{{CodecType: "video", CodecName: "h264"}, {CodecType: "audio", CodecName: "aac", Profile: "Main"}}, "20"), want: "AAC profile"},
		{name: "multichannel LC unverified", inspection: hlsFrontInspection(32 << 20), probe: hlsProbe([]probeStream{{CodecType: "video", CodecName: "h264"}, {CodecType: "audio", CodecName: "aac", Profile: "LC", Channels: 6}}, "20"), want: "1 or 2 channels"},
		{name: "multichannel HE-AACv2", inspection: hlsFrontInspection(32 << 20), probe: hlsProbe([]probeStream{{CodecType: "video", CodecName: "h264"}, {CodecType: "audio", CodecName: "aac", Profile: "HE-AACv2", Channels: 6}}, "20"), want: "stereo"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			plan := evaluateHLSPlan(test.inspection, 1000, test.probe, []float64{0, 5, 10, 15}, measuredHLSOptions())
			if plan.Eligible || !strings.Contains(plan.Reason, test.want) {
				t.Fatalf("plan=%#v, want reason containing %q", plan, test.want)
			}
		})
	}
}

func TestEvaluateHLSPlanRejectsUnusableKeyframeIntervals(t *testing.T) {
	probe := hlsProbe([]probeStream{{CodecType: "video", CodecName: "h264"}}, "20")
	tests := []struct {
		name      string
		keyframes []float64
		want      string
	}{
		{name: "none", keyframes: nil, want: "no video keyframes"},
		{name: "late first", keyframes: []float64{2, 8, 14}, want: "not near zero"},
		{name: "long GOP", keyframes: []float64{0, 12}, want: "exceeds measured limit"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			plan := evaluateHLSPlan(hlsFrontInspection(32<<20), 1000, probe, test.keyframes, measuredHLSOptions())
			if plan.Eligible || !strings.Contains(plan.Reason, test.want) {
				t.Fatalf("plan=%#v", plan)
			}
		})
	}
}

func TestHLSPlannerUsesBoundedStreamAndKeyframeProbes(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "front.mp4")
	if err := os.WriteFile(source, frontMoovFixture(), 0o600); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var calls []string
	command := func(ctx context.Context, name string, args ...string) *exec.Cmd {
		joined := strings.Join(append([]string{name}, args...), " ")
		mu.Lock()
		calls = append(calls, joined)
		mu.Unlock()
		if strings.Contains(joined, "frame=best_effort_timestamp_time") {
			return exec.CommandContext(ctx, "sh", "-c", `printf '%s' '{"frames":[{"best_effort_timestamp_time":"0"},{"best_effort_timestamp_time":"5"},{"best_effort_timestamp_time":"10"},{"best_effort_timestamp_time":"15"}]}'`)
		}
		return exec.CommandContext(ctx, "sh", "-c", `printf '%s' '{"streams":[{"codec_type":"video","codec_name":"h264","profile":"High","level":10,"pix_fmt":"yuv420p","codec_tag_string":"avc1","field_order":"progressive","avg_frame_rate":"30/1","r_frame_rate":"30/1"},{"codec_type":"audio","codec_name":"aac","profile":"LC","sample_rate":"44100","channels":2,"codec_tag_string":"mp4a"}],"format":{"duration":"20"}}'`)
	}
	planner := HLSPlanner{
		Probe: FFmpegBuilder{Path: "ffmpeg", ProbePath: "ffprobe", Command: command},
		Options: HLSPlanOptions{
			MinimumMovieIndexBytes: 1,
			MaximumGOPSeconds:      8,
			TargetSegmentSeconds:   6,
		},
	}
	plan, err := planner.Plan(context.Background(), source)
	if err != nil || !plan.Eligible {
		t.Fatalf("plan=%#v error=%v", plan, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(calls) != 2 || !strings.Contains(calls[1], "-skip_frame nokey") || !strings.Contains(calls[1], "-select_streams v:0") || !strings.Contains(calls[1], "-show_frames") {
		t.Fatalf("probe calls=%v", calls)
	}
}

func TestHLSPlannerRequiresMeasuredThresholds(t *testing.T) {
	planner := HLSPlanner{}
	if _, err := planner.Plan(context.Background(), "unused.mp4"); err == nil || !strings.Contains(err.Error(), "measured evidence") {
		t.Fatalf("error=%v", err)
	}
}

func TestHLSKeyframeProbeNormalizesCanceledProcess(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "keyframe-probe-started")
	planner := HLSPlanner{Probe: FFmpegBuilder{
		Path: "ffmpeg", ProbePath: "ffprobe",
		Command: func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
			return longRunningTestCommand(ctx, marker)
		},
	}}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := planner.probeKeyframes(ctx, "source.mp4")
		result <- err
	}()
	waitForCommandMarker(t, marker)
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("keyframe probe error=%v, want context canceled", err)
	}
}

func TestHLSPlannerProductionProbesH264Keyframes(t *testing.T) {
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg unavailable")
	}
	ffprobePath, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe unavailable")
	}
	source := filepath.Join(t.TempDir(), "h264-front.mp4")
	command := exec.Command(
		ffmpegPath, "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc=size=64x64:rate=30:duration=3",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30",
		"-keyint_min", "30", "-sc_threshold", "0", "-movflags", "+faststart",
		"-y", source,
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Skipf("H.264 fixture unavailable: %v: %s", err, output)
	}
	planner := HLSPlanner{
		Probe: FFmpegBuilder{Path: ffmpegPath, ProbePath: ffprobePath},
		Options: HLSPlanOptions{
			MinimumMovieIndexBytes: 1,
			MaximumGOPSeconds:      2,
			TargetSegmentSeconds:   1,
		},
	}
	plan, err := planner.Plan(context.Background(), source)
	if err != nil || !plan.Eligible {
		t.Fatalf("plan=%#v error=%v", plan, err)
	}
	if plan.GOP.Count < 2 || plan.GOP.Max > 2 || plan.VideoCodec != "h264" {
		t.Fatalf("plan=%#v", plan)
	}
}

func hlsFrontInspection(movieBytes int64) Inspection {
	return Inspection{Layout: LayoutFrontMoov, Movie: &Atom{Type: "moov", Size: movieBytes}}
}

func hlsProbe(streams []probeStream, duration string) probeDocument {
	for index := range streams {
		switch streams[index].CodecType {
		case "video":
			if streams[index].CodecName == "h264" {
				if streams[index].Profile == "" {
					streams[index].Profile = "High"
				}
				if streams[index].Level == 0 {
					streams[index].Level = 40
				}
				if streams[index].PixelFormat == "" {
					streams[index].PixelFormat = "yuv420p"
				}
				if streams[index].CodecTag == "" {
					streams[index].CodecTag = "avc1"
				}
				if streams[index].FieldOrder == "" {
					streams[index].FieldOrder = "progressive"
				}
				if streams[index].AvgFrameRate == "" {
					streams[index].AvgFrameRate = "30/1"
				}
				if streams[index].RFrameRate == "" {
					streams[index].RFrameRate = "30/1"
				}
			}
		case "audio":
			if streams[index].CodecName == "aac" {
				if streams[index].Profile == "" {
					streams[index].Profile = "LC"
				}
				if streams[index].SampleRate == "" {
					streams[index].SampleRate = "44100"
				}
				if streams[index].Channels == 0 {
					streams[index].Channels = 2
				}
				if streams[index].CodecTag == "" {
					streams[index].CodecTag = "mp4a"
				}
			}
		}
	}
	return probeDocument{Streams: streams, Format: probeFormat{Duration: duration}}
}

func measuredHLSOptions() HLSPlanOptions {
	return HLSPlanOptions{
		MinimumMovieIndexBytes: 16 << 20,
		MaximumGOPSeconds:      8,
		TargetSegmentSeconds:   6,
	}
}
