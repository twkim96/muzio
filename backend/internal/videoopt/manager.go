package videoopt

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"muzio/backend/internal/library"
)

const (
	CacheKind           = "faststart-mp4"
	outputTypeFile      = "file"
	outputTypeDirectory = "directory"
	metadataVersion     = 1
	metadataFileName    = "current.json"
	metadataBackupName  = "current.json.bak"
	minimumSpaceMargin  = int64(512 << 20)
)

var (
	ErrUnsupported       = errors.New("video optimization only supports MP4/MOV video")
	ErrNotEligible       = errors.New("video is not eligible for faststart optimization")
	ErrInsufficientSpace = errors.New("insufficient free space for video optimization")
)

type ineligibleReasonError struct{ reason string }

func (e ineligibleReasonError) Error() string { return e.reason }
func (e ineligibleReasonError) Unwrap() error { return ErrNotEligible }

type Resolver interface {
	ResolveStrict(rootName, relativePath string) (string, error)
}

type IdleGate interface {
	WaitForMediaQuiet(context.Context, time.Duration) error
	BackgroundWorkContext(context.Context) (context.Context, context.CancelFunc)
}

type Builder interface {
	Build(context.Context, string, string) error
}

type SpaceChecker interface {
	AvailableBytes(string) (int64, error)
}

type Status struct {
	State                string         `json:"state"`
	MediaID              string         `json:"mediaId"`
	Eligible             bool           `json:"eligible"`
	Reason               string         `json:"reason,omitempty"`
	Layout               Layout         `json:"layout,omitempty"`
	CacheKind            string         `json:"cacheKind"`
	CacheKey             string         `json:"cacheKey,omitempty"`
	URL                  string         `json:"url,omitempty"`
	BuildingMediaID      string         `json:"buildingMediaId,omitempty"`
	BuildProgress        float64        `json:"buildProgress,omitempty"`
	EstimatedOutputBytes int64          `json:"estimatedOutputBytes"`
	RequiredFreeBytes    int64          `json:"requiredFreeBytes"`
	AvailableBytes       int64          `json:"availableBytes"`
	CacheUsedBytes       int64          `json:"cacheUsedBytes"`
	PeakCacheBytes       int64          `json:"peakCacheBytes"`
	MovieIndexBytes      int64          `json:"movieIndexBytes,omitempty"`
	DurationSeconds      float64        `json:"durationSeconds,omitempty"`
	TargetSegmentSeconds float64        `json:"targetSegmentSeconds,omitempty"`
	SegmentCount         int            `json:"segmentCount,omitempty"`
	GOP                  *DurationStats `json:"gop,omitempty"`
	SegmentDuration      *DurationStats `json:"segmentDuration,omitempty"`
	RandomAccessVerified bool           `json:"randomAccessVerified,omitempty"`
}

type ReadyFile struct {
	Path       string
	CacheKey   string
	Size       int64
	ModifiedAt time.Time
	Release    func()
}

type ReadyAsset struct {
	Path       string
	CacheKey   string
	Asset      HLSAsset
	ModifiedAt time.Time
	Release    func()
}

type cacheEntry struct {
	SchemaVersion        int                 `json:"schemaVersion"`
	Kind                 string              `json:"kind"`
	MediaID              string              `json:"mediaId"`
	CacheKey             string              `json:"cacheKey"`
	SourceSize           int64               `json:"sourceSize"`
	SourceModTime        time.Time           `json:"sourceModifiedAt"`
	OutputSize           int64               `json:"outputSize"`
	CreatedAt            time.Time           `json:"createdAt"`
	FileName             string              `json:"fileName"`
	OutputType           string              `json:"outputType,omitempty"`
	ManifestName         string              `json:"manifestName,omitempty"`
	Assets               map[string]HLSAsset `json:"assets,omitempty"`
	SegmentCount         int                 `json:"segmentCount,omitempty"`
	SegmentDuration      DurationStats       `json:"segmentDuration,omitempty"`
	GOP                  DurationStats       `json:"gop,omitempty"`
	RandomAccessVerified bool                `json:"randomAccessVerified,omitempty"`
	DurationSeconds      float64             `json:"durationSeconds,omitempty"`
	TargetSegmentSeconds float64             `json:"targetSegmentSeconds,omitempty"`
}

type candidate struct {
	item        library.Media
	sourcePath  string
	size        int64
	modTime     time.Time
	cacheKey    string
	fingerprint string
	layout      Layout
	movieSize   int64
	kind        string
}

type retiredEntry struct {
	entry    *cacheEntry
	retireAt time.Time
	invalid  bool
}

type Manager struct {
	cacheDir      string
	resolver      Resolver
	builder       Builder
	hls           HLSBuilder
	hlsOptions    HLSPlanOptions
	idle          IdleGate
	space         SpaceChecker
	logger        *slog.Logger
	timeout       time.Duration
	quietGrace    time.Duration
	retireGrace   time.Duration
	leaseDuration time.Duration
	now           func() time.Time
	remove        func(string) error
	removeAll     func(string) error

	mu                  sync.Mutex
	current             *cacheEntry
	retired             map[string]retiredEntry
	deleting            map[string]*cacheEntry
	active              map[string]int
	buildingID          string
	buildingKey         string
	buildingFingerprint string
	buildingKind        string
	buildingProgress    float64
	lastFailureMediaID  string
	lastFailureKind     string
	lastFailureReason   string
	ineligible          map[string]string
	plans               map[string]HLSPlan
	generation          uint64
	cancel              context.CancelFunc
	wg                  sync.WaitGroup
	cleanupTimer        *time.Timer
	closed              bool
}

