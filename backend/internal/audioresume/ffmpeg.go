package audioresume

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
)

type FFmpegRemuxer struct {
	Path    string
	Command func(context.Context, string, ...string) *exec.Cmd
}

func (r FFmpegRemuxer) Remux(ctx context.Context, source, output string) error {
	if r.Path == "" {
		return errors.New("ffmpeg unavailable")
	}
	command := r.Command
	if command == nil {
		command = exec.CommandContext
	}
	cmd := command(
		ctx,
		r.Path,
		"-hide_banner",
		"-loglevel", "error",
		"-i", source,
		"-map", "0:a:0",
		"-map_metadata", "0",
		"-c:a", "copy",
		"-movflags", "+faststart",
		"-f", "mp4",
		"-y",
		output,
	)
	if combined, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg audio remux: %w: %s", err, combined)
	}
	return nil
}
