package videoopt

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"muzio/backend/internal/library"
)

type testResolver map[string]string

func (r testResolver) ResolveStrict(_ string, relativePath string) (string, error) {
	path, ok := r[relativePath]
	if !ok {
		return "", os.ErrNotExist
	}
	return path, nil
}

type fixedSpace int64

func (s fixedSpace) AvailableBytes(string) (int64, error) { return int64(s), nil }

type mutableSpace struct{ available atomic.Int64 }

func (s *mutableSpace) AvailableBytes(string) (int64, error) {
	return s.available.Load(), nil
}

type controlledBuilder struct {
	started  chan string
	releases map[string]chan struct{}
}

type fakeHLSBuilder struct {
	plan  HLSPlan
	err   error
	calls int
}

func (b *fakeHLSBuilder) Plan(context.Context, string) (HLSPlan, error) {
	b.calls++
	if b.err != nil {
		return HLSPlan{}, b.err
	}
	return b.plan, nil
}

func (b *fakeHLSBuilder) Build(_ context.Context, _ string, outputDir string, plan HLSPlan, onProgress func(float64)) (HLSPackageResult, error) {
	if onProgress != nil {
		onProgress(0.5)
	}
	manifest := "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6.000,\nseg-000000.m4s\n#EXTINF:6.000,\nseg-000001.m4s\n#EXT-X-ENDLIST\n"
	files := map[string][]byte{
		hlsManifestName:  []byte(manifest),
		hlsInitName:      []byte("init"),
		"seg-000000.m4s": []byte("segment-0"),
		"seg-000001.m4s": []byte("segment-1"),
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(outputDir, name), data, 0o600); err != nil {
			return HLSPackageResult{}, err
		}
	}
	return validateHLSPackage(outputDir, plan)
}