type Options struct {
	CacheDir      string
	Resolver      Resolver
	Builder       Builder
	HLS           HLSBuilder
	HLSOptions    HLSPlanOptions
	Idle          IdleGate
	Space         SpaceChecker
	Logger        *slog.Logger
	Timeout       time.Duration
	QuietGrace    time.Duration
	RetireGrace   time.Duration
	LeaseDuration time.Duration
	Now           func() time.Time
	Remove        func(string) error
	RemoveAll     func(string) error
}

func NewManager(options Options) (*Manager, error) {
	if strings.TrimSpace(options.CacheDir) == "" {
		return nil, errors.New("video optimization: cache directory is required")
	}
	if options.Resolver == nil {
		return nil, errors.New("video optimization: resolver is required")
	}
	if options.Builder == nil {
		return nil, errors.New("video optimization: builder is required")
	}
	if err := os.MkdirAll(options.CacheDir, 0o755); err != nil {
		return nil, fmt.Errorf("video optimization: create cache directory: %w", err)
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 2 * time.Hour
	}
	quietGrace := options.QuietGrace
	if quietGrace <= 0 {
		quietGrace = 2 * time.Second
	}
	retireGrace := options.RetireGrace
	if retireGrace <= 0 {
		retireGrace = 5 * time.Second
	}
	leaseDuration := options.LeaseDuration
	if leaseDuration <= 0 {
		leaseDuration = 30 * time.Minute
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	remove := options.Remove
	if remove == nil {
		remove = os.Remove
	}
	removeAll := options.RemoveAll
	if removeAll == nil {
		removeAll = os.RemoveAll
	}
	space := options.Space
	if space == nil {
		space = systemSpaceChecker{}
	}
	m := &Manager{
		cacheDir: options.CacheDir, resolver: options.Resolver, builder: options.Builder,
		hls: options.HLS, hlsOptions: options.HLSOptions,
		idle: options.Idle, space: space, logger: logger, timeout: timeout,
		quietGrace: quietGrace, retireGrace: retireGrace, leaseDuration: leaseDuration, now: now,
		retired: make(map[string]retiredEntry), deleting: make(map[string]*cacheEntry), active: make(map[string]int),
		ineligible: make(map[string]string), plans: make(map[string]HLSPlan), remove: remove, removeAll: removeAll,
	}
	m.current = loadEntry(options.CacheDir)
	if m.current != nil && !entryAvailableAt(options.CacheDir, m.current) {
		m.current = nil
	}
	if m.current == nil {
		_ = writeEntry(options.CacheDir, nil)
	}
	m.cleanupStartupFiles()
	return m, nil
}

func (m *Manager) Status(item library.Media) Status {
	return m.StatusKind(item, CacheKind)
}

func (m *Manager) StatusKind(item library.Media, kind string) Status {
	kind = normalizeCacheKind(kind)
	c, err := m.candidateForKind(item, kind)
	if err != nil {
		var staleCandidate *candidate
		if c.size > 0 {
			staleCandidate = &c
		}
		m.retireStaleCurrent(item.ID, kind, staleCandidate)
		state := "unavailable"
		if errors.Is(err, ErrUnsupported) || errors.Is(err, ErrNotEligible) {
			state = "ineligible"
		}
		return Status{State: state, MediaID: item.ID, CacheKind: kind, Reason: publicCandidateReason(err), Layout: c.layout, EstimatedOutputBytes: c.size, MovieIndexBytes: c.movieSize}
	}
	m.retireStaleCurrent(item.ID, kind, &c)
	status := m.baseStatus(c)
	m.mu.Lock()
	defer m.mu.Unlock()
	if entryMatches(m.current, c) && m.entryAvailable(m.current) {
		status.State = "ready"
		status.Eligible = true
		status.CacheKey = m.current.CacheKey
		status.URL = readyURLForKind(kind, item.ID, m.current.CacheKey, m.current.ManifestName)
		applyEntryStatus(&status, m.current)
	}
	if m.buildingID != "" {
		status.BuildingMediaID = m.buildingID
		if m.buildingFingerprint == c.fingerprint && m.buildingKind == kind {
			status.State = "building"
			status.BuildProgress = m.buildingProgress
		}
	}
	if plan, found := m.plans[c.fingerprint]; found {
		applyPlanStatus(&status, plan)
	}
	if reason, found := m.ineligible[c.fingerprint]; found && status.State != "ready" {
		status.State = "ineligible"
		status.Eligible = false
		status.Reason = reason
	} else if m.buildingID == "" && status.State != "ready" && status.State != "insufficient-space" && m.lastFailureMediaID == item.ID && m.lastFailureKind == kind {
		status.State = "failed"
		status.Reason = m.lastFailureReason
	}
	return status
}

func (m *Manager) Request(item library.Media) (Status, error) {
	return m.RequestKind(item, CacheKind)
}

func (m *Manager) RequestKind(item library.Media, kind string) (Status, error) {
	kind = normalizeCacheKind(kind)
	c, err := m.candidateForKind(item, kind)
	if err != nil {
		return m.StatusKind(item, kind), err
	}
	m.retireStaleCurrent(item.ID, kind, &c)
	m.mu.Lock()
	if entryMatches(m.current, c) && m.entryAvailable(m.current) {
		m.mu.Unlock()
		return m.StatusKind(item, kind), nil
	}
	if m.buildingFingerprint == c.fingerprint && m.buildingKind == kind {
		m.mu.Unlock()
		return m.StatusKind(item, kind), nil
	}
	if reason, found := m.ineligible[c.fingerprint]; found {
		m.mu.Unlock()
		status := m.StatusKind(item, kind)
		status.Reason = reason
		return status, ErrNotEligible
	}
	m.mu.Unlock()

	status := m.baseStatus(c)
	if status.State == "unavailable" {
		return status, errors.New(status.Reason)
	}
	if status.AvailableBytes < status.RequiredFreeBytes {
		status.State = "insufficient-space"
		status.Reason = ErrInsufficientSpace.Error()
		return status, ErrInsufficientSpace
	}

	m.mu.Lock()
	if entryMatches(m.current, c) && m.entryAvailable(m.current) {
		m.mu.Unlock()
		return m.StatusKind(item, kind), nil
	}
	if m.buildingFingerprint == c.fingerprint && m.buildingKind == kind {
		m.mu.Unlock()
		return m.StatusKind(item, kind), nil
	}
	if reason, found := m.ineligible[c.fingerprint]; found {
		m.mu.Unlock()
		status.State = "ineligible"
		status.Eligible = false
		status.Reason = reason
		return status, ErrNotEligible
	}
	if m.cancel != nil {
		m.cancel()
	}
	m.generation++
	generation := m.generation
	fingerprint := c.fingerprint
	c.cacheKey = generationCacheKey(fingerprint, generation, m.now())
	ctx, cancel := context.WithTimeout(context.Background(), m.timeout)
	m.cancel = cancel
	m.buildingID = item.ID
	m.buildingKey = c.cacheKey
	m.buildingFingerprint = fingerprint
	m.buildingKind = kind
	m.buildingProgress = 0
	if m.lastFailureMediaID == item.ID && m.lastFailureKind == kind {
		m.lastFailureMediaID, m.lastFailureKind, m.lastFailureReason = "", "", ""
	}
	m.wg.Add(1)
	m.mu.Unlock()

	go m.build(ctx, generation, c)
	return m.StatusKind(item, kind), nil
}

func (m *Manager) Cancel(mediaID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.buildingID != mediaID || m.cancel == nil {
		return false
	}
	m.cancel()
	m.generation++
	m.buildingID = ""
	m.buildingKey = ""
	m.buildingFingerprint = ""
	m.buildingKind = ""
	m.buildingProgress = 0
	m.cancel = nil
	return true
}

func (m *Manager) Clear(mediaID, cacheKey string) bool {
	m.mu.Lock()
	if m.current == nil || m.current.MediaID != mediaID || m.current.CacheKey != cacheKey {
		m.mu.Unlock()
		return false
	}
	err := writeEntry(m.cacheDir, nil)
	if err != nil {
		m.mu.Unlock()
		m.logger.Warn("video optimization metadata clear failed", "id", mediaID, "error", err)
		return false
	}
	entry := m.current
	m.current = nil
	m.retireLocked(entry)
	m.scheduleCleanupLocked()
	m.mu.Unlock()
	return true
}

func (m *Manager) Acquire(item library.Media, cacheKey string) (ReadyFile, bool) {
	c, err := m.candidateForKind(item, CacheKind)
	if err != nil {
		return ReadyFile{}, false
	}
	m.mu.Lock()
	entry, retired, found := m.acquireEntryLocked(c, cacheKey)
	if !found || entry.OutputType == outputTypeDirectory {
		m.mu.Unlock()
		return ReadyFile{}, false
	}
	path := filepath.Join(m.cacheDir, entry.FileName)
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() != entry.OutputSize {
		m.mu.Unlock()
		return ReadyFile{}, false
	}
	release := m.acquireLeaseLocked(cacheKey, retired)
	m.mu.Unlock()
	return ReadyFile{
		Path: path, CacheKey: cacheKey, Size: info.Size(), ModifiedAt: info.ModTime(),
		Release: release,
	}, true
}

func (m *Manager) AcquireHLSAsset(item library.Media, cacheKey, assetName string) (ReadyAsset, bool) {
	if filepath.Base(assetName) != assetName || assetName == "" {
		return ReadyAsset{}, false
	}
	c, err := m.candidateForKind(item, HLSCacheKind)
	if err != nil {
		return ReadyAsset{}, false
	}
	m.mu.Lock()
	entry, retired, found := m.acquireEntryLocked(c, cacheKey)
	if !found || entry.OutputType != outputTypeDirectory {
		m.mu.Unlock()
		return ReadyAsset{}, false
	}
	asset, found := entry.Assets[assetName]
	if !found {
		m.mu.Unlock()
		return ReadyAsset{}, false
	}
	if asset.Name != assetName {
		m.invalidateHLSGenerationLocked(entry, retired, "asset metadata mismatch")
		m.mu.Unlock()
		return ReadyAsset{}, false
	}
	path := filepath.Join(m.cacheDir, entry.FileName, assetName)
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() != asset.Size {
		m.invalidateHLSGenerationLocked(entry, retired, "registered asset missing or changed")
		m.mu.Unlock()
		return ReadyAsset{}, false
	}
	release := m.acquireLeaseLocked(cacheKey, retired)
	m.mu.Unlock()
	return ReadyAsset{Path: path, CacheKey: cacheKey, Asset: asset, ModifiedAt: info.ModTime(), Release: release}, true
}

func (m *Manager) acquireEntryLocked(c candidate, cacheKey string) (*cacheEntry, bool, bool) {
	entry := m.current
	retired := false
	if entry == nil || entry.CacheKey != cacheKey {
		lease, found := m.retired[cacheKey]
		if !found || lease.invalid {
			return nil, false, false
		}
		entry = lease.entry
		retired = true
	}
	if !entryMatches(entry, c) {
		return nil, false, false
	}
	return entry, retired, true
}

func (m *Manager) invalidateHLSGenerationLocked(entry *cacheEntry, retired bool, reason string) {
	if entry == nil || entry.Kind != HLSCacheKind {
		return
	}
	invalid := retiredEntry{
		entry: entry, retireAt: m.now().Add(m.retireGrace), invalid: true,
	}
	if retired {
		if existing, found := m.retired[entry.CacheKey]; found {
			existing.invalid = true
			existing.retireAt = invalid.retireAt
			m.retired[entry.CacheKey] = existing
		}
	} else if m.current != nil && m.current.CacheKey == entry.CacheKey {
		if err := writeEntry(m.cacheDir, nil); err != nil {
			m.logger.Warn("video optimization corrupt metadata clear failed", "id", entry.MediaID, "error", err)
		}
		m.current = nil
		m.retired[entry.CacheKey] = invalid
	}
	m.scheduleCleanupLocked()
	m.logger.Warn("video optimization HLS generation invalidated", "id", entry.MediaID, "cacheKey", entry.CacheKey, "reason", reason)
}

func (m *Manager) acquireLeaseLocked(cacheKey string, retired bool) func() {
	m.active[cacheKey]++
	if retired {
		lease := m.retired[cacheKey]
		lease.retireAt = m.now().Add(m.leaseDuration + m.retireGrace)
		m.retired[cacheKey] = lease
		m.scheduleCleanupLocked()
	}
	released := false
	return func() {
		m.mu.Lock()
		if !released {
			released = true
			if m.active[cacheKey] > 1 {
				m.active[cacheKey]--
			} else {
				delete(m.active, cacheKey)
			}
		}
		m.scheduleCleanupLocked()
		m.mu.Unlock()
	}
}

func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	if m.cancel != nil {
		m.cancel()
	}
	m.generation++
	if m.cleanupTimer != nil {
		m.cleanupTimer.Stop()
		m.cleanupTimer = nil
	}
	m.mu.Unlock()
	m.wg.Wait()
}

