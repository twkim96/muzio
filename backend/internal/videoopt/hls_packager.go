package videoopt

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

const (
	hlsManifestName = "index.m3u8"
	hlsInitName     = "init.mp4"
)

var hlsSegmentNamePattern = regexp.MustCompile(`^seg-[0-9]{6}\.m4s$`)

type HLSAsset struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Kind string `json:"kind"`
}

type HLSPackageResult struct {
	ManifestName         string              `json:"manifestName"`
	Assets               map[string]HLSAsset `json:"assets"`
	OutputBytes          int64               `json:"outputBytes"`
	SegmentCount         int                 `json:"segmentCount"`
	SegmentDuration      DurationStats       `json:"segmentDuration"`
	RandomAccessVerified bool                `json:"randomAccessVerified"`
	IndependentSegments  bool                `json:"independentSegments"`
	segmentDurations     []float64
}

type HLSBuilder interface {
	Plan(context.Context, string) (HLSPlan, error)
	Build(context.Context, string, string, HLSPlan, func(float64)) (HLSPackageResult, error)
}

type FFmpegHLSPackager struct {
	Planner  HLSPlanner
	Command  func(context.Context, string, ...string) *exec.Cmd
	SyncFile func(string) error
}

func (p FFmpegHLSPackager) Plan(ctx context.Context, source string) (HLSPlan, error) {
	return p.Planner.Plan(ctx, source)
}

func (p FFmpegHLSPackager) Build(ctx context.Context, source, outputDir string, plan HLSPlan, onProgress func(float64)) (HLSPackageResult, error) {
	if !plan.Eligible || plan.CacheKind != HLSCacheKind {
		return HLSPackageResult{}, errors.New("HLS package requires an eligible plan")
	}
	ffmpegPath := strings.TrimSpace(p.Planner.Probe.Path)
	if ffmpegPath == "" {
		return HLSPackageResult{}, errors.New("ffmpeg unavailable")
	}
	if strings.TrimSpace(outputDir) == "" {
		return HLSPackageResult{}, errors.New("HLS output directory is required")
	}
	sourcePath, err := filepath.Abs(source)
	if err != nil {
		return HLSPackageResult{}, fmt.Errorf("resolve HLS source path: %w", err)
	}
	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		return HLSPackageResult{}, fmt.Errorf("create HLS output directory: %w", err)
	}
	command := p.Command
	if command == nil {
		command = p.Planner.Probe.Command
	}
	if command == nil {
		command = exec.CommandContext
	}
	target := strconv.FormatFloat(plan.TargetSegmentSeconds, 'f', 3, 64)
	cmd := command(ctx, ffmpegPath,
		"-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats", "-i", sourcePath,
		"-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
		"-f", "hls", "-hls_segment_type", "fmp4",
		"-hls_time", target, "-hls_playlist_type", "vod",
		"-hls_fmp4_init_filename", hlsInitName,
		"-hls_segment_filename", "seg-%06d.m4s",
		"-start_number", "0", "-y", hlsManifestName,
	)
	cmd.Dir = outputDir
	stderr := newTailBuffer(commandTailLimit)
	cmd.Stdout = &ffmpegProgressWriter{durationSeconds: plan.DurationSeconds, onProgress: onProgress}
	cmd.Stderr = stderr
	if runErr := cmd.Run(); runErr != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return HLSPackageResult{}, ctxErr
		}
		return HLSPackageResult{}, fmt.Errorf("ffmpeg HLS package: %w: %s", runErr, stderr.String())
	}
	if err := ctx.Err(); err != nil {
		return HLSPackageResult{}, err
	}
	result, err := validateHLSPackageContext(ctx, outputDir, plan)
	if err != nil {
		return HLSPackageResult{}, err
	}
	if err := ctx.Err(); err != nil {
		return HLSPackageResult{}, err
	}
	packagedProbe, err := p.Planner.Probe.probe(ctx, filepath.Join(outputDir, hlsManifestName))
	if err != nil {
		return HLSPackageResult{}, fmt.Errorf("probe HLS package: %w", err)
	}
	if err := validatePackagedHLSProbe(packagedProbe, plan); err != nil {
		return HLSPackageResult{}, err
	}
	if err := ctx.Err(); err != nil {
		return HLSPackageResult{}, err
	}
	packagedKeyframes, err := p.Planner.probeKeyframes(ctx, filepath.Join(outputDir, hlsManifestName))
	if err != nil {
		return HLSPackageResult{}, fmt.Errorf("probe HLS random access points: %w", err)
	}
	if err := verifyHLSSegmentRandomAccess(result.segmentDurations, packagedKeyframes); err != nil {
		return HLSPackageResult{}, err
	}
	if err := ctx.Err(); err != nil {
		return HLSPackageResult{}, err
	}
	result.RandomAccessVerified = true
	syncFile := p.SyncFile
	if syncFile == nil {
		syncFile = syncWritableFile
	}
	for name := range result.Assets {
		if err := ctx.Err(); err != nil {
			return HLSPackageResult{}, err
		}
		if err := syncFile(filepath.Join(outputDir, name)); err != nil {
			return HLSPackageResult{}, err
		}
	}
	if err := ctx.Err(); err != nil {
		return HLSPackageResult{}, err
	}
	if err := syncDirectory(outputDir); err != nil {
		return HLSPackageResult{}, err
	}
	if err := ctx.Err(); err != nil {
		return HLSPackageResult{}, err
	}
	if onProgress != nil {
		onProgress(1)
	}
	return result, nil
}

