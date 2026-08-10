package thumbnail

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

type FFmpegExtractor struct {
	Path    string
	Command func(context.Context, string, ...string) *exec.Cmd
}

// FFmpegArtworkExtractor decodes the first embedded picture stream from an
// audio container. It deliberately omits seeking: attached pictures are static
// streams and some containers do not expose them after a timestamp seek.
type FFmpegArtworkExtractor struct {
	Path    string
	Command func(context.Context, string, ...string) *exec.Cmd
}

var ErrArtworkUnavailable = errors.New("embedded artwork unavailable")

func (e FFmpegArtworkExtractor) Extract(ctx context.Context, source, output string) error {
	if e.Path == "" {
		return fmt.Errorf("ffmpeg unavailable")
	}
	if err := os.Remove(output); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove previous artwork output: %w", err)
	}
	command := e.Command
	if command == nil {
		command = exec.CommandContext
	}
	cmd := command(
		ctx,
		e.Path,
		"-hide_banner",
		"-loglevel", "error",
		"-threads", "1",
		"-i", source,
		"-map", "0:v:0",
		"-frames:v", "1",
		"-vf", "scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p",
		"-c:v", "mjpeg",
		"-q:v", "3",
		"-an",
		"-f", "image2",
		"-y",
		output,
	)
	if outputBytes, err := cmd.CombinedOutput(); err != nil {
		if strings.Contains(strings.ToLower(string(outputBytes)), "matches no streams") {
			return fmt.Errorf("%w: %s", ErrArtworkUnavailable, outputBytes)
		}
		return fmt.Errorf("ffmpeg artwork extraction: %w: %s", err, outputBytes)
	}
	info, err := os.Stat(output)
	if err != nil {
		return fmt.Errorf("ffmpeg artwork output: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() == 0 {
		return fmt.Errorf("ffmpeg artwork output is empty")
	}
	return nil
}

func (e FFmpegExtractor) Extract(ctx context.Context, source, output string) error {
	if e.Path == "" {
		return fmt.Errorf("ffmpeg unavailable")
	}
	if err := e.extractAt(ctx, source, output, "10"); err == nil {
		return nil
	}
	return e.extractAt(ctx, source, output, "0.5")
}

func (e FFmpegExtractor) extractAt(
	ctx context.Context,
	source string,
	output string,
	seek string,
) error {
	command := e.Command
	if command == nil {
		command = exec.CommandContext
	}
	if err := os.Remove(output); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove previous thumbnail output: %w", err)
	}
	cmd := command(
		ctx,
		e.Path,
		"-hide_banner",
		"-loglevel", "error",
		"-threads", "1",
		"-ss", seek,
		"-i", source,
		"-map", "0:v:0",
		"-frames:v", "1",
		"-vf", "scale=320:180:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p",
		"-c:v", "mjpeg",
		"-q:v", "4",
		"-an",
		"-f", "image2",
		"-y",
		output,
	)
	if outputBytes, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg frame extraction: %w: %s", err, outputBytes)
	}
	info, err := os.Stat(output)
	if err != nil {
		return fmt.Errorf("ffmpeg frame output: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() == 0 {
		return fmt.Errorf("ffmpeg frame output is empty")
	}
	return nil
}