func (m *Manager) build(ctx context.Context, generation uint64, c candidate) {
	defer m.wg.Done()
	if m.idle != nil {
		if err := m.idle.WaitForMediaQuiet(ctx, m.quietGrace); err != nil {
			m.finishBuild(generation, c, nil, err)
			return
		}
		workCtx, cancel := m.idle.BackgroundWorkContext(ctx)
		defer cancel()
		ctx = workCtx
	}
	if c.kind == HLSCacheKind {
		m.buildHLS(ctx, generation, c)
		return
	}
	if err := ctx.Err(); err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	if err := m.requireFreeSpace(c.size + spaceMargin(c.size)); err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	temp, err := os.CreateTemp(m.cacheDir, ".faststart-*.mp4.tmp")
	if err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	tempPath := temp.Name()
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempPath)
		m.finishBuild(generation, c, nil, err)
		return
	}
	_ = os.Remove(tempPath)
	defer os.Remove(tempPath)
	if err := m.builder.Build(ctx, c.sourcePath, tempPath); err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	if err := ctx.Err(); err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	output, err := os.OpenFile(tempPath, os.O_RDWR, 0)
	if err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	info, statErr := output.Stat()
	if statErr == nil && (!info.Mode().IsRegular() || info.Size() == 0) {
		statErr = errors.New("faststart output is empty")
	}
	if statErr == nil {
		statErr = ctx.Err()
	}
	if statErr == nil {
		statErr = output.Sync()
	}
	closeErr := output.Close()
	if statErr == nil {
		statErr = closeErr
	}
	if statErr != nil {
		m.finishBuild(generation, c, nil, statErr)
		return
	}
	if err := ctx.Err(); err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	inspectionFile, err := os.Open(tempPath)
	if err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	inspection, inspectErr := InspectMP4(inspectionFile, info.Size())
	_ = inspectionFile.Close()
	if inspectErr != nil || inspection.Layout != LayoutFrontMoov {
		if inspectErr == nil {
			inspectErr = errors.New("faststart output is not front-moov")
		}
		m.finishBuild(generation, c, nil, inspectErr)
		return
	}
	sourceInfo, err := os.Stat(c.sourcePath)
	if err != nil || sourceInfo.Size() != c.size || !sourceInfo.ModTime().Equal(c.modTime) {
		m.finishBuild(generation, c, nil, errors.New("source changed during faststart build"))
		return
	}
	if err := ctx.Err(); err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	if err := m.requireFreeSpace(spaceMargin(c.size)); err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	finalName := "sidecar-" + c.cacheKey + ".mp4"
	finalPath := filepath.Join(m.cacheDir, finalName)
	if err := os.Rename(tempPath, finalPath); err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	if err := syncDirectory(m.cacheDir); err != nil {
		_ = os.Remove(finalPath)
		m.finishBuild(generation, c, nil, err)
		return
	}
	if err := ctx.Err(); err != nil {
		_ = os.Remove(finalPath)
		m.finishBuild(generation, c, nil, err)
		return
	}
	next := &cacheEntry{SchemaVersion: metadataVersion, Kind: CacheKind, MediaID: c.item.ID,
		CacheKey: c.cacheKey, SourceSize: c.size, SourceModTime: c.modTime,
		OutputSize: info.Size(), CreatedAt: m.now().UTC(), FileName: finalName}
	m.finishBuild(generation, c, next, nil)
}

