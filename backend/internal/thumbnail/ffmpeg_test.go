package thumbnail

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"muzio/backend/internal/library"
)

func TestFFmpegExtractorRetriesAtEarlyFrame(t *testing.T) {
	var mu sync.Mutex
	var seeks []string
	extractor := FFmpegExtractor{
		Path: "ffmpeg",
		Command: func(ctx context.Context, name string, args ...string) *exec.Cmd {
			for index, arg := range args {
				if arg == "-ss" && index+1 < len(args) {
					mu.Lock()
					seeks = append(seeks, args[index+1])
					mu.Unlock()
				}
			}
			if len(seeks) == 1 {
				return exec.CommandContext(ctx, "sh", "-c", "exit 0")
			}
			return exec.CommandContext(ctx, "sh", "-c", "printf jpeg > \"$1\"", "sh", args[len(args)-1])
		},
	}
	if err := extractor.Extract(context.Background(), "source.mp4", t.TempDir()+"/out.jpg"); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seeks) != 2 || seeks[0] != "10" || seeks[1] != "0.5" {
		t.Fatalf("seek attempts = %v", seeks)
	}
}

func TestFFmpegExtractorRequiresPath(t *testing.T) {
	err := (FFmpegExtractor{}).Extract(context.Background(), "source", "output")
	if err == nil {
		t.Fatalf("error = %v", err)
	}
}

func TestManagerGeneratesJPEGWithProductionFFmpeg(t *testing.T) {
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is not installed")
	}
	cacheDir := t.TempDir()
	source := filepath.Join(t.TempDir(), "source.mp4")
	cmd := exec.Command(
		ffmpegPath,
		"-hide_banner",
		"-loglevel", "error",
		"-f", "lavfi",
		"-i", "color=c=blue:s=64x64:d=1",
		"-c:v", "mpeg4",
		"-y",
		source,
	)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("create fixture: %v: %s", err, output)
	}

	item := video("production", "production-key")
	ready := make(chan struct{}, 1)
	manager, err := NewManager(Options{
		CacheDir: cacheDir,
		Resolver: fakeResolver{path: source},
		Extract:  FFmpegExtractor{Path: ffmpegPath},
		OnReady: func(library.Media) {
			ready <- struct{}{}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()

	if !manager.Enqueue(item) {
		t.Fatal("enqueue rejected")
	}
	select {
	case <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("production ffmpeg thumbnail did not complete")
	}
	data, err := os.ReadFile(manager.Path(item))
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < 3 || data[0] != 0xff || data[1] != 0xd8 ||
		data[len(data)-2] != 0xff || data[len(data)-1] != 0xd9 {
		t.Fatalf("output is not a JPEG: %x", data)
	}
	entries, err := os.ReadDir(cacheDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() == filepath.Base(manager.Path(item)) {
			continue
		}
		t.Fatalf("temporary cache artifact remains: %s", entry.Name())
	}
}