func syncWritableFile(path string) error {
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	syncErr := file.Sync()
	closeErr := file.Close()
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

type ffmpegProgressWriter struct {
	mu              sync.Mutex
	partial         string
	durationSeconds float64
	onProgress      func(float64)
}

func (w *ffmpegProgressWriter) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.partial += string(data)
	for {
		newline := strings.IndexByte(w.partial, '\n')
		if newline < 0 {
			if len(w.partial) > 4096 {
				w.partial = w.partial[len(w.partial)-4096:]
			}
			break
		}
		line := strings.TrimSpace(w.partial[:newline])
		w.partial = w.partial[newline+1:]
		if !strings.HasPrefix(line, "out_time_us=") || w.durationSeconds <= 0 || w.onProgress == nil {
			continue
		}
		microseconds, err := strconv.ParseFloat(strings.TrimPrefix(line, "out_time_us="), 64)
		if err != nil || microseconds < 0 {
			continue
		}
		progress := microseconds / 1_000_000 / w.durationSeconds
		if progress > 0.99 {
			progress = 0.99
		}
		w.onProgress(progress)
	}
	return len(data), nil
}

func verifyHLSSegmentRandomAccess(segmentDurations, keyframes []float64) error {
	if len(segmentDurations) == 0 || len(keyframes) == 0 {
		return errors.New("HLS random access points are unavailable")
	}
	const tolerance = 0.5
	boundary := 0.0
	keyframeIndex := 0
	for segmentIndex := range segmentDurations {
		for keyframeIndex+1 < len(keyframes) && math.Abs(keyframes[keyframeIndex+1]-boundary) <= math.Abs(keyframes[keyframeIndex]-boundary) {
			keyframeIndex++
		}
		if math.Abs(keyframes[keyframeIndex]-boundary) > tolerance {
			return fmt.Errorf("HLS segment %d does not start at a verified random access point", segmentIndex)
		}
		boundary += segmentDurations[segmentIndex]
	}
	return nil
}

func validatePackagedHLSProbe(probe probeDocument, plan HLSPlan) error {
	videoCount, audioCount := 0, 0
	for _, stream := range probe.Streams {
		switch stream.CodecType {
		case "video":
			videoCount++
			if stream.CodecName != plan.VideoCodec {
				return fmt.Errorf("HLS video codec changed from %s to %s", plan.VideoCodec, stream.CodecName)
			}
		case "audio":
			audioCount++
			if stream.CodecName != plan.AudioCodec {
				return fmt.Errorf("HLS audio codec changed from %s to %s", plan.AudioCodec, stream.CodecName)
			}
		default:
			return fmt.Errorf("HLS package contains unsupported %s track", stream.CodecType)
		}
	}
	if videoCount != 1 {
		return fmt.Errorf("HLS package contains %d video tracks", videoCount)
	}
	wantAudio := 0
	if plan.AudioCodec != "" {
		wantAudio = 1
	}
	if audioCount != wantAudio {
		return fmt.Errorf("HLS package contains %d audio tracks; want %d", audioCount, wantAudio)
	}
	if duration, ok := parseDuration(probe.Format.Duration); ok && plan.DurationSeconds > 0 {
		if math.Abs(duration-plan.DurationSeconds) > math.Max(1, plan.TargetSegmentSeconds) {
			return fmt.Errorf("HLS probe duration %.3fs differs from source %.3fs", duration, plan.DurationSeconds)
		}
	}
	return nil
}

func validateHLSPackage(dir string, plan HLSPlan) (HLSPackageResult, error) {
	return validateHLSPackageContext(context.Background(), dir, plan)
}