func (m *Manager) buildHLS(ctx context.Context, generation uint64, c candidate) {
	if m.hls == nil {
		m.finishBuild(generation, c, nil, errors.New("HLS packaging unavailable"))
		return
	}
	if err := ctx.Err(); err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	if err := m.requireFreeSpace(c.size + spaceMargin(c.size)); err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	plan, err := m.hls.Plan(ctx, c.sourcePath)
	if err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	used := m.knownCacheUsage()
	plan.PeakCacheBytes = saturatingAdd(used, plan.EstimatedOutputBytes)
	m.mu.Lock()
	if generation == m.generation && m.buildingKey == c.cacheKey {
		m.plans[c.fingerprint] = plan
	}
	m.mu.Unlock()
	if !plan.Eligible {
		m.finishBuild(generation, c, nil, ineligibleReasonError{reason: plan.Reason})
		return
	}
	if err := m.requireFreeSpace(plan.RequiredFreeBytes); err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	tempDir, err := os.MkdirTemp(m.cacheDir, ".hls-*.tmp")
	if err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	defer m.removeAll(tempDir)
	result, err := m.hls.Build(ctx, c.sourcePath, tempDir, plan, func(progress float64) {
		m.mu.Lock()
		if generation == m.generation && m.buildingKey == c.cacheKey {
			if progress < 0 {
				progress = 0
			}
			if progress > 1 {
				progress = 1
			}
			m.buildingProgress = progress
		}
		m.mu.Unlock()
	})
	if err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	if err := ctx.Err(); err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	sourceInfo, err := os.Stat(c.sourcePath)
	if err != nil || sourceInfo.Size() != c.size || !sourceInfo.ModTime().Equal(c.modTime) {
		m.finishBuild(generation, c, nil, errors.New("source changed during HLS package build"))
		return
	}
	if err := m.requireFreeSpace(spaceMargin(c.size)); err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	finalName := "hls-" + c.cacheKey
	finalPath := filepath.Join(m.cacheDir, finalName)
	if err := os.Rename(tempDir, finalPath); err != nil {
		m.finishBuild(generation, c, nil, err)
		return
	}
	if err := syncDirectory(m.cacheDir); err != nil {
		_ = m.removeAll(finalPath)
		m.finishBuild(generation, c, nil, err)
		return
	}
	if err := ctx.Err(); err != nil {
		_ = m.removeAll(finalPath)
		m.finishBuild(generation, c, nil, err)
		return
	}
	next := &cacheEntry{
		SchemaVersion: metadataVersion, Kind: HLSCacheKind, MediaID: c.item.ID,
		CacheKey: c.cacheKey, SourceSize: c.size, SourceModTime: c.modTime,
		OutputSize: result.OutputBytes, CreatedAt: m.now().UTC(), FileName: finalName,
		OutputType: outputTypeDirectory, ManifestName: result.ManifestName, Assets: result.Assets,
		SegmentCount: result.SegmentCount, SegmentDuration: result.SegmentDuration,
		DurationSeconds: plan.DurationSeconds, TargetSegmentSeconds: plan.TargetSegmentSeconds,
		GOP:                  plan.GOP,
		RandomAccessVerified: result.RandomAccessVerified,
	}
	m.finishBuild(generation, c, next, nil)
}

