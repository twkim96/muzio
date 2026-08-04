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
	"time"
)

func longRunningTestCommand(ctx context.Context, marker string) *exec.Cmd {
	return exec.CommandContext(ctx, "sh", "-c", `touch "$1"; exec sleep 30`, "sh", marker)
}

func waitForCommandMarker(t *testing.T, marker string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(marker); err == nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("command marker %q was not created", marker)
}

func TestFFmpegBuilderUsesPreservingFaststartCommandAndValidatesProbe(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source.mp4")
	output := filepath.Join(dir, "output.mp4")
	if err := os.WriteFile(source, endMoovFixture(), 0o600); err != nil {
		t.Fatal(err)
	}
	probeJSON := `{"streams":[{"codec_type":"video","codec_name":"h264"},{"codec_type":"audio","codec_name":"aac"},{"codec_type":"subtitle","codec_name":"mov_text"}],"chapters":[{}],"format":{"duration":"123.4"}}`
	var mu sync.Mutex
	var calls [][]string
	builder := FFmpegBuilder{Path: "ffmpeg", ProbePath: "ffprobe", Command: func(ctx context.Context, name string, args ...string) *exec.Cmd {
		mu.Lock()
		calls = append(calls, append([]string{name}, args...))
		mu.Unlock()
		if name == "ffprobe" {
			return exec.CommandContext(ctx, "sh", "-c", "printf '%s' '"+probeJSON+"'")
		}
		return exec.CommandContext(ctx, "sh", "-c", "cp \"$1\" \"$2\"", "sh", source, output)
	}}
	if err := builder.Build(context.Background(), source, output); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(calls) != 3 {
		t.Fatalf("calls=%d, want probe/build/probe", len(calls))
	}
	joined := strings.Join(calls[1], " ")
	for _, required := range []string{"-map 0", "-map_metadata 0", "-map_chapters 0", "-c copy", "-movflags +faststart", "-f mp4"} {
		if !strings.Contains(joined, required) {
			t.Errorf("command %q missing %q", joined, required)
		}
	}
}

func TestFFmpegBuilderRejectsUnpreservableTrack(t *testing.T) {
	builder := FFmpegBuilder{Path: "ffmpeg", ProbePath: "ffprobe", Command: func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		return exec.CommandContext(ctx, "sh", "-c", `printf '%s' '{"streams":[{"codec_type":"attachment","codec_name":"ttf"}]}'`)
	}}
	if err := builder.Check(context.Background(), "source.mp4"); err == nil || !strings.Contains(err.Error(), "attachment") {
		t.Fatalf("Check error=%v", err)
	}
}

func TestFFmpegBuilderRejectsSameSourceAndOutput(t *testing.T) {
	builder := FFmpegBuilder{Path: "ffmpeg", ProbePath: "ffprobe"}
	if err := builder.Build(context.Background(), "same.mp4", "same.mp4"); err == nil {
		t.Fatal("same path accepted")
	}
}

func TestFFmpegBuilderNormalizesCanceledProcesses(t *testing.T) {
	t.Run("probe", func(t *testing.T) {
		marker := filepath.Join(t.TempDir(), "probe-started")
		builder := FFmpegBuilder{Path: "ffmpeg", ProbePath: "ffprobe", Command: func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
			return longRunningTestCommand(ctx, marker)
		}}
		ctx, cancel := context.WithCancel(context.Background())
		result := make(chan error, 1)
		go func() {
			_, err := builder.probe(ctx, "source.mp4")
			result <- err
		}()
		waitForCommandMarker(t, marker)
		cancel()
		if err := <-result; !errors.Is(err, context.Canceled) {
			t.Fatalf("probe error=%v, want context canceled", err)
		}
	})

	t.Run("faststart", func(t *testing.T) {
		dir := t.TempDir()
		source := filepath.Join(dir, "source.mp4")
		output := filepath.Join(dir, "output.mp4")
		marker := filepath.Join(dir, "ffmpeg-started")
		if err := os.WriteFile(source, endMoovFixture(), 0o600); err != nil {
			t.Fatal(err)
		}
		builder := FFmpegBuilder{Path: "ffmpeg", ProbePath: "ffprobe", Command: func(ctx context.Context, name string, _ ...string) *exec.Cmd {
			if name == "ffprobe" {
				return exec.CommandContext(ctx, "sh", "-c", `printf '%s' '{"streams":[{"codec_type":"video","codec_name":"h264"}]}'`)
			}
			return longRunningTestCommand(ctx, marker)
		}}
		ctx, cancel := context.WithCancel(context.Background())
		result := make(chan error, 1)
		go func() { result <- builder.Build(ctx, source, output) }()
		waitForCommandMarker(t, marker)
		cancel()
		if err := <-result; !errors.Is(err, context.Canceled) {
			t.Fatalf("faststart error=%v, want context canceled", err)
		}
	})
}

func TestTailBufferKeepsBoundedSuffix(t *testing.T) {
	buffer := newTailBuffer(5)
	_, _ = buffer.Write([]byte("1234"))
	_, _ = buffer.Write([]byte("5678"))
	if got := buffer.String(); got != "45678" {
		t.Fatalf("tail=%q", got)
	}
}