func (b *controlledBuilder) Build(ctx context.Context, source, output string) error {
	name := filepath.Base(source)
	if b.started != nil {
		b.started <- name
	}
	if release := b.releases[name]; release != nil {
		select {
		case <-release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return os.WriteFile(output, frontMoovFixture(), 0o600)
}

func TestManagerReplacesReadyOnlyAfterValidatedBuild(t *testing.T) {
	root := t.TempDir()
	first := writeEndMoovVideo(t, root, "first.mp4")
	second := writeEndMoovVideo(t, root, "second.mp4")
	releaseSecond := make(chan struct{})
	builder := &controlledBuilder{started: make(chan string, 2), releases: map[string]chan struct{}{"second.mp4": releaseSecond}}
	manager := newTestManager(t, root, builder, testResolver{"first.mp4": first, "second.mp4": second})
	defer manager.Close()
	firstItem := videoItem(t, "first", "first.mp4", first)
	secondItem := videoItem(t, "second", "second.mp4", second)

	if _, err := manager.Request(firstItem); err != nil {
		t.Fatal(err)
	}
	<-builder.started
	waitForVideoStatus(t, manager, firstItem, "ready")
	firstStatus := manager.Status(firstItem)
	firstReady, ok := manager.Acquire(firstItem, firstStatus.CacheKey)
	if !ok {
		t.Fatal("first sidecar not ready")
	}
	firstReady.Release()

	if _, err := manager.Request(secondItem); err != nil {
		t.Fatal(err)
	}
	<-builder.started
	if status := manager.Status(firstItem); status.State != "ready" || status.BuildingMediaID != secondItem.ID {
		t.Fatalf("status while replacing = %#v", status)
	}
	close(releaseSecond)
	waitForVideoStatus(t, manager, secondItem, "ready")
	if _, err := os.Stat(firstReady.Path); err != nil {
		t.Fatalf("old generation deleted before grace: %v", err)
	}
}

func TestRetiredGenerationRemainsAvailableForLaterRangesAndSeek(t *testing.T) {
	root := t.TempDir()
	firstPath := writeEndMoovVideo(t, root, "first.mp4")
	secondPath := writeEndMoovVideo(t, root, "second.mp4")
	manager := newTestManager(t, root, &controlledBuilder{releases: map[string]chan struct{}{}}, testResolver{"first.mp4": firstPath, "second.mp4": secondPath})
	defer manager.Close()
	first := videoItem(t, "first", "first.mp4", firstPath)
	second := videoItem(t, "second", "second.mp4", secondPath)
	if _, err := manager.Request(first); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatus(t, manager, first, "ready")
	firstKey := manager.Status(first).CacheKey
	initial, ok := manager.Acquire(first, firstKey)
	if !ok {
		t.Fatal("initial first range unavailable")
	}
	initial.Release()

	if _, err := manager.Request(second); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatus(t, manager, second, "ready")
	for _, requestName := range []string{"middle range", "end range", "seek range"} {
		ready, ok := manager.Acquire(first, firstKey)
		if !ok {
			t.Fatalf("%s unavailable after replacement", requestName)
		}
		ready.Release()
	}
}

func TestManagerTransitionsFileDirectoryFileAndKeepsRetiredAssetsLeased(t *testing.T) {
	root := t.TempDir()
	fastFirstPath := writeEndMoovVideo(t, root, "first.mp4")
	hlsPath := filepath.Join(root, "long.mp4")
	if err := os.WriteFile(hlsPath, frontMoovFixture(), 0o600); err != nil {
		t.Fatal(err)
	}
	fastLastPath := writeEndMoovVideo(t, root, "last.mp4")
	hlsBuilder := &fakeHLSBuilder{plan: HLSPlan{
		Eligible: true, CacheKind: HLSCacheKind, DurationSeconds: 12,
		EstimatedOutputBytes: 1024, RequiredFreeBytes: 1024, PeakCacheBytes: 1024,
		TargetSegmentSeconds: 6, GOP: DurationStats{Count: 2, Min: 6, Median: 6, P95: 6, Max: 6},
	}}
	manager, err := NewManager(Options{
		CacheDir: filepath.Join(root, "cache"),
		Resolver: testResolver{"first.mp4": fastFirstPath, "long.mp4": hlsPath, "last.mp4": fastLastPath},
		Builder:  &controlledBuilder{releases: map[string]chan struct{}{}}, HLS: hlsBuilder,
		HLSOptions: HLSPlanOptions{MinimumMovieIndexBytes: 1, MaximumGOPSeconds: 8, TargetSegmentSeconds: 6},
		Space:      fixedSpace(1 << 40), RetireGrace: 10 * time.Millisecond, LeaseDuration: 100 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	first := videoItem(t, "first", "first.mp4", fastFirstPath)
	long := videoItem(t, "long", "long.mp4", hlsPath)
	last := videoItem(t, "last", "last.mp4", fastLastPath)
	if _, err := manager.Request(first); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatus(t, manager, first, "ready")
	firstKey := manager.Status(first).CacheKey
	if _, err := manager.RequestKind(long, HLSCacheKind); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatusKind(t, manager, long, HLSCacheKind, "ready")
	hlsStatus := manager.StatusKind(long, HLSCacheKind)
	if hlsStatus.SegmentCount != 2 || hlsStatus.URL == "" {
		t.Fatalf("HLS status=%#v", hlsStatus)
	}
	if hlsStatus.CacheUsedBytes <= 0 {
		t.Fatalf("HLS cache usage=%d, want packaged output bytes", hlsStatus.CacheUsedBytes)
	}
	if err := os.WriteFile(filepath.Join(manager.cacheDir, "untracked-root-file"), make([]byte, 4096), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := manager.StatusKind(long, HLSCacheKind).CacheUsedBytes; got != hlsStatus.CacheUsedBytes {
		t.Fatalf("cache usage counted untracked filesystem data: got=%d want=%d", got, hlsStatus.CacheUsedBytes)
	}
	if fastStatus := manager.Status(long); fastStatus.State != "ineligible" {
		t.Fatalf("faststart status=%#v", fastStatus)
	}
	if stillReady := manager.StatusKind(long, HLSCacheKind); stillReady.State != "ready" || stillReady.CacheKey != hlsStatus.CacheKey {
		t.Fatalf("cross-kind status retired HLS slot: %#v", stillReady)
	}
	oldFaststart, ok := manager.Acquire(first, firstKey)
	if !ok {
		t.Fatal("retired faststart unavailable after HLS publish")
	}
	oldFaststart.Release()
	manifest, ok := manager.AcquireHLSAsset(long, hlsStatus.CacheKey, hlsManifestName)
	if !ok || manifest.Asset.Kind != "manifest" {
		t.Fatal("HLS manifest unavailable")
	}
	manifest.Release()
	if _, err := manager.Request(last); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatus(t, manager, last, "ready")
	for _, asset := range []string{hlsManifestName, hlsInitName, "seg-000000.m4s", "seg-000001.m4s"} {
		ready, ok := manager.AcquireHLSAsset(long, hlsStatus.CacheKey, asset)
		if !ok {
			t.Fatalf("retired HLS asset %s unavailable", asset)
		}
		ready.Release()
	}
	retiredSegment, ok := manager.AcquireHLSAsset(long, hlsStatus.CacheKey, "seg-000001.m4s")
	if !ok {
		t.Fatal("retired segment unavailable before corruption")
	}
	retiredSegment.Release()
	if err := os.WriteFile(retiredSegment.Path, []byte("changed-size"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := manager.AcquireHLSAsset(long, hlsStatus.CacheKey, "seg-000001.m4s"); ok {
		t.Fatal("changed retired segment remained available")
	}
	if _, ok := manager.AcquireHLSAsset(long, hlsStatus.CacheKey, hlsManifestName); ok {
		t.Fatal("invalid retired generation continued serving assets")
	}
}

func TestManagerInvalidatesCurrentHLSWhenRegisteredSegmentChanges(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "long.mp4")
	if err := os.WriteFile(source, frontMoovFixture(), 0o600); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(Options{
		CacheDir: filepath.Join(root, "cache"), Resolver: testResolver{"long.mp4": source},
		Builder: &controlledBuilder{releases: map[string]chan struct{}{}}, HLS: &fakeHLSBuilder{plan: HLSPlan{
			Eligible: true, CacheKind: HLSCacheKind, DurationSeconds: 12,
			EstimatedOutputBytes: 1024, RequiredFreeBytes: 1024, TargetSegmentSeconds: 6,
		}},
		HLSOptions: HLSPlanOptions{MinimumMovieIndexBytes: 1, MaximumGOPSeconds: 8, TargetSegmentSeconds: 6},
		Space:      fixedSpace(1 << 40), RetireGrace: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	item := videoItem(t, "long", "long.mp4", source)
	if _, err := manager.RequestKind(item, HLSCacheKind); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatusKind(t, manager, item, HLSCacheKind, "ready")
	status := manager.StatusKind(item, HLSCacheKind)
	segment, ok := manager.AcquireHLSAsset(item, status.CacheKey, "seg-000001.m4s")
	if !ok {
		t.Fatal("segment unavailable before corruption")
	}
	segment.Release()
	if err := os.WriteFile(segment.Path, []byte("changed-size"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := manager.AcquireHLSAsset(item, status.CacheKey, "seg-000001.m4s"); ok {
		t.Fatal("changed segment remained available")
	}
	if got := manager.StatusKind(item, HLSCacheKind); got.State == "ready" || got.CacheKey != "" {
		t.Fatalf("corrupt package remained ready: %#v", got)
	}
	if _, ok := manager.AcquireHLSAsset(item, status.CacheKey, hlsManifestName); ok {
		t.Fatal("invalidated generation continued serving registered assets")
	}
}

func TestManagerRejectsStartupMetadataMissingPackagedAsset(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "long.mp4")
	if err := os.WriteFile(source, frontMoovFixture(), 0o600); err != nil {
		t.Fatal(err)
	}
	cacheDir := filepath.Join(root, "cache")
	options := Options{
		CacheDir: cacheDir, Resolver: testResolver{"long.mp4": source},
		Builder: &controlledBuilder{releases: map[string]chan struct{}{}}, HLS: &fakeHLSBuilder{plan: HLSPlan{
			Eligible: true, CacheKind: HLSCacheKind, DurationSeconds: 12,
			EstimatedOutputBytes: 1024, RequiredFreeBytes: 1024, TargetSegmentSeconds: 6,
		}},
		HLSOptions: HLSPlanOptions{MinimumMovieIndexBytes: 1, MaximumGOPSeconds: 8, TargetSegmentSeconds: 6},
		Space:      fixedSpace(1 << 40),
	}
	manager, err := NewManager(options)
	if err != nil {
		t.Fatal(err)
	}
	item := videoItem(t, "long", "long.mp4", source)
	if _, err := manager.RequestKind(item, HLSCacheKind); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatusKind(t, manager, item, HLSCacheKind, "ready")
	manager.Close()
	entry := loadEntry(cacheDir)
	if entry == nil {
		t.Fatal("ready metadata unavailable")
	}
	delete(entry.Assets, "seg-000001.m4s")
	if err := writeEntry(cacheDir, entry); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewManager(options)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if got := restarted.StatusKind(item, HLSCacheKind); got.State == "ready" || got.CacheKey != "" {
		t.Fatalf("incomplete metadata remained ready: %#v", got)
	}
}

func TestManagerDeletesRetiredHLSOutsideMutex(t *testing.T) {
	root := t.TempDir()
	firstPath := filepath.Join(root, "first.mp4")
	secondPath := filepath.Join(root, "second.mp4")
	for _, path := range []string{firstPath, secondPath} {
		if err := os.WriteFile(path, frontMoovFixture(), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	deleteStarted := make(chan struct{}, 1)
	allowDelete := make(chan struct{})
	var blockedPath atomic.Value
	blockedPath.Store("")
	manager, err := NewManager(Options{
		CacheDir: filepath.Join(root, "cache"), Resolver: testResolver{"first.mp4": firstPath, "second.mp4": secondPath},
		Builder: &controlledBuilder{releases: map[string]chan struct{}{}}, HLS: &fakeHLSBuilder{plan: HLSPlan{
			Eligible: true, CacheKind: HLSCacheKind, DurationSeconds: 12,
			EstimatedOutputBytes: 1024, RequiredFreeBytes: 1024, TargetSegmentSeconds: 6,
		}},
		HLSOptions: HLSPlanOptions{MinimumMovieIndexBytes: 1, MaximumGOPSeconds: 8, TargetSegmentSeconds: 6},
		Space:      fixedSpace(1 << 40), LeaseDuration: 10 * time.Millisecond, RetireGrace: 10 * time.Millisecond,
		RemoveAll: func(path string) error {
			if path == blockedPath.Load().(string) {
				select {
				case deleteStarted <- struct{}{}:
				default:
				}
				<-allowDelete
			}
			return os.RemoveAll(path)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	first := videoItem(t, "first", "first.mp4", firstPath)
	second := videoItem(t, "second", "second.mp4", secondPath)
	if _, err := manager.RequestKind(first, HLSCacheKind); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatusKind(t, manager, first, HLSCacheKind, "ready")
	firstStatus := manager.StatusKind(first, HLSCacheKind)
	firstManifest, ok := manager.AcquireHLSAsset(first, firstStatus.CacheKey, hlsManifestName)
	if !ok {
		t.Fatal("first manifest unavailable")
	}
	blockedPath.Store(filepath.Dir(firstManifest.Path))
	firstManifest.Release()
	if _, err := manager.RequestKind(second, HLSCacheKind); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatusKind(t, manager, second, HLSCacheKind, "ready")
	secondStatus := manager.StatusKind(second, HLSCacheKind)
	select {
	case <-deleteStarted:
	case <-time.After(time.Second):
		t.Fatal("retired HLS deletion did not start")
	}
	acquired := make(chan bool, 1)
	go func() {
		asset, ok := manager.AcquireHLSAsset(second, secondStatus.CacheKey, hlsManifestName)
		if ok {
			asset.Release()
		}
		acquired <- ok
	}()
	select {
	case ok := <-acquired:
		if !ok {
			t.Fatal("current HLS asset unavailable during retired deletion")
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("current HLS acquisition blocked on retired directory deletion")
	}
	close(allowDelete)
	waitForPathMissing(t, blockedPath.Load().(string))
}

func TestManagerRecoversHLSPackageAndRemovesOrphanDirectories(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "long.mp4")
	if err := os.WriteFile(source, frontMoovFixture(), 0o600); err != nil {
		t.Fatal(err)
	}
	cacheDir := filepath.Join(root, "cache")
	options := Options{
		CacheDir: cacheDir, Resolver: testResolver{"long.mp4": source},
		Builder:    &controlledBuilder{releases: map[string]chan struct{}{}},
		HLS:        &fakeHLSBuilder{plan: HLSPlan{Eligible: true, CacheKind: HLSCacheKind, DurationSeconds: 12, EstimatedOutputBytes: 1024, RequiredFreeBytes: 1024, TargetSegmentSeconds: 6}},
		HLSOptions: HLSPlanOptions{MinimumMovieIndexBytes: 1, MaximumGOPSeconds: 8, TargetSegmentSeconds: 6},
		Space:      fixedSpace(1 << 40), RetireGrace: 10 * time.Millisecond,
	}
	manager, err := NewManager(options)
	if err != nil {
		t.Fatal(err)
	}
	item := videoItem(t, "long", "long.mp4", source)
	if _, err := manager.RequestKind(item, HLSCacheKind); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatusKind(t, manager, item, HLSCacheKind, "ready")
	key := manager.StatusKind(item, HLSCacheKind).CacheKey
	manager.Close()
	orphan := filepath.Join(cacheDir, ".hls-orphan.tmp")
	if err := os.MkdirAll(orphan, 0o755); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewManager(options)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if got := restarted.StatusKind(item, HLSCacheKind); got.State != "ready" || got.CacheKey != key {
		t.Fatalf("restarted status=%#v", got)
	}
	if _, err := os.Stat(orphan); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("orphan directory remains: %v", err)
	}
	manifest, ok := restarted.AcquireHLSAsset(item, key, hlsManifestName)
	if !ok {
		t.Fatal("restarted manifest unavailable")
	}
	manifest.Release()
	if err := os.WriteFile(manifest.Path, []byte("not a manifest"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := restarted.StatusKind(item, HLSCacheKind); got.State == "ready" || got.CacheKey != "" {
		t.Fatalf("corrupt package remained ready: %#v", got)
	}
}

func TestManagerRetriesRetiredHLSDirectoryDeletion(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "long.mp4")
	if err := os.WriteFile(source, frontMoovFixture(), 0o600); err != nil {
		t.Fatal(err)
	}
	var removeCalls atomic.Int32
	manager, err := NewManager(Options{
		CacheDir: filepath.Join(root, "cache"), Resolver: testResolver{"long.mp4": source},
		Builder:    &controlledBuilder{releases: map[string]chan struct{}{}},
		HLS:        &fakeHLSBuilder{plan: HLSPlan{Eligible: true, CacheKind: HLSCacheKind, DurationSeconds: 12, EstimatedOutputBytes: 1024, RequiredFreeBytes: 1024, TargetSegmentSeconds: 6}},
		HLSOptions: HLSPlanOptions{MinimumMovieIndexBytes: 1, MaximumGOPSeconds: 8, TargetSegmentSeconds: 6},
		Space:      fixedSpace(1 << 40), LeaseDuration: 20 * time.Millisecond, RetireGrace: 10 * time.Millisecond,
		RemoveAll: func(path string) error {
			if removeCalls.Add(1) == 1 {
				return errors.New("simulated directory sharing violation")
			}
			return os.RemoveAll(path)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	item := videoItem(t, "long", "long.mp4", source)
	if _, err := manager.RequestKind(item, HLSCacheKind); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatusKind(t, manager, item, HLSCacheKind, "ready")
	status := manager.StatusKind(item, HLSCacheKind)
	manifest, ok := manager.AcquireHLSAsset(item, status.CacheKey, hlsManifestName)
	if !ok {
		t.Fatal("manifest unavailable")
	}
	manifest.Release()
	packageDir := filepath.Dir(manifest.Path)
	if !manager.Clear(item.ID, status.CacheKey) {
		t.Fatal("clear failed")
	}
	waitForPathMissing(t, packageDir)
	if removeCalls.Load() < 2 {
		t.Fatalf("directory delete calls=%d, want retry", removeCalls.Load())
	}
}

func TestManagerRetiresHLSWhenSourceFingerprintChanges(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "long.mp4")
	if err := os.WriteFile(source, frontMoovFixture(), 0o600); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(Options{
		CacheDir: filepath.Join(root, "cache"), Resolver: testResolver{"long.mp4": source},
		Builder:    &controlledBuilder{releases: map[string]chan struct{}{}},
		HLS:        &fakeHLSBuilder{plan: HLSPlan{Eligible: true, CacheKind: HLSCacheKind, DurationSeconds: 12, EstimatedOutputBytes: 1024, RequiredFreeBytes: 1024, TargetSegmentSeconds: 6}},
		HLSOptions: HLSPlanOptions{MinimumMovieIndexBytes: 1, MaximumGOPSeconds: 8, TargetSegmentSeconds: 6},
		Space:      fixedSpace(1 << 40), RetireGrace: 10 * time.Millisecond, LeaseDuration: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	item := videoItem(t, "long", "long.mp4", source)
	if _, err := manager.RequestKind(item, HLSCacheKind); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatusKind(t, manager, item, HLSCacheKind, "ready")
	status := manager.StatusKind(item, HLSCacheKind)
	manifest, ok := manager.AcquireHLSAsset(item, status.CacheKey, hlsManifestName)
	if !ok {
		t.Fatal("manifest unavailable")
	}
	manifest.Release()
	file, err := os.OpenFile(source, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(atom32("free", nil)); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	changed := videoItem(t, "long", "long.mp4", source)
	if got := manager.StatusKind(changed, HLSCacheKind); got.State == "ready" || got.CacheKey != "" {
		t.Fatalf("changed source kept HLS ready: %#v", got)
	}
	waitForPathMissing(t, filepath.Dir(manifest.Path))
}

type ineligibleBuilder struct{ calls int }

func (b *ineligibleBuilder) Build(context.Context, string, string) error {
	b.calls++
	return fmt.Errorf("%w: attachment track", ErrNotEligible)
}

func TestManagerCachesIneligibleProbeResultBySourceFingerprint(t *testing.T) {
	root := t.TempDir()
	path := writeEndMoovVideo(t, root, "video.mp4")
	builder := &ineligibleBuilder{}
	manager := newTestManager(t, root, builder, testResolver{"video.mp4": path})
	defer manager.Close()
	item := videoItem(t, "video", "video.mp4", path)
	if _, err := manager.Request(item); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatus(t, manager, item, "ineligible")
	if _, err := manager.Request(item); !errors.Is(err, ErrNotEligible) {
		t.Fatalf("second request error=%v", err)
	}
	if builder.calls != 1 {
		t.Fatalf("builder calls=%d, want cached single probe", builder.calls)
	}

	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(atom32("free", nil)); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	changed := videoItem(t, "video", "video.mp4", path)
	if _, err := manager.Request(changed); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatus(t, manager, changed, "ineligible")
	if builder.calls != 2 {
		t.Fatalf("changed fingerprint builder calls=%d", builder.calls)
	}
}

func TestManagerCachesHLSIneligibleReasonBySourceFingerprint(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "long.mp4")
	if err := os.WriteFile(path, frontMoovFixture(), 0o600); err != nil {
		t.Fatal(err)
	}
	hls := &fakeHLSBuilder{plan: HLSPlan{
		CacheKind: HLSCacheKind, Reason: "embedded subtitles are not supported by the HLS sidecar",
		EstimatedOutputBytes: 1024, RequiredFreeBytes: 1024, TargetSegmentSeconds: 6,
	}}
	manager, err := NewManager(Options{
		CacheDir: filepath.Join(root, "cache"), Resolver: testResolver{"long.mp4": path},
		Builder: &controlledBuilder{releases: map[string]chan struct{}{}}, HLS: hls,
		HLSOptions: HLSPlanOptions{MinimumMovieIndexBytes: 1, MaximumGOPSeconds: 8, TargetSegmentSeconds: 6},
		Space:      fixedSpace(1 << 40),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	item := videoItem(t, "long", "long.mp4", path)
	if _, err := manager.RequestKind(item, HLSCacheKind); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatusKind(t, manager, item, HLSCacheKind, "ineligible")
	if status := manager.StatusKind(item, HLSCacheKind); !strings.Contains(status.Reason, "subtitles") {
		t.Fatalf("status=%#v", status)
	}
	if _, err := manager.RequestKind(item, HLSCacheKind); !errors.Is(err, ErrNotEligible) {
		t.Fatalf("second request error=%v", err)
	}
	if hls.calls != 1 {
		t.Fatalf("HLS planner calls=%d", hls.calls)
	}
}

func TestManagerJoinsSameBuildAndCancelsDifferentBuild(t *testing.T) {
	root := t.TempDir()
	first := writeEndMoovVideo(t, root, "first.mp4")
	second := writeEndMoovVideo(t, root, "second.mp4")
	builder := &controlledBuilder{started: make(chan string, 2), releases: map[string]chan struct{}{"first.mp4": make(chan struct{})}}
	manager := newTestManager(t, root, builder, testResolver{"first.mp4": first, "second.mp4": second})
	defer manager.Close()
	firstItem := videoItem(t, "first", "first.mp4", first)
	secondItem := videoItem(t, "second", "second.mp4", second)
	if _, err := manager.Request(firstItem); err != nil {
		t.Fatal(err)
	}
	<-builder.started
	if _, err := manager.Request(firstItem); err != nil {
		t.Fatal(err)
	}
	select {
	case name := <-builder.started:
		t.Fatalf("same build restarted: %s", name)
	case <-time.After(20 * time.Millisecond):
	}
	if _, err := manager.Request(secondItem); err != nil {
		t.Fatal(err)
	}
	if name := <-builder.started; name != "second.mp4" {
		t.Fatalf("started = %q", name)
	}
	waitForVideoStatus(t, manager, secondItem, "ready")
}

func TestManagerClearWaitsForActiveResponse(t *testing.T) {
	root := t.TempDir()
	path := writeEndMoovVideo(t, root, "video.mp4")
	manager := newTestManager(t, root, &controlledBuilder{releases: map[string]chan struct{}{}}, testResolver{"video.mp4": path})
	defer manager.Close()
	item := videoItem(t, "video", "video.mp4", path)
	if _, err := manager.Request(item); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatus(t, manager, item, "ready")
	status := manager.Status(item)
	ready, ok := manager.Acquire(item, status.CacheKey)
	if !ok {
		t.Fatal("sidecar not ready")
	}
	if !manager.Clear(item.ID, status.CacheKey) {
		t.Fatal("clear did not retire ready generation")
	}
	time.Sleep(30 * time.Millisecond)
	if _, err := os.Stat(ready.Path); err != nil {
		t.Fatalf("active sidecar removed: %v", err)
	}
	ready.Release()
	waitForPathMissing(t, ready.Path)
}

func TestManagerUsesOneCleanupTimerAndRetriesDeleteFailure(t *testing.T) {
	root := t.TempDir()
	path := writeEndMoovVideo(t, root, "video.mp4")
	var removeCalls atomic.Int32
	manager, err := NewManager(Options{
		CacheDir: filepath.Join(root, "cache"), Resolver: testResolver{"video.mp4": path},
		Builder: &controlledBuilder{releases: map[string]chan struct{}{}}, Space: fixedSpace(1 << 40),
		LeaseDuration: 100 * time.Millisecond, RetireGrace: 10 * time.Millisecond,
		Remove: func(path string) error {
			if removeCalls.Add(1) == 1 {
				return errors.New("simulated Windows sharing violation")
			}
			return os.Remove(path)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	item := videoItem(t, "video", "video.mp4", path)
	if _, err := manager.Request(item); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatus(t, manager, item, "ready")
	status := manager.Status(item)
	ready, ok := manager.Acquire(item, status.CacheKey)
	if !ok {
		t.Fatal("ready unavailable")
	}
	if !manager.Clear(item.ID, status.CacheKey) {
		t.Fatal("clear failed")
	}
	for range 5 {
		next, ok := manager.Acquire(item, status.CacheKey)
		if !ok {
			t.Fatal("retired generation unavailable")
		}
		next.Release()
		manager.mu.Lock()
		if manager.cleanupTimer != nil {
			manager.mu.Unlock()
			t.Fatal("cleanup timer should pause while a retired response is active")
		}
		manager.mu.Unlock()
	}
	ready.Release()
	manager.mu.Lock()
	if manager.cleanupTimer == nil {
		manager.mu.Unlock()
		t.Fatal("retired generation did not schedule its single cleanup timer")
	}
	manager.mu.Unlock()
	waitForPathMissing(t, ready.Path)
	if removeCalls.Load() < 2 {
		t.Fatalf("delete calls=%d, want retry", removeCalls.Load())
	}
}

func TestManagerCancelReplacementPreservesPreviousReady(t *testing.T) {
	root := t.TempDir()
	first := writeEndMoovVideo(t, root, "first.mp4")
	second := writeEndMoovVideo(t, root, "second.mp4")
	builder := &controlledBuilder{started: make(chan string, 2), releases: map[string]chan struct{}{"second.mp4": make(chan struct{})}}
	manager := newTestManager(t, root, builder, testResolver{"first.mp4": first, "second.mp4": second})
	defer manager.Close()
	firstItem := videoItem(t, "first", "first.mp4", first)
	secondItem := videoItem(t, "second", "second.mp4", second)
	if _, err := manager.Request(firstItem); err != nil {
		t.Fatal(err)
	}
	<-builder.started
	waitForVideoStatus(t, manager, firstItem, "ready")
	if _, err := manager.Request(secondItem); err != nil {
		t.Fatal(err)
	}
	<-builder.started
	if !manager.Cancel(secondItem.ID) {
		t.Fatal("active replacement was not cancelled")
	}
	if got := manager.Status(firstItem); got.State != "ready" || got.BuildingMediaID != "" {
		t.Fatalf("previous ready after cancel=%#v", got)
	}
}

func TestManagerRebuildAfterClearUsesNewImmutableGeneration(t *testing.T) {
	root := t.TempDir()
	path := writeEndMoovVideo(t, root, "video.mp4")
	manager := newTestManager(t, root, &controlledBuilder{releases: map[string]chan struct{}{}}, testResolver{"video.mp4": path})
	defer manager.Close()
	item := videoItem(t, "video", "video.mp4", path)
	if _, err := manager.Request(item); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatus(t, manager, item, "ready")
	firstKey := manager.Status(item).CacheKey
	if !manager.Clear(item.ID, firstKey) {
		t.Fatal("clear failed")
	}
	if _, err := manager.Request(item); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatus(t, manager, item, "ready")
	if secondKey := manager.Status(item).CacheKey; secondKey == firstKey {
		t.Fatalf("cache key reused: %s", secondKey)
	}
}

type cancelGate struct {
	mu     sync.Mutex
	cancel context.CancelFunc
}

type waitingGate struct{ release chan struct{} }

func (g *waitingGate) WaitForMediaQuiet(ctx context.Context, _ time.Duration) error {
	select {
	case <-g.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (*waitingGate) BackgroundWorkContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithCancel(parent)
}

func TestManagerReturnsBuildingBeforeGatedProbeStarts(t *testing.T) {
	root := t.TempDir()
	path := writeEndMoovVideo(t, root, "video.mp4")
	builder := &controlledBuilder{started: make(chan string, 1), releases: map[string]chan struct{}{}}
	gate := &waitingGate{release: make(chan struct{})}
	manager, err := NewManager(Options{CacheDir: filepath.Join(root, "cache"), Resolver: testResolver{"video.mp4": path}, Builder: builder, Idle: gate, Space: fixedSpace(1 << 40)})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	item := videoItem(t, "video", "video.mp4", path)
	status, err := manager.Request(item)
	if err != nil || status.State != "building" {
		t.Fatalf("request status=%#v error=%v", status, err)
	}
	select {
	case <-builder.started:
		t.Fatal("builder probe started before media quiet gate")
	default:
	}
	close(gate.release)
	select {
	case <-builder.started:
	case <-time.After(time.Second):
		t.Fatal("builder did not start after gate")
	}
}

func TestManagerRechecksSpaceAfterMediaQuietGate(t *testing.T) {
	root := t.TempDir()
	path := writeEndMoovVideo(t, root, "video.mp4")
	builder := &controlledBuilder{started: make(chan string, 1), releases: map[string]chan struct{}{}}
	gate := &waitingGate{release: make(chan struct{})}
	space := &mutableSpace{}
	space.available.Store(1 << 40)
	manager, err := NewManager(Options{
		CacheDir: filepath.Join(root, "cache"), Resolver: testResolver{"video.mp4": path},
		Builder: builder, Idle: gate, Space: space,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	item := videoItem(t, "video", "video.mp4", path)
	if status, err := manager.Request(item); err != nil || status.State != "building" {
		t.Fatalf("request status=%#v error=%v", status, err)
	}
	space.available.Store(1)
	close(gate.release)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		status := manager.Status(item)
		if status.BuildingMediaID == "" {
			if status.State != "insufficient-space" {
				t.Fatalf("status after space loss=%#v", status)
			}
			select {
			case name := <-builder.started:
				t.Fatalf("builder started after space loss: %s", name)
			default:
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("build did not stop after space loss")
}

func (*cancelGate) WaitForMediaQuiet(context.Context, time.Duration) error { return nil }
func (g *cancelGate) BackgroundWorkContext(parent context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	g.mu.Lock()
	g.cancel = cancel
	g.mu.Unlock()
	return ctx, cancel
}
func (g *cancelGate) beginMediaStream() {
	g.mu.Lock()
	cancel := g.cancel
	g.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func TestManagerBackgroundBuildStopsWhenMediaStreamBegins(t *testing.T) {
	root := t.TempDir()
	path := writeEndMoovVideo(t, root, "video.mp4")
	builder := &controlledBuilder{started: make(chan string, 1), releases: map[string]chan struct{}{"video.mp4": make(chan struct{})}}
	gate := &cancelGate{}
	manager, err := NewManager(Options{CacheDir: filepath.Join(root, "cache"), Resolver: testResolver{"video.mp4": path}, Builder: builder, Idle: gate, Space: fixedSpace(1 << 40), QuietGrace: time.Millisecond, RetireGrace: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	item := videoItem(t, "video", "video.mp4", path)
	if _, err := manager.Request(item); err != nil {
		t.Fatal(err)
	}
	<-builder.started
	gate.beginMediaStream()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if got := manager.Status(item); got.State == "eligible" && got.BuildingMediaID == "" {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("build remained active: %#v", manager.Status(item))
}

func TestManagerTreatsCanceledHLSFFmpegAsNormalBackgroundCancellation(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "long.mp4")
	if err := os.WriteFile(path, frontMoovFixture(), 0o600); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(root, "hls-ffmpeg-started")
	command := func(ctx context.Context, name string, args ...string) *exec.Cmd {
		joined := strings.Join(args, " ")
		switch {
		case name == "ffmpeg":
			return longRunningTestCommand(ctx, marker)
		case strings.Contains(joined, "frame=best_effort_timestamp_time"):
			return exec.CommandContext(ctx, "sh", "-c", `printf '%s' '{"frames":[{"best_effort_timestamp_time":"0"},{"best_effort_timestamp_time":"5"},{"best_effort_timestamp_time":"10"},{"best_effort_timestamp_time":"15"}]}'`)
		default:
			return exec.CommandContext(ctx, "sh", "-c", `printf '%s' '{"streams":[{"codec_type":"video","codec_name":"h264","profile":"High","level":40,"pix_fmt":"yuv420p","codec_tag_string":"avc1","field_order":"progressive","avg_frame_rate":"30/1","r_frame_rate":"30/1"}],"format":{"duration":"20"}}'`)
		}
	}
	probe := FFmpegBuilder{Path: "ffmpeg", ProbePath: "ffprobe", Command: command}
	gate := &cancelGate{}
	manager, err := NewManager(Options{
		CacheDir: filepath.Join(root, "cache"), Resolver: testResolver{"long.mp4": path},
		Builder: &controlledBuilder{releases: map[string]chan struct{}{}},
		HLS: FFmpegHLSPackager{Planner: HLSPlanner{
			Probe: probe,
			Options: HLSPlanOptions{
				MinimumMovieIndexBytes: 1, MaximumGOPSeconds: 8, TargetSegmentSeconds: 6,
			},
		}, Command: command},
		HLSOptions: HLSPlanOptions{MinimumMovieIndexBytes: 1, MaximumGOPSeconds: 8, TargetSegmentSeconds: 6},
		Idle:       gate, Space: fixedSpace(1 << 40), QuietGrace: time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	item := videoItem(t, "long", "long.mp4", path)
	if _, err := manager.RequestKind(item, HLSCacheKind); err != nil {
		t.Fatal(err)
	}
	waitForCommandMarker(t, marker)
	gate.beginMediaStream()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		status := manager.StatusKind(item, HLSCacheKind)
		if status.BuildingMediaID == "" {
			if status.State != "eligible" {
				t.Fatalf("canceled HLS build became failure: %#v", status)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("canceled HLS build remained active: %#v", manager.StatusKind(item, HLSCacheKind))
}

type builderFunc func(context.Context, string, string) error

func (fn builderFunc) Build(ctx context.Context, source, output string) error {
	return fn(ctx, source, output)
}

func TestManagerDoesNotPublishWhenMediaStartsAfterBuilderReturns(t *testing.T) {
	root := t.TempDir()
	path := writeEndMoovVideo(t, root, "video.mp4")
	gate := &cancelGate{}
	builder := builderFunc(func(_ context.Context, _, output string) error {
		if err := os.WriteFile(output, frontMoovFixture(), 0o600); err != nil {
			return err
		}
		gate.beginMediaStream()
		return nil
	})
	manager, err := NewManager(Options{
		CacheDir: filepath.Join(root, "cache"), Resolver: testResolver{"video.mp4": path},
		Builder: builder, Idle: gate, Space: fixedSpace(1 << 40), QuietGrace: time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	item := videoItem(t, "video", "video.mp4", path)
	if _, err := manager.Request(item); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		status := manager.Status(item)
		if status.BuildingMediaID == "" {
			if status.State == "ready" {
				t.Fatalf("canceled output was published: %#v", status)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("canceled post-build output did not finish")
}

func TestManagerDoesNotPublishWhenSourceChangesDuringBuild(t *testing.T) {
	root := t.TempDir()
	path := writeEndMoovVideo(t, root, "video.mp4")
	release := make(chan struct{})
	builder := &controlledBuilder{started: make(chan string, 1), releases: map[string]chan struct{}{"video.mp4": release}}
	manager := newTestManager(t, root, builder, testResolver{"video.mp4": path})
	defer manager.Close()
	item := videoItem(t, "video", "video.mp4", path)
	if _, err := manager.Request(item); err != nil {
		t.Fatal(err)
	}
	<-builder.started
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(atom32("free", nil)); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	close(release)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		status := manager.Status(videoItem(t, "video", "video.mp4", path))
		if status.BuildingMediaID == "" {
			if status.State == "ready" {
				t.Fatalf("changed source was published: %#v", status)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("build did not finish")
}

func TestManagerRejectsInsufficientSpaceWithoutBuilding(t *testing.T) {
	root := t.TempDir()
	path := writeEndMoovVideo(t, root, "video.mp4")
	builder := &controlledBuilder{started: make(chan string, 1), releases: map[string]chan struct{}{}}
	manager, err := NewManager(Options{CacheDir: filepath.Join(root, "cache"), Resolver: testResolver{"video.mp4": path}, Builder: builder, Space: fixedSpace(1)})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	item := videoItem(t, "video", "video.mp4", path)
	status, err := manager.Request(item)
	if !errors.Is(err, ErrInsufficientSpace) || status.State != "insufficient-space" {
		t.Fatalf("status=%#v error=%v", status, err)
	}
	select {
	case <-builder.started:
		t.Fatal("build started without space")
	default:
	}
}

func TestManagerSeparatesPeakCacheUsageFromRequiredFreeMargin(t *testing.T) {
	root := t.TempDir()
	path := writeEndMoovVideo(t, root, "video.mp4")
	manager := newTestManager(t, root, &controlledBuilder{releases: map[string]chan struct{}{}}, testResolver{"video.mp4": path})
	defer manager.Close()
	item := videoItem(t, "video", "video.mp4", path)
	status := manager.Status(item)
	if status.PeakCacheBytes != status.CacheUsedBytes+status.EstimatedOutputBytes {
		t.Fatalf("peak=%d used=%d output=%d", status.PeakCacheBytes, status.CacheUsedBytes, status.EstimatedOutputBytes)
	}
	if status.RequiredFreeBytes <= status.PeakCacheBytes-status.CacheUsedBytes {
		t.Fatalf("required free=%d does not include safety margin", status.RequiredFreeBytes)
	}
}

func TestManagerReportsFrontMoovWithoutOfferingPreparation(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "front.mp4")
	if err := os.WriteFile(path, frontMoovFixture(), 0o600); err != nil {
		t.Fatal(err)
	}
	manager := newTestManager(t, root, &controlledBuilder{releases: map[string]chan struct{}{}}, testResolver{"front.mp4": path})
	defer manager.Close()
	status := manager.Status(videoItem(t, "front", "front.mp4", path))
	if status.State != "ineligible" || status.Layout != LayoutFrontMoov || status.MovieIndexBytes == 0 {
		t.Fatalf("front status=%#v", status)
	}
}

func TestManagerRetiresCurrentWhenSourceBecomesStale(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*testing.T, string)
	}{
		{name: "layout changes", mutate: func(t *testing.T, path string) {
			if err := os.WriteFile(path, frontMoovFixture(), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "source disappears", mutate: func(t *testing.T, path string) {
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			path := writeEndMoovVideo(t, root, "video.mp4")
			manager := newTestManager(t, root, &controlledBuilder{releases: map[string]chan struct{}{}}, testResolver{"video.mp4": path})
			defer manager.Close()
			item := videoItem(t, "video", "video.mp4", path)
			if _, err := manager.Request(item); err != nil {
				t.Fatal(err)
			}
			waitForVideoStatus(t, manager, item, "ready")
			status := manager.Status(item)
			ready, ok := manager.Acquire(item, status.CacheKey)
			if !ok {
				t.Fatal("ready sidecar unavailable")
			}
			ready.Release()

			test.mutate(t, path)
			stale := manager.Status(item)
			if stale.State == "ready" || stale.CacheKey != "" {
				t.Fatalf("stale status=%#v", stale)
			}
			manager.mu.Lock()
			current := manager.current
			_, retired := manager.retired[status.CacheKey]
			manager.mu.Unlock()
			if current != nil || !retired {
				t.Fatalf("current=%#v retired=%v", current, retired)
			}
			waitForPathMissing(t, ready.Path)
		})
	}
}

func TestManagerRecoversReadyMetadataAndRemovesOrphans(t *testing.T) {
	root := t.TempDir()
	path := writeEndMoovVideo(t, root, "video.mp4")
	cacheDir := filepath.Join(root, "cache")
	builder := &controlledBuilder{releases: map[string]chan struct{}{}}
	item := videoItem(t, "video", "video.mp4", path)
	manager, err := NewManager(Options{CacheDir: cacheDir, Resolver: testResolver{"video.mp4": path}, Builder: builder, Space: fixedSpace(1 << 40), RetireGrace: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Request(item); err != nil {
		t.Fatal(err)
	}
	waitForVideoStatus(t, manager, item, "ready")
	status := manager.Status(item)
	manager.Close()
	if err := os.WriteFile(filepath.Join(cacheDir, ".faststart-orphan.mp4.tmp"), []byte("orphan"), 0o600); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewManager(Options{CacheDir: cacheDir, Resolver: testResolver{"video.mp4": path}, Builder: builder, Space: fixedSpace(1 << 40), RetireGrace: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if got := restarted.Status(item); got.State != "ready" || got.CacheKey != status.CacheKey {
		t.Fatalf("restarted status=%#v", got)
	}
	if _, err := os.Stat(filepath.Join(cacheDir, ".faststart-orphan.mp4.tmp")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("orphan still exists: %v", err)
	}
}

func newTestManager(t *testing.T, root string, builder Builder, resolver Resolver) *Manager {
	t.Helper()
	manager, err := NewManager(Options{CacheDir: filepath.Join(root, "cache"), Resolver: resolver, Builder: builder, Space: fixedSpace(1 << 40), RetireGrace: 10 * time.Millisecond, LeaseDuration: 20 * time.Millisecond, QuietGrace: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	return manager
}

func writeEndMoovVideo(t *testing.T, root, name string) string {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.WriteFile(path, endMoovFixture(), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func frontMoovFixture() []byte {
	return bytes.Join([][]byte{atom32("ftyp", nil), atom32("moov", []byte("index")), atom32("mdat", []byte("media"))}, nil)
}
func endMoovFixture() []byte {
	return bytes.Join([][]byte{atom32("ftyp", nil), atom32("mdat", []byte("media")), atom32("moov", []byte("index"))}, nil)
}

func videoItem(t *testing.T, id, name, path string) library.Media {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return library.Media{ID: id, Type: library.MediaTypeVideo, RootName: "root", RelativePath: name, Name: name, MIMEType: "video/mp4", SizeBytes: info.Size(), ModifiedAt: info.ModTime()}
}

func waitForVideoStatus(t *testing.T, manager *Manager, item library.Media, state string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if manager.Status(item).State == state {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("status did not become %s: %#v", state, manager.Status(item))
}

func waitForVideoStatusKind(t *testing.T, manager *Manager, item library.Media, kind, state string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if status := manager.StatusKind(item, kind); status.State == state {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("status did not become %s: %#v", state, manager.StatusKind(item, kind))
}

func waitForPathMissing(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("path was not cleaned: %s", path)
}