func (m *Manager) finishBuild(generation uint64, c candidate, next *cacheEntry, buildErr error) {
	m.mu.Lock()
	if generation != m.generation || m.buildingKey != c.cacheKey {
		m.mu.Unlock()
		if next != nil {
			_ = m.removeEntryOutput(next)
		}
		return
	}
	cancel := m.cancel
	m.buildingID, m.buildingKey, m.buildingFingerprint, m.buildingKind, m.cancel = "", "", "", "", nil
	m.buildingProgress = 0
	if cancel != nil {
		cancel()
	}
	if buildErr != nil {
		if !errors.Is(buildErr, context.Canceled) {
			if errors.Is(buildErr, ErrNotEligible) {
				m.ineligible[c.fingerprint] = publicBuildReason(buildErr, c.kind)
			} else {
				m.lastFailureMediaID = c.item.ID
				m.lastFailureKind = c.kind
				m.lastFailureReason = publicBuildReason(buildErr, c.kind)
			}
		}
		m.mu.Unlock()
		if !errors.Is(buildErr, context.Canceled) {
			m.logger.Warn("video optimization build failed", "id", c.item.ID, "error", buildErr)
		}
		return
	}
	previous := m.current
	if err := writeEntry(m.cacheDir, next); err != nil {
		m.mu.Unlock()
		_ = m.removeEntryOutput(next)
		m.logger.Warn("video optimization metadata publish failed", "id", c.item.ID, "error", err)
		return
	}
	m.current = next
	m.lastFailureMediaID, m.lastFailureKind, m.lastFailureReason = "", "", ""
	delete(m.ineligible, c.fingerprint)
	if previous != nil && previous.CacheKey != next.CacheKey {
		m.retireLocked(previous)
	}
	m.scheduleCleanupLocked()
	m.mu.Unlock()
	m.logger.Info("video optimization ready", "id", c.item.ID, "cacheKey", c.cacheKey, "bytes", next.OutputSize)
}

