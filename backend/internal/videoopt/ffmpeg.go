package videoopt

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

const (
	commandTailLimit = 64 << 10
	probeOutputLimit = 4 << 20
)

type FFmpegBuilder struct {
	Path      string
	ProbePath string
	Command   func(context.Context, string, ...string) *exec.Cmd
}

type probeDocument struct {
	Streams  []probeStream  `json:"streams"`
	Chapters []probeChapter `json:"chapters"`
	Format   probeFormat    `json:"format"`
}

type probeStream struct {
	CodecType    string            `json:"codec_type"`
	CodecName    string            `json:"codec_name"`
	Profile      string            `json:"profile"`
	Level        int               `json:"level"`
	PixelFormat  string            `json:"pix_fmt"`
	CodecTag     string            `json:"codec_tag_string"`
	FieldOrder   string            `json:"field_order"`
	AvgFrameRate string            `json:"avg_frame_rate"`
	RFrameRate   string            `json:"r_frame_rate"`
	SampleRate   string            `json:"sample_rate"`
	Channels     int               `json:"channels"`
	Tags         map[string]string `json:"tags"`
}

type probeChapter struct {
	StartTime string            `json:"start_time"`
	EndTime   string            `json:"end_time"`
	Tags      map[string]string `json:"tags"`
}

type probeFormat struct {
	Duration string            `json:"duration"`
	Tags     map[string]string `json:"tags"`
}

func (b FFmpegBuilder) Check(ctx context.Context, source string) error {
	probe, err := b.probe(ctx, source)
	if err != nil {
		return err
	}
	if len(probe.Streams) == 0 {
		return errors.New("ffprobe found no streams")
	}
	for _, stream := range probe.Streams {
		switch stream.CodecType {
		case "video", "audio", "subtitle":
		case "data", "attachment":
			return fmt.Errorf("%w: MP4 stream-copy cannot preserve %s tracks", ErrNotEligible, stream.CodecType)
		default:
			return fmt.Errorf("%w: unsupported stream type %q", ErrNotEligible, stream.CodecType)
		}
	}
	return nil
}

func (b FFmpegBuilder) Build(ctx context.Context, source, output string) error {
	if strings.TrimSpace(b.Path) == "" {
		return errors.New("ffmpeg unavailable")
	}
	if samePath(source, output) {
		return errors.New("faststart source and output must differ")
	}
	before, err := b.probe(ctx, source)
	if err != nil {
		return err
	}
	if err := validateProbeTracks(before); err != nil {
		return err
	}
	command := b.Command
	if command == nil {
		command = exec.CommandContext
	}
	cmd := command(ctx, b.Path,
		"-hide_banner", "-loglevel", "error", "-i", source,
		"-map", "0", "-map_metadata", "0", "-map_chapters", "0",
		"-c", "copy", "-movflags", "+faststart", "-f", "mp4", "-y", output,
	)
	stderr := newTailBuffer(commandTailLimit)
	cmd.Stdout = io.Discard
	cmd.Stderr = stderr
	if runErr := cmd.Run(); runErr != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		return fmt.Errorf("ffmpeg faststart: %w: %s", runErr, stderr.String())
	}
	after, err := b.probe(ctx, output)
	if err != nil {
		return err
	}
	if err := compareProbe(before, after); err != nil {
		return err
	}
	return nil
}

func (b FFmpegBuilder) probe(ctx context.Context, path string) (probeDocument, error) {
	probePath := strings.TrimSpace(b.ProbePath)
	if probePath == "" {
		candidate := filepath.Join(filepath.Dir(b.Path), executableName("ffprobe"))
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			probePath = candidate
		}
	}
	if probePath == "" {
		return probeDocument{}, errors.New("ffprobe unavailable")
	}
	command := b.Command
	if command == nil {
		command = exec.CommandContext
	}
	cmd := command(ctx, probePath,
		"-v", "error", "-show_entries", "stream=codec_type,codec_name,profile,level,pix_fmt,codec_tag_string,field_order,avg_frame_rate,r_frame_rate,sample_rate,channels:stream_tags:format=duration:format_tags:chapter=start_time,end_time:chapter_tags",
		"-of", "json", path,
	)
	stdout := &limitedBuffer{limit: probeOutputLimit}
	stderr := newTailBuffer(commandTailLimit)
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if runErr := cmd.Run(); runErr != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return probeDocument{}, ctxErr
		}
		return probeDocument{}, fmt.Errorf("ffprobe: %w: %s", runErr, stderr.String())
	}
	if stdout.overflow {
		return probeDocument{}, errors.New("ffprobe output exceeded bounded limit")
	}
	var document probeDocument
	if err := json.Unmarshal(stdout.Bytes(), &document); err != nil {
		return probeDocument{}, fmt.Errorf("parse ffprobe output: %w", err)
	}
	return document, nil
}