func TestFFmpegBuilderProductionPreservesStreamsMetadataAndChapters(t *testing.T) {
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg unavailable")
	}
	ffprobePath, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe unavailable")
	}
	dir := t.TempDir()
	subtitlePath := filepath.Join(dir, "subtitle.srt")
	metadataPath := filepath.Join(dir, "metadata.txt")
	if err := os.WriteFile(subtitlePath, []byte("1\n00:00:00,000 --> 00:00:00,800\nHello\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	metadata := ";FFMETADATA1\ntitle=Muzio faststart fixture\nartist=Muzio\n"
	if err := os.WriteFile(metadataPath, []byte(metadata), 0o600); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(dir, "end-moov.mp4")
	output := filepath.Join(dir, "front-moov.mp4")
	command := exec.Command(ffmpegPath,
		"-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=black:s=64x64:d=1",
		"-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
		"-i", subtitlePath, "-f", "ffmetadata", "-i", metadataPath,
		"-map", "0:v:0", "-map", "1:a:0", "-map", "2:s:0",
		"-map_metadata", "3", "-map_chapters", "3",
		"-c:v", "mpeg4", "-c:a", "aac", "-c:s", "mov_text",
		"-metadata:s:a:0", "language=eng", "-metadata:s:s:0", "language=eng",
		"-y", source,
	)
	if outputBytes, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create fixture: %v: %s", err, outputBytes)
	}
	assertMP4Layout(t, source, LayoutEndMoov)
	builder := FFmpegBuilder{Path: ffmpegPath, ProbePath: ffprobePath}
	if err := builder.Check(context.Background(), source); err != nil {
		t.Fatal(err)
	}
	if err := builder.Build(context.Background(), source, output); err != nil {
		t.Fatal(err)
	}
	assertMP4Layout(t, output, LayoutFrontMoov)
	probe, err := builder.probe(context.Background(), output)
	if err != nil {
		t.Fatal(err)
	}
	if len(probe.Streams) != 3 || len(probe.Chapters) != 0 {
		t.Fatalf("output streams=%d chapters=%d", len(probe.Streams), len(probe.Chapters))
	}
	if probe.Format.Tags["title"] != "Muzio faststart fixture" || probe.Format.Tags["artist"] != "Muzio" {
		t.Fatalf("format tags=%v", probe.Format.Tags)
	}

	movSource := filepath.Join(dir, "end-moov.mov")
	movOutput := filepath.Join(dir, "front-moov-from-mov.mp4")
	command = exec.Command(ffmpegPath, "-hide_banner", "-loglevel", "error", "-i", source,
		"-map", "0", "-map_metadata", "0", "-c", "copy", "-f", "mov", "-y", movSource)
	if outputBytes, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create MOV fixture: %v: %s", err, outputBytes)
	}
	assertMP4Layout(t, movSource, LayoutEndMoov)
	if err := builder.Check(context.Background(), movSource); err != nil {
		t.Fatal(err)
	}
	if err := builder.Build(context.Background(), movSource, movOutput); err != nil {
		t.Fatal(err)
	}
	assertMP4Layout(t, movOutput, LayoutFrontMoov)

	chapterMetadata := filepath.Join(dir, "chapters.txt")
	chapterSource := filepath.Join(dir, "chaptered.mp4")
	chapterOutput := filepath.Join(dir, "chaptered-faststart.mp4")
	chapterData := ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=800\ntitle=Opening\n"
	if err := os.WriteFile(chapterMetadata, []byte(chapterData), 0o600); err != nil {
		t.Fatal(err)
	}
	command = exec.Command(ffmpegPath, "-hide_banner", "-loglevel", "error", "-i", source,
		"-f", "ffmetadata", "-i", chapterMetadata, "-map", "0", "-map_metadata", "0",
		"-map_chapters", "1", "-c", "copy", "-f", "mp4", "-y", chapterSource)
	if outputBytes, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create chapter fixture: %v: %s", err, outputBytes)
	}
	if err := builder.Check(context.Background(), chapterSource); err != nil {
		if !strings.Contains(err.Error(), "data tracks") {
			t.Fatalf("chapter eligibility: %v", err)
		}
	} else {
		if err := builder.Build(context.Background(), chapterSource, chapterOutput); err != nil {
			t.Fatal(err)
		}
		chapterProbe, err := builder.probe(context.Background(), chapterOutput)
		if err != nil || len(chapterProbe.Chapters) != 1 {
			t.Fatalf("chapter output chapters=%d error=%v", len(chapterProbe.Chapters), err)
		}
	}
}

func assertMP4Layout(t *testing.T, path string, want Layout) {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	inspection, err := InspectMP4(file, info.Size())
	if err != nil {
		t.Fatal(err)
	}
	if inspection.Layout != want {
		t.Fatalf("%s layout=%s, want %s", filepath.Base(path), inspection.Layout, want)
	}
}
