package fallback

import (
	"context"
	"os/exec"
	"sync/atomic"
	"testing"
)

func TestSystemFFmpegDetectorCachesProbe(t *testing.T) {
	var lookups atomic.Int32
	var commands atomic.Int32
	detector := &SystemFFmpegDetector{
		LookupPath: func(string) (string, error) {
			lookups.Add(1)
			return "ffmpeg", nil
		},
		Command: func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
			commands.Add(1)
			return exec.CommandContext(ctx, "sh", "-c", "printf 'ffmpeg version test\\n'")
		},
	}

	first := detector.Detect(context.Background())
	second := detector.Detect(context.Background())

	if !first.Available || first.Version != "ffmpeg version test" {
		t.Fatalf("first result = %#v", first)
	}
	if second != first {
		t.Fatalf("second result = %#v, want %#v", second, first)
	}
	if lookups.Load() != 1 || commands.Load() != 1 {
		t.Fatalf("lookups = %d, commands = %d", lookups.Load(), commands.Load())
	}
}
