package audioresume

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestFFmpegRemuxerCopiesRawAACIntoM4AWhenFFmpegIsAvailable(t *testing.T) {
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is optional")
	}
	dir := t.TempDir()
	source := filepath.Join(dir, "source.aac")
	output := filepath.Join(dir, "output.m4a")
	generate := exec.Command(
		ffmpegPath,
		"-hide_banner",
		"-loglevel", "error",
		"-f", "lavfi",
		"-i", "sine=frequency=440:sample_rate=44100",
		"-t", "0.25",
		"-c:a", "aac",
		"-f", "adts",
		"-y",
		source,
	)
	if combined, err := generate.CombinedOutput(); err != nil {
		t.Fatalf("generate AAC: %v: %s", err, combined)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := (FFmpegRemuxer{Path: ffmpegPath}).Remux(ctx, source, output); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 12 || string(data[4:8]) != "ftyp" {
		t.Fatalf("output is not an MP4/M4A file: %x", data[:min(len(data), 12)])
	}
}