func validateHLSPackageContext(ctx context.Context, dir string, plan HLSPlan) (HLSPackageResult, error) {
	if err := ctx.Err(); err != nil {
		return HLSPackageResult{}, err
	}
	manifestPath := filepath.Join(dir, hlsManifestName)
	manifestInfo, err := os.Stat(manifestPath)
	if err != nil {
		return HLSPackageResult{}, fmt.Errorf("stat HLS manifest: %w", err)
	}
	if !manifestInfo.Mode().IsRegular() || manifestInfo.Size() <= 0 || manifestInfo.Size() > probeOutputLimit {
		return HLSPackageResult{}, errors.New("HLS manifest exceeds the bounded validation limit")
	}
	manifest, err := os.Open(manifestPath)
	if err != nil {
		return HLSPackageResult{}, fmt.Errorf("open HLS manifest: %w", err)
	}
	defer manifest.Close()

	result := HLSPackageResult{ManifestName: hlsManifestName, Assets: make(map[string]HLSAsset)}
	seenHeader, seenMap, seenEnd, seenVOD, seenTarget := false, false, false, false, false
	pendingDuration := -1.0
	segmentDurations := make([]float64, 0)
	referenced := map[string]string{hlsManifestName: "manifest"}
	scanner := bufio.NewScanner(io.LimitReader(manifest, probeOutputLimit+1))
	scanner.Buffer(make([]byte, 4096), probeOutputLimit)
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return HLSPackageResult{}, err
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		switch {
		case line == "#EXTM3U":
			seenHeader = true
		case strings.HasPrefix(line, "#EXT-X-MAP:"):
			if line != `#EXT-X-MAP:URI="init.mp4"` {
				return HLSPackageResult{}, errors.New("HLS init URI is not the server-generated asset name")
			}
			seenMap = true
			referenced[hlsInitName] = "init"
		case line == "#EXT-X-PLAYLIST-TYPE:VOD":
			seenVOD = true
		case strings.HasPrefix(line, "#EXT-X-TARGETDURATION:"):
			value := strings.TrimPrefix(line, "#EXT-X-TARGETDURATION:")
			target, err := strconv.ParseFloat(value, 64)
			if err != nil || target <= 0 {
				return HLSPackageResult{}, errors.New("HLS manifest contains an invalid target duration")
			}
			seenTarget = true
		case strings.HasPrefix(line, "#EXTINF:"):
			value := strings.TrimSuffix(strings.TrimPrefix(line, "#EXTINF:"), ",")
			duration, err := strconv.ParseFloat(value, 64)
			if err != nil || duration <= 0 || math.IsNaN(duration) || math.IsInf(duration, 0) {
				return HLSPackageResult{}, errors.New("HLS manifest contains an invalid segment duration")
			}
			pendingDuration = duration
		case line == "#EXT-X-INDEPENDENT-SEGMENTS":
			return HLSPackageResult{}, errors.New("HLS manifest claims unverified independent segments")
		case line == "#EXT-X-ENDLIST":
			seenEnd = true
		case strings.HasPrefix(line, "#"):
			continue
		default:
			if pendingDuration <= 0 || !hlsSegmentNamePattern.MatchString(line) {
				return HLSPackageResult{}, fmt.Errorf("HLS manifest contains unsafe asset %q", line)
			}
			if _, duplicate := referenced[line]; duplicate {
				return HLSPackageResult{}, fmt.Errorf("HLS manifest repeats asset %q", line)
			}
			referenced[line] = "segment"
			segmentDurations = append(segmentDurations, pendingDuration)
			pendingDuration = -1
		}
	}
	if err := scanner.Err(); err != nil {
		return HLSPackageResult{}, fmt.Errorf("read HLS manifest: %w", err)
	}
	if !seenHeader || !seenMap || !seenEnd || !seenVOD || !seenTarget || len(segmentDurations) == 0 || pendingDuration > 0 {
		return HLSPackageResult{}, errors.New("HLS manifest is incomplete")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return HLSPackageResult{}, err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return HLSPackageResult{}, err
		}
		kind, expected := referenced[entry.Name()]
		if !expected || entry.IsDir() {
			return HLSPackageResult{}, fmt.Errorf("unexpected HLS package asset %q", entry.Name())
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 {
			return HLSPackageResult{}, fmt.Errorf("invalid HLS package asset %q", entry.Name())
		}
		result.Assets[entry.Name()] = HLSAsset{Name: entry.Name(), Size: info.Size(), Kind: kind}
		result.OutputBytes = saturatingAdd(result.OutputBytes, info.Size())
	}
	for name := range referenced {
		if err := ctx.Err(); err != nil {
			return HLSPackageResult{}, err
		}
		if _, found := result.Assets[name]; !found {
			return HLSPackageResult{}, fmt.Errorf("HLS manifest asset %q is missing", name)
		}
	}
	result.SegmentCount = len(segmentDurations)
	result.SegmentDuration = summarizeDurations(segmentDurations)
	result.segmentDurations = append([]float64(nil), segmentDurations...)
	totalDuration := 0.0
	for _, duration := range segmentDurations {
		totalDuration += duration
	}
	tolerance := math.Max(1, plan.TargetSegmentSeconds)
	if plan.DurationSeconds > 0 && math.Abs(totalDuration-plan.DurationSeconds) > tolerance {
		return HLSPackageResult{}, fmt.Errorf("HLS duration %.3fs differs from source %.3fs", totalDuration, plan.DurationSeconds)
	}
	return result, nil
}

func hlsAssetMIME(asset HLSAsset) string {
	switch asset.Kind {
	case "manifest":
		return "application/vnd.apple.mpegurl"
	case "init":
		return "video/mp4"
	case "segment":
		return "video/iso.segment"
	default:
		return "application/octet-stream"
	}
}