func (m *Manager) candidateFor(item library.Media) (candidate, error) {
	return m.candidateForKind(item, CacheKind)
}

func (m *Manager) candidateForKind(item library.Media, kind string) (candidate, error) {
	kind = normalizeCacheKind(kind)
	if item.Type != library.MediaTypeVideo {
		return candidate{}, ErrUnsupported
	}
	if kind != HLSCacheKind && kind != CacheKind {
		return candidate{kind: kind}, ErrUnsupported
	}
	switch strings.ToLower(filepath.Ext(item.Name)) {
	case ".mp4", ".mov", ".m4v":
	default:
		return candidate{}, ErrUnsupported
	}
	path, err := m.resolver.ResolveStrict(item.RootName, item.RelativePath)
	if err != nil {
		return candidate{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return candidate{}, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return candidate{}, err
	}
	if !info.Mode().IsRegular() {
		_ = file.Close()
		return candidate{}, errors.New("video source is not a regular file")
	}
	inspection, err := InspectMP4(file, info.Size())
	_ = file.Close()
	if err != nil {
		return candidate{}, fmt.Errorf("%w: %v", ErrNotEligible, err)
	}
	hash := sha256.Sum256([]byte(fmt.Sprintf("%s|%d|%d|%s", item.ID, info.Size(), info.ModTime().UnixNano(), kind)))
	fingerprint := hex.EncodeToString(hash[:12])
	c := candidate{item: item, sourcePath: path, size: info.Size(), modTime: info.ModTime(), fingerprint: fingerprint, layout: inspection.Layout, kind: kind}
	if inspection.Movie != nil {
		c.movieSize = inspection.Movie.Size
	}
	if kind == CacheKind {
		if inspection.Layout != LayoutEndMoov {
			return c, fmt.Errorf("%w: layout is %s", ErrNotEligible, inspection.Layout)
		}
		return c, nil
	}
	if m.hls == nil {
		return c, errors.New("HLS packaging unavailable")
	}
	if err := validateHLSPlanOptions(m.hlsOptions); err != nil {
		return c, err
	}
	if reason := hlsContainerIneligibleReason(inspection, m.hlsOptions); reason != "" {
		return c, ineligibleReasonError{reason: reason}
	}
	return c, nil
}

func (m *Manager) baseStatus(c candidate) Status {
	available, err := m.space.AvailableBytes(m.cacheDir)
	if err != nil {
		available = 0
	}
	used := m.knownCacheUsage()
	required := c.size + spaceMargin(c.size)
	status := Status{State: "eligible", MediaID: c.item.ID, Eligible: true, Layout: c.layout,
		CacheKind: c.kind, EstimatedOutputBytes: c.size, RequiredFreeBytes: required,
		AvailableBytes: available, CacheUsedBytes: used, PeakCacheBytes: used + c.size,
		MovieIndexBytes: c.movieSize}
	if err != nil {
		status.State = "unavailable"
		status.Eligible = false
		status.Reason = "free space unavailable"
	}
	if err == nil && available < required {
		status.State = "insufficient-space"
		status.Reason = ErrInsufficientSpace.Error()
	}
	return status
}

func (m *Manager) requireFreeSpace(required int64) error {
	available, err := m.space.AvailableBytes(m.cacheDir)
	if err != nil {
		return fmt.Errorf("video optimization: free space unavailable: %w", err)
	}
	if available < required {
		return ErrInsufficientSpace
	}
	return nil
}

func (m *Manager) retireStaleCurrent(mediaID, kind string, c *candidate) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil || m.current.MediaID != mediaID {
		return
	}
	if c != nil {
		sourceMatches := m.current.MediaID == c.item.ID && m.current.SourceSize == c.size && m.current.SourceModTime.Equal(c.modTime)
		if sourceMatches && (m.current.Kind != kind || (entryMatches(m.current, *c) && m.entryAvailable(m.current))) {
			return
		}
	}
	if err := writeEntry(m.cacheDir, nil); err != nil {
		m.logger.Warn("video optimization stale metadata clear failed", "id", mediaID, "error", err)
		return
	}
	entry := m.current
	m.current = nil
	m.retired[entry.CacheKey] = retiredEntry{
		entry:    entry,
		retireAt: m.now().Add(m.retireGrace),
	}
	m.scheduleCleanupLocked()
}

func (m *Manager) retireLocked(entry *cacheEntry) {
	m.retired[entry.CacheKey] = retiredEntry{
		entry:    entry,
		retireAt: m.now().Add(m.leaseDuration + m.retireGrace),
	}
}

