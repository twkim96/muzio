package videoopt

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const HLSCacheKind = "hls-fmp4"

type HLSPlanOptions struct {
	MinimumMovieIndexBytes int64
	MaximumGOPSeconds      float64
	TargetSegmentSeconds   float64
	ExistingCacheBytes     int64
}

type DurationStats struct {
	Count  int     `json:"count"`
	Min    float64 `json:"min"`
	Median float64 `json:"median"`
	P95    float64 `json:"p95"`
	Max    float64 `json:"max"`
}

type HLSPlan struct {
	Eligible             bool          `json:"eligible"`
	Reason               string        `json:"reason,omitempty"`
	CacheKind            string        `json:"cacheKind"`
	Layout               Layout        `json:"layout"`
	MovieIndexBytes      int64         `json:"movieIndexBytes"`
	SourceBytes          int64         `json:"sourceBytes"`
	EstimatedOutputBytes int64         `json:"estimatedOutputBytes"`
	RequiredFreeBytes    int64         `json:"requiredFreeBytes"`
	PeakCacheBytes       int64         `json:"peakCacheBytes"`
	DurationSeconds      float64       `json:"durationSeconds"`
	VideoCodec           string        `json:"videoCodec,omitempty"`
	AudioCodec           string        `json:"audioCodec,omitempty"`
	TargetSegmentSeconds float64       `json:"targetSegmentSeconds"`
	GOP                  DurationStats `json:"gop"`
}

type HLSPlanner struct {
	Probe   FFmpegBuilder
	Options HLSPlanOptions
}

type keyframeProbeDocument struct {
	Frames []struct {
		Timestamp string `json:"best_effort_timestamp_time"`
	} `json:"frames"`
}

func (p HLSPlanner) Plan(ctx context.Context, source string) (HLSPlan, error) {
	if err := validateHLSPlanOptions(p.Options); err != nil {
		return HLSPlan{}, err
	}
	file, err := os.Open(source)
	if err != nil {
		return HLSPlan{}, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return HLSPlan{}, err
	}
	inspection, inspectErr := InspectMP4(file, info.Size())
	_ = file.Close()
	if inspectErr != nil {
		return HLSPlan{}, inspectErr
	}
	base := newHLSPlan(inspection, info.Size(), p.Options)
	if reason := hlsContainerIneligibleReason(inspection, p.Options); reason != "" {
		base.Reason = reason
		return base, nil
	}
	probe, err := p.Probe.probe(ctx, source)
	if err != nil {
		return HLSPlan{}, err
	}
	if reason := hlsTrackIneligibleReason(probe); reason != "" {
		base.Reason = reason
		populateHLSCodecs(&base, probe)
		return base, nil
	}
	keyframes, err := p.probeKeyframes(ctx, source)
	if err != nil {
		return HLSPlan{}, err
	}
	return evaluateHLSPlan(inspection, info.Size(), probe, keyframes, p.Options), nil
}

func evaluateHLSPlan(
	inspection Inspection,
	sourceBytes int64,
	probe probeDocument,
	keyframes []float64,
	options HLSPlanOptions,
) HLSPlan {
	plan := newHLSPlan(inspection, sourceBytes, options)
	populateHLSCodecs(&plan, probe)
	if reason := hlsContainerIneligibleReason(inspection, options); reason != "" {
		plan.Reason = reason
		return plan
	}
	if reason := hlsTrackIneligibleReason(probe); reason != "" {
		plan.Reason = reason
		return plan
	}
	duration, ok := parseDuration(probe.Format.Duration)
	if !ok || duration <= 0 {
		plan.Reason = "media duration is unavailable"
		return plan
	}
	plan.DurationSeconds = duration
	segments, reason := segmentDurationsFromKeyframes(keyframes, duration)
	if reason != "" {
		plan.Reason = reason
		return plan
	}
	plan.GOP = summarizeDurations(segments)
	if plan.GOP.Max > options.MaximumGOPSeconds {
		plan.Reason = fmt.Sprintf("copy packaging unsuitable: keyframe gap %.3fs exceeds measured limit %.3fs", plan.GOP.Max, options.MaximumGOPSeconds)
		return plan
	}
	plan.Eligible = true
	return plan
}

func newHLSPlan(inspection Inspection, sourceBytes int64, options HLSPlanOptions) HLSPlan {
	movieBytes := int64(0)
	if inspection.Movie != nil {
		movieBytes = inspection.Movie.Size
	}
	estimatedOutput := sourceBytes
	return HLSPlan{
		CacheKind:            HLSCacheKind,
		Layout:               inspection.Layout,
		MovieIndexBytes:      movieBytes,
		SourceBytes:          sourceBytes,
		EstimatedOutputBytes: estimatedOutput,
		RequiredFreeBytes:    saturatingAdd(estimatedOutput, spaceMargin(estimatedOutput)),
		PeakCacheBytes:       saturatingAdd(options.ExistingCacheBytes, estimatedOutput),
		TargetSegmentSeconds: options.TargetSegmentSeconds,
	}
}