func validateProbeTracks(probe probeDocument) error {
	if len(probe.Streams) == 0 {
		return errors.New("ffprobe found no streams")
	}
	for _, stream := range probe.Streams {
		switch stream.CodecType {
		case "video", "audio", "subtitle":
		case "data", "attachment":
			return fmt.Errorf("%w: MP4 stream-copy cannot preserve %s tracks", ErrNotEligible, stream.CodecType)
		default:
			return fmt.Errorf("%w: unsupported stream type %q", ErrNotEligible, stream.CodecType)
		}
	}
	return nil
}

func compareProbe(before, after probeDocument) error {
	if len(before.Streams) != len(after.Streams) {
		return fmt.Errorf("stream count changed from %d to %d", len(before.Streams), len(after.Streams))
	}
	for index := range before.Streams {
		if before.Streams[index].CodecType != after.Streams[index].CodecType || before.Streams[index].CodecName != after.Streams[index].CodecName {
			return fmt.Errorf("stream %d changed during faststart", index)
		}
		if err := comparePreservedTags(before.Streams[index].Tags, after.Streams[index].Tags); err != nil {
			return fmt.Errorf("stream %d metadata: %w", index, err)
		}
	}
	if len(before.Chapters) != len(after.Chapters) {
		return fmt.Errorf("chapter count changed from %d to %d", len(before.Chapters), len(after.Chapters))
	}
	for index := range before.Chapters {
		if !durationNear(before.Chapters[index].StartTime, after.Chapters[index].StartTime) || !durationNear(before.Chapters[index].EndTime, after.Chapters[index].EndTime) {
			return fmt.Errorf("chapter %d timing changed", index)
		}
		if err := comparePreservedTags(before.Chapters[index].Tags, after.Chapters[index].Tags); err != nil {
			return fmt.Errorf("chapter %d metadata: %w", index, err)
		}
	}
	if err := comparePreservedTags(before.Format.Tags, after.Format.Tags); err != nil {
		return fmt.Errorf("format metadata: %w", err)
	}
	beforeDuration, beforeOK := parseDuration(before.Format.Duration)
	afterDuration, afterOK := parseDuration(after.Format.Duration)
	if beforeOK && afterOK && math.Abs(beforeDuration-afterDuration) > 0.5 {
		return fmt.Errorf("duration changed from %.3f to %.3f", beforeDuration, afterDuration)
	}
	return nil
}

var preservedMetadataKeys = map[string]struct{}{
	"title": {}, "artist": {}, "album": {}, "album_artist": {}, "comment": {},
	"description": {}, "genre": {}, "date": {}, "creation_time": {}, "language": {},
}

func comparePreservedTags(before, after map[string]string) error {
	for key, value := range before {
		if _, required := preservedMetadataKeys[strings.ToLower(key)]; required && after[key] != value {
			return fmt.Errorf("tag %q changed", key)
		}
	}
	return nil
}

func durationNear(first, second string) bool {
	a, aOK := parseDuration(first)
	b, bOK := parseDuration(second)
	return !aOK || !bOK || math.Abs(a-b) <= 0.01
}

func parseDuration(value string) (float64, bool) {
	duration, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	return duration, err == nil && !math.IsNaN(duration) && !math.IsInf(duration, 0)
}

func samePath(first, second string) bool {
	firstAbs, firstErr := filepath.Abs(first)
	secondAbs, secondErr := filepath.Abs(second)
	if firstErr == nil && secondErr == nil && filepath.Clean(firstAbs) == filepath.Clean(secondAbs) {
		return true
	}
	firstInfo, firstErr := os.Stat(first)
	secondInfo, secondErr := os.Stat(second)
	return firstErr == nil && secondErr == nil && os.SameFile(firstInfo, secondInfo)
}

func executableName(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

type tailBuffer struct {
	limit int
	data  []byte
}

func newTailBuffer(limit int) *tailBuffer { return &tailBuffer{limit: limit} }
func (b *tailBuffer) Write(data []byte) (int, error) {
	original := len(data)
	if len(data) >= b.limit {
		b.data = append(b.data[:0], data[len(data)-b.limit:]...)
		return original, nil
	}
	if overflow := len(b.data) + len(data) - b.limit; overflow > 0 {
		copy(b.data, b.data[overflow:])
		b.data = b.data[:len(b.data)-overflow]
	}
	b.data = append(b.data, data...)
	return original, nil
}
func (b *tailBuffer) String() string { return strings.TrimSpace(string(b.data)) }

type limitedBuffer struct {
	bytes.Buffer
	limit    int
	overflow bool
}

func (b *limitedBuffer) Write(data []byte) (int, error) {
	original := len(data)
	remaining := b.limit - b.Len()
	if remaining <= 0 {
		b.overflow = true
		return original, nil
	}
	if len(data) > remaining {
		b.overflow = true
		data = data[:remaining]
	}
	_, _ = b.Buffer.Write(data)
	return original, nil
}