func (m *Manager) scheduleCleanupLocked() {
	if m.closed {
		return
	}
	var earliest time.Time
	for key, retired := range m.retired {
		if m.active[key] > 0 {
			continue
		}
		if earliest.IsZero() || retired.retireAt.Before(earliest) {
			earliest = retired.retireAt
		}
	}
	if earliest.IsZero() {
		if m.cleanupTimer != nil {
			m.cleanupTimer.Stop()
			m.cleanupTimer = nil
		}
		return
	}
	delay := earliest.Sub(m.now())
	if delay < 0 {
		delay = 0
	}
	if m.cleanupTimer == nil {
		m.cleanupTimer = time.AfterFunc(delay, m.cleanupRetired)
		return
	}
	m.cleanupTimer.Stop()
	m.cleanupTimer.Reset(delay)
}

func (m *Manager) cleanupRetired() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.cleanupTimer = nil
	now := m.now()
	targets := make(map[string]retiredEntry)
	for key, retired := range m.retired {
		if m.active[key] == 0 && !now.Before(retired.retireAt) {
			delete(m.retired, key)
			m.deleting[key] = retired.entry
			targets[key] = retired
		}
	}
	m.scheduleCleanupLocked()
	m.mu.Unlock()

	failures := make(map[string]retiredEntry)
	for key, retired := range targets {
		if err := m.removeEntryOutput(retired.entry); err != nil && !errors.Is(err, os.ErrNotExist) {
			retired.retireAt = m.now().Add(m.retireGrace)
			failures[key] = retired
			m.logger.Warn("video optimization retired cleanup failed", "error", err)
		}
	}

	m.mu.Lock()
	for key := range targets {
		delete(m.deleting, key)
	}
	if !m.closed {
		for key, retired := range failures {
			if _, exists := m.retired[key]; !exists {
				m.retired[key] = retired
			}
		}
		m.scheduleCleanupLocked()
	}
	m.mu.Unlock()
}

func (m *Manager) cleanupStartupFiles() {
	keep := ""
	if m.current != nil {
		keep = m.current.FileName
	}
	entries, _ := os.ReadDir(m.cacheDir)
	for _, entry := range entries {
		name := entry.Name()
		if name == metadataFileName || name == metadataBackupName || name == keep {
			continue
		}
		path := filepath.Join(m.cacheDir, name)
		if entry.IsDir() && (strings.HasPrefix(name, ".hls-") || strings.HasPrefix(name, "hls-")) {
			_ = m.removeAll(path)
			continue
		}
		if !entry.IsDir() && (strings.HasPrefix(name, ".faststart-") || strings.HasPrefix(name, "sidecar-") || strings.HasPrefix(name, ".current-")) {
			_ = m.remove(path)
		}
	}
}

func entryMatches(entry *cacheEntry, c candidate) bool {
	return entry != nil && entry.SchemaVersion == metadataVersion && entry.Kind == c.kind &&
		entry.MediaID == c.item.ID && entry.SourceSize == c.size && entry.SourceModTime.Equal(c.modTime)
}

func generationCacheKey(fingerprint string, generation uint64, now time.Time) string {
	hash := sha256.Sum256([]byte(fmt.Sprintf("%s|%d|%d", fingerprint, generation, now.UnixNano())))
	return hex.EncodeToString(hash[:12])
}

func publicCandidateReason(err error) string {
	switch {
	case errors.Is(err, ErrUnsupported), errors.Is(err, ErrNotEligible):
		return err.Error()
	default:
		return "video source unavailable"
	}
}

func publicBuildReason(err error, kind string) string {
	if errors.Is(err, ErrInsufficientSpace) {
		return ErrInsufficientSpace.Error()
	}
	if errors.Is(err, ErrNotEligible) {
		var reason ineligibleReasonError
		if errors.As(err, &reason) && strings.TrimSpace(reason.reason) != "" {
			return reason.reason
		}
		return "MP4 stream-copy cannot preserve every source track"
	}
	if strings.Contains(err.Error(), "source changed") {
		return "source changed during preparation; retry after the library refreshes"
	}
	if kind == HLSCacheKind {
		return "HLS packaging failed; direct playback remains available"
	}
	return "faststart preparation failed; direct playback remains available"
}

func spaceMargin(size int64) int64 {
	margin := size / 20
	if margin < minimumSpaceMargin {
		return minimumSpaceMargin
	}
	return margin
}

func (m *Manager) knownCacheUsage() int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	var total int64
	seen := make(map[string]struct{}, len(m.retired)+1)
	if m.current != nil {
		total = saturatingAdd(total, m.current.OutputSize)
		seen[m.current.CacheKey] = struct{}{}
	}
	for key, retired := range m.retired {
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		total = saturatingAdd(total, retired.entry.OutputSize)
	}
	for key, entry := range m.deleting {
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		total = saturatingAdd(total, entry.OutputSize)
	}
	return total
}

func loadEntry(dir string) *cacheEntry {
	for _, name := range []string{metadataFileName, metadataBackupName} {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		var entry cacheEntry
		if json.Unmarshal(data, &entry) != nil || !validCacheEntryMetadata(&entry) {
			continue
		}
		if entryAvailableAt(dir, &entry) {
			return &entry
		}
	}
	return nil
}