func validateHLSPlanOptions(options HLSPlanOptions) error {
	if options.MinimumMovieIndexBytes <= 0 {
		return errors.New("HLS movie-index threshold requires measured evidence")
	}
	if options.MaximumGOPSeconds <= 0 || math.IsNaN(options.MaximumGOPSeconds) || math.IsInf(options.MaximumGOPSeconds, 0) {
		return errors.New("HLS maximum GOP duration requires measured evidence")
	}
	if options.TargetSegmentSeconds <= 0 || math.IsNaN(options.TargetSegmentSeconds) || math.IsInf(options.TargetSegmentSeconds, 0) {
		return errors.New("HLS target segment duration is required")
	}
	if options.ExistingCacheBytes < 0 {
		return errors.New("existing cache bytes cannot be negative")
	}
	return nil
}

func hlsContainerIneligibleReason(inspection Inspection, options HLSPlanOptions) string {
	switch inspection.Layout {
	case LayoutFragmented:
		return "already fragmented media does not need HLS repackaging"
	case LayoutFrontMoov:
		if inspection.Movie == nil || inspection.Movie.Size < options.MinimumMovieIndexBytes {
			return "front movie index is below the measured HLS threshold"
		}
		return ""
	case LayoutEndMoov:
		return "end-moov media should use the faststart sidecar"
	default:
		return "unsupported MP4 layout"
	}
}

func hlsTrackIneligibleReason(probe probeDocument) string {
	videoCount, audioCount := 0, 0
	for _, stream := range probe.Streams {
		switch stream.CodecType {
		case "video":
			videoCount++
			if stream.CodecName != "h264" {
				return "HLS copy packaging requires H.264 video"
			}
			if reason := hlsVideoCompatibilityReason(stream); reason != "" {
				return reason
			}
		case "audio":
			audioCount++
			if stream.CodecName != "aac" {
				return "HLS copy packaging requires AAC audio"
			}
			if reason := hlsAudioCompatibilityReason(stream); reason != "" {
				return reason
			}
		case "subtitle":
			return "embedded subtitles are not supported by the HLS sidecar"
		default:
			return fmt.Sprintf("%s tracks are not supported by the HLS sidecar", stream.CodecType)
		}
	}
	if videoCount != 1 {
		return fmt.Sprintf("HLS copy packaging requires exactly one video track; found %d", videoCount)
	}
	if audioCount > 1 {
		return fmt.Sprintf("HLS copy packaging supports at most one audio track; found %d", audioCount)
	}
	if len(probe.Chapters) > 0 {
		return "chapters cannot be preserved by the initial HLS sidecar"
	}
	return ""
}

func hlsVideoCompatibilityReason(stream probeStream) string {
	switch stream.Profile {
	case "Constrained Baseline", "Baseline", "Main", "High":
	default:
		return fmt.Sprintf("HLS copy packaging does not support H.264 profile %q", stream.Profile)
	}
	if stream.Level <= 0 || stream.Level > 51 {
		return fmt.Sprintf("HLS copy packaging does not support H.264 level %d", stream.Level)
	}
	if stream.PixelFormat != "yuv420p" && stream.PixelFormat != "yuvj420p" {
		return fmt.Sprintf("HLS copy packaging requires 8-bit 4:2:0 H.264; found %q", stream.PixelFormat)
	}
	if stream.FieldOrder != "progressive" {
		return fmt.Sprintf("HLS copy packaging requires progressive H.264; found field order %q", stream.FieldOrder)
	}
	for _, field := range []struct{ label, value string }{
		{label: "average", value: stream.AvgFrameRate},
		{label: "nominal", value: stream.RFrameRate},
	} {
		frameRate, ok := parseFrameRate(field.value)
		if !ok || frameRate > 60 {
			return fmt.Sprintf("HLS copy packaging requires a valid %s frame rate at or below 60fps; found %q", field.label, field.value)
		}
	}
	if stream.CodecTag != "avc1" {
		return fmt.Sprintf("HLS copy packaging requires an avc1 codec tag; found %q", stream.CodecTag)
	}
	return ""
}

func hlsAudioCompatibilityReason(stream probeStream) string {
	switch stream.Profile {
	case "LC", "HE-AAC":
		if stream.Channels < 1 || stream.Channels > 2 {
			return fmt.Sprintf("HLS copy packaging supports %s only with 1 or 2 channels; found %d", stream.Profile, stream.Channels)
		}
	case "HE-AACv2":
		if stream.Channels != 2 {
			return fmt.Sprintf("HLS copy packaging requires stereo HE-AACv2; found %d channels", stream.Channels)
		}
	default:
		return fmt.Sprintf("HLS copy packaging does not support AAC profile %q", stream.Profile)
	}
	sampleRate, err := strconv.Atoi(strings.TrimSpace(stream.SampleRate))
	if err != nil || sampleRate < 8000 || sampleRate > 96000 {
		return fmt.Sprintf("HLS copy packaging does not support AAC sample rate %q", stream.SampleRate)
	}
	if stream.CodecTag != "mp4a" {
		return fmt.Sprintf("HLS copy packaging requires an mp4a codec tag; found %q", stream.CodecTag)
	}
	return ""
}

