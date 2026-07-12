package fallback

import (
	"context"
	"net/url"
	"path/filepath"
	"strings"

	"muzio/backend/internal/library"
)

type Action string

const (
	ActionDirect         Action = "direct"
	ActionRemux          Action = "remux"
	ActionAudioTranscode Action = "audio_transcode"
	ActionVideoTranscode Action = "video_transcode"
	ActionDisabled       Action = "disabled"
)

type BrowserSupport string

const (
	BrowserSupportUnknown  BrowserSupport = "unknown"
	BrowserSupportNo       BrowserSupport = "no"
	BrowserSupportMaybe    BrowserSupport = "maybe"
	BrowserSupportProbably BrowserSupport = "probably"
)

type Limits struct {
	MaxConcurrentJobs int   `json:"maxConcurrentJobs"`
	MaxInputBytes     int64 `json:"maxInputBytes"`
	JobTimeoutSeconds int   `json:"jobTimeoutSeconds"`
}

type Policy struct {
	SystemFFmpegPreferred bool   `json:"systemFfmpegPreferred"`
	NativeBundling        string `json:"nativeBundling"`
	Docker                string `json:"docker"`
	Remux                 string `json:"remux"`
	Transcode             string `json:"transcode"`
	Limits                Limits `json:"limits"`
}

type Plan struct {
	MediaID        string         `json:"mediaId"`
	MIMEType       string         `json:"mimeType"`
	BrowserSupport BrowserSupport `json:"browserSupport"`
	Action         Action         `json:"action"`
	Status         string         `json:"status"`
	Reason         string         `json:"reason"`
	DirectURL      string         `json:"directUrl"`
	FFmpeg         FFmpegInfo     `json:"ffmpeg"`
	Policy         Policy         `json:"policy"`
}

type Planner struct {
	Detector Detector
	Limits   Limits
}

func DefaultPolicy(limits Limits) Policy {
	if limits.MaxConcurrentJobs <= 0 {
		limits.MaxConcurrentJobs = 1
	}
	if limits.MaxInputBytes <= 0 {
		limits.MaxInputBytes = 8 << 30
	}
	if limits.JobTimeoutSeconds <= 0 {
		limits.JobTimeoutSeconds = 30 * 60
	}
	return Policy{
		SystemFFmpegPreferred: true,
		NativeBundling:        "disabled until a license and codec-distribution decision is recorded",
		Docker:                "allowed when the image documents the package source and ffmpeg license",
		Remux:                 "container-only remux is preferred before any transcode",
		Transcode:             "audio transcode precedes video transcode; CPU-heavy jobs stay bounded",
		Limits:                limits,
	}
}

func (p Planner) Plan(ctx context.Context, media library.Media, support BrowserSupport) Plan {
	if support == "" {
		support = BrowserSupportUnknown
	}
	policy := DefaultPolicy(p.Limits)
	plan := Plan{
		MediaID:        media.ID,
		MIMEType:       media.MIMEType,
		BrowserSupport: support,
		Action:         ActionDirect,
		Status:         "direct",
		Reason:         "direct play remains the default",
		DirectURL:      "/api/media/" + url.PathEscape(media.ID),
		FFmpeg:         FFmpegInfo{Available: false, Reason: "ffmpeg detection not configured"},
		Policy:         policy,
	}
	if support != BrowserSupportNo {
		return plan
	}

	ffmpeg := FFmpegInfo{Available: false, Reason: "ffmpeg detection not configured"}
	if p.Detector != nil {
		ffmpeg = p.Detector.Detect(ctx)
	}
	plan.FFmpeg = ffmpeg
	if !ffmpeg.Available {
		plan.Action = ActionDisabled
		plan.Status = "disabled"
		plan.Reason = "browser reported unsupported media and ffmpeg is unavailable"
		return plan
	}

	plan.Action = fallbackAction(media)
	plan.Status = "available"
	switch plan.Action {
	case ActionRemux:
		plan.Reason = "container fallback can try remux before transcode"
	case ActionAudioTranscode:
		plan.Reason = "audio fallback requires a bounded transcode job"
	case ActionVideoTranscode:
		plan.Reason = "video fallback requires the highest-cost bounded transcode job"
	default:
		plan.Action = ActionDisabled
		plan.Status = "disabled"
		plan.Reason = "no fallback strategy for this media type"
	}
	return plan
}

func NormalizeBrowserSupport(value string) BrowserSupport {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "no":
		return BrowserSupportNo
	case "maybe":
		return BrowserSupportMaybe
	case "probably":
		return BrowserSupportProbably
	default:
		return BrowserSupportUnknown
	}
}

func fallbackAction(media library.Media) Action {
	ext := strings.ToLower(filepath.Ext(media.Name))
	if media.Type == library.MediaTypeAudio {
		return ActionAudioTranscode
	}
	if media.Type != library.MediaTypeVideo {
		return ActionDisabled
	}
	switch ext {
	case ".mkv", ".avi", ".mov", ".ts", ".mpg", ".mpeg":
		return ActionRemux
	default:
		return ActionVideoTranscode
	}
}