func writeEntry(dir string, entry *cacheEntry) error {
	statePath := filepath.Join(dir, metadataFileName)
	backupPath := filepath.Join(dir, metadataBackupName)
	if entry == nil {
		_ = os.Remove(backupPath)
		if err := os.Remove(statePath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return syncDirectory(dir)
	}
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, ".current-*.json.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(append(data, '\n')); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	_ = os.Remove(backupPath)
	if _, err := os.Stat(statePath); err == nil {
		if err := os.Rename(statePath, backupPath); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(tempPath, statePath); err != nil {
		_ = os.Rename(backupPath, statePath)
		return err
	}
	if err := syncDirectory(dir); err != nil {
		return err
	}
	_ = os.Remove(backupPath)
	return syncDirectory(dir)
}

func regularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0
}

func readyURL(mediaID, cacheKey string) string {
	return "/api/video-optimization/media/" + url.PathEscape(mediaID) + "?v=" + url.QueryEscape(cacheKey)
}

func readyURLForKind(kind, mediaID, cacheKey, manifestName string) string {
	if kind == HLSCacheKind {
		if manifestName == "" {
			manifestName = hlsManifestName
		}
		return "/api/video-optimization/hls/" + url.PathEscape(mediaID) + "/" + url.PathEscape(cacheKey) + "/" + manifestName
	}
	return readyURL(mediaID, cacheKey)
}

func normalizeCacheKind(kind string) string {
	kind = strings.TrimSpace(kind)
	if kind == "" {
		return CacheKind
	}
	return kind
}

func validCacheEntryMetadata(entry *cacheEntry) bool {
	if entry == nil || entry.SchemaVersion != metadataVersion || entry.FileName == "" || filepath.Base(entry.FileName) != entry.FileName {
		return false
	}
	switch entry.Kind {
	case CacheKind:
		return entry.OutputType == "" || entry.OutputType == outputTypeFile
	case HLSCacheKind:
		if entry.OutputType != outputTypeDirectory || entry.ManifestName != hlsManifestName || len(entry.Assets) == 0 {
			return false
		}
		for name, asset := range entry.Assets {
			if name == "" || filepath.Base(name) != name || asset.Name != name || asset.Size <= 0 {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func entryAvailableAt(cacheDir string, entry *cacheEntry) bool {
	if !validCacheEntryMetadata(entry) {
		return false
	}
	path := filepath.Join(cacheDir, entry.FileName)
	if entry.Kind == CacheKind {
		info, err := os.Stat(path)
		return err == nil && info.Mode().IsRegular() && info.Size() == entry.OutputSize
	}
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return false
	}
	for name, asset := range entry.Assets {
		assetInfo, err := os.Stat(filepath.Join(path, name))
		if err != nil || !assetInfo.Mode().IsRegular() || assetInfo.Size() != asset.Size {
			return false
		}
	}
	validated, err := validateHLSPackage(path, HLSPlan{
		DurationSeconds: entry.DurationSeconds, TargetSegmentSeconds: entry.TargetSegmentSeconds,
	})
	return err == nil && validated.OutputBytes == entry.OutputSize &&
		validated.SegmentCount == entry.SegmentCount && sameHLSAssets(validated.Assets, entry.Assets)
}

func sameHLSAssets(first, second map[string]HLSAsset) bool {
	if len(first) != len(second) {
		return false
	}
	for name, asset := range first {
		if other, found := second[name]; !found || other != asset {
			return false
		}
	}
	return true
}

func (m *Manager) entryAvailable(entry *cacheEntry) bool {
	return entryAvailableShallowAt(m.cacheDir, entry)
}

func entryAvailableShallowAt(cacheDir string, entry *cacheEntry) bool {
	if !validCacheEntryMetadata(entry) {
		return false
	}
	path := filepath.Join(cacheDir, entry.FileName)
	if entry.Kind == CacheKind {
		info, err := os.Stat(path)
		return err == nil && info.Mode().IsRegular() && info.Size() == entry.OutputSize
	}
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return false
	}
	for _, name := range []string{entry.ManifestName, hlsInitName} {
		asset, found := entry.Assets[name]
		if !found {
			return false
		}
		assetInfo, err := os.Stat(filepath.Join(path, name))
		if err != nil || !assetInfo.Mode().IsRegular() || assetInfo.Size() != asset.Size {
			return false
		}
	}
	return true
}

func (m *Manager) removeEntryOutput(entry *cacheEntry) error {
	if entry == nil || entry.FileName == "" {
		return nil
	}
	path := filepath.Join(m.cacheDir, entry.FileName)
	if entry.OutputType == outputTypeDirectory || entry.Kind == HLSCacheKind {
		return m.removeAll(path)
	}
	return m.remove(path)
}

func applyPlanStatus(status *Status, plan HLSPlan) {
	status.EstimatedOutputBytes = plan.EstimatedOutputBytes
	status.RequiredFreeBytes = plan.RequiredFreeBytes
	status.PeakCacheBytes = plan.PeakCacheBytes
	status.DurationSeconds = plan.DurationSeconds
	status.TargetSegmentSeconds = plan.TargetSegmentSeconds
	if plan.GOP.Count > 0 {
		gop := plan.GOP
		status.GOP = &gop
	}
}

func applyEntryStatus(status *Status, entry *cacheEntry) {
	if entry == nil || entry.Kind != HLSCacheKind {
		return
	}
	status.DurationSeconds = entry.DurationSeconds
	status.TargetSegmentSeconds = entry.TargetSegmentSeconds
	status.SegmentCount = entry.SegmentCount
	if entry.SegmentDuration.Count > 0 {
		segmentDuration := entry.SegmentDuration
		status.SegmentDuration = &segmentDuration
	}
	if entry.GOP.Count > 0 {
		gop := entry.GOP
		status.GOP = &gop
	}
	status.RandomAccessVerified = entry.RandomAccessVerified
}
