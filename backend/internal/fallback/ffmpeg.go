package fallback

import (
	"context"
	"os/exec"
	"strings"
	"sync"
	"time"
)

type FFmpegInfo struct {
	Available bool   `json:"available"`
	Path      string `json:"path,omitempty"`
	Version   string `json:"version,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

type Detector interface {
	Detect(ctx context.Context) FFmpegInfo
}

type SystemFFmpegDetector struct {
	LookupPath func(string) (string, error)
	Command    func(context.Context, string, ...string) *exec.Cmd
	Timeout    time.Duration

	once sync.Once
	info FFmpegInfo
}

func (d *SystemFFmpegDetector) Detect(ctx context.Context) FFmpegInfo {
	d.once.Do(func() {
		d.info = d.detect(ctx)
	})
	return d.info
}

func (d *SystemFFmpegDetector) detect(ctx context.Context) FFmpegInfo {
	lookupPath := d.LookupPath
	if lookupPath == nil {
		lookupPath = exec.LookPath
	}
	path, err := lookupPath("ffmpeg")
	if err != nil {
		return FFmpegInfo{Available: false, Reason: "ffmpeg not found in PATH"}
	}

	timeout := d.Timeout
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	command := d.Command
	if command == nil {
		command = exec.CommandContext
	}
	output, err := command(ctx, path, "-version").Output()
	if err != nil {
		return FFmpegInfo{
			Available: false,
			Path:      path,
			Reason:    "ffmpeg -version failed",
		}
	}
	version := firstLine(string(output))
	return FFmpegInfo{
		Available: true,
		Path:      path,
		Version:   version,
	}
}

func firstLine(value string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(value), "\n")
	return line
}