func parseFrameRate(value string) (float64, bool) {
	value = strings.TrimSpace(value)
	parts := strings.Split(value, "/")
	if len(parts) == 1 {
		rate, err := strconv.ParseFloat(parts[0], 64)
		return rate, err == nil && rate > 0 && !math.IsNaN(rate) && !math.IsInf(rate, 0)
	}
	if len(parts) != 2 {
		return 0, false
	}
	numerator, numeratorErr := strconv.ParseFloat(parts[0], 64)
	denominator, denominatorErr := strconv.ParseFloat(parts[1], 64)
	if numeratorErr != nil || denominatorErr != nil || numerator <= 0 || denominator <= 0 {
		return 0, false
	}
	rate := numerator / denominator
	return rate, rate > 0 && !math.IsNaN(rate) && !math.IsInf(rate, 0)
}

func populateHLSCodecs(plan *HLSPlan, probe probeDocument) {
	for _, stream := range probe.Streams {
		switch stream.CodecType {
		case "video":
			if plan.VideoCodec == "" {
				plan.VideoCodec = stream.CodecName
			}
		case "audio":
			if plan.AudioCodec == "" {
				plan.AudioCodec = stream.CodecName
			}
		}
	}
}

func (p HLSPlanner) probeKeyframes(ctx context.Context, source string) ([]float64, error) {
	probePath := strings.TrimSpace(p.Probe.ProbePath)
	if probePath == "" {
		candidate := filepath.Join(filepath.Dir(p.Probe.Path), executableName("ffprobe"))
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			probePath = candidate
		}
	}
	if probePath == "" {
		return nil, errors.New("ffprobe unavailable")
	}
	command := p.Probe.Command
	if command == nil {
		command = exec.CommandContext
	}
	cmd := command(ctx, probePath,
		"-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
		"-show_frames", "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", source,
	)
	stdout := &limitedBuffer{limit: probeOutputLimit}
	stderr := newTailBuffer(commandTailLimit)
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if runErr := cmd.Run(); runErr != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		return nil, fmt.Errorf("ffprobe keyframes: %w: %s", runErr, stderr.String())
	}
	if stdout.overflow {
		return nil, errors.New("ffprobe keyframe output exceeded bounded limit")
	}
	var document keyframeProbeDocument
	if err := json.Unmarshal(stdout.Bytes(), &document); err != nil {
		return nil, fmt.Errorf("parse ffprobe keyframes: %w", err)
	}
	keyframes := make([]float64, 0, len(document.Frames))
	for _, frame := range document.Frames {
		value, err := strconv.ParseFloat(strings.TrimSpace(frame.Timestamp), 64)
		if err == nil && value >= 0 && !math.IsNaN(value) && !math.IsInf(value, 0) {
			keyframes = append(keyframes, value)
		}
	}
	sort.Float64s(keyframes)
	return deduplicateTimestamps(keyframes), nil
}

func segmentDurationsFromKeyframes(keyframes []float64, duration float64) ([]float64, string) {
	if len(keyframes) == 0 {
		return nil, "copy packaging unsuitable: no video keyframes found"
	}
	keyframes = append([]float64(nil), keyframes...)
	sort.Float64s(keyframes)
	keyframes = deduplicateTimestamps(keyframes)
	if keyframes[0] > 0.5 {
		return nil, "copy packaging unsuitable: first random access point is not near zero"
	}
	segments := make([]float64, 0, len(keyframes))
	previous := keyframes[0]
	for _, timestamp := range keyframes[1:] {
		if timestamp >= duration {
			break
		}
		if gap := timestamp - previous; gap > 0 {
			segments = append(segments, gap)
		}
		previous = timestamp
	}
	if tail := duration - previous; tail > 0.001 {
		segments = append(segments, tail)
	}
	if len(segments) == 0 {
		return nil, "copy packaging unsuitable: keyframe intervals are unavailable"
	}
	return segments, ""
}

func deduplicateTimestamps(values []float64) []float64 {
	result := values[:0]
	for _, value := range values {
		if len(result) == 0 || value-result[len(result)-1] > 0.000001 {
			result = append(result, value)
		}
	}
	return result
}

func summarizeDurations(values []float64) DurationStats {
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	count := len(sorted)
	stats := DurationStats{Count: count, Min: sorted[0], Max: sorted[count-1]}
	if count%2 == 0 {
		stats.Median = (sorted[count/2-1] + sorted[count/2]) / 2
	} else {
		stats.Median = sorted[count/2]
	}
	p95Index := int(math.Ceil(float64(count)*0.95)) - 1
	if p95Index < 0 {
		p95Index = 0
	}
	stats.P95 = sorted[p95Index]
	return stats
}

func saturatingAdd(first, second int64) int64 {
	if second > 0 && first > math.MaxInt64-second {
		return math.MaxInt64
	}
	return first + second
}
