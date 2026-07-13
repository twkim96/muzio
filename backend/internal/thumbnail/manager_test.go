package thumbnail

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"muzio/backend/internal/library"
)

type fakeResolver struct {
	path string
	err  error
}

func (r fakeResolver) ResolveStrict(string, string) (string, error) {
	return r.path, r.err
}

type fakeExtractor struct {
	calls     atomic.Int32
	active    atomic.Int32
	maxActive atomic.Int32
	failures  atomic.Int32
	release   <-chan struct{}
	err       error
}

type fakeIdleWaiter struct {
	started chan struct{}
	release <-chan struct{}
	once    sync.Once
	calls   atomic.Int32
}

type interruptibleIdleGate struct {
	mu      sync.Mutex
	started chan struct{}
}

func newInterruptibleIdleGate() *interruptibleIdleGate {
	return &interruptibleIdleGate{started: make(chan struct{})}
}

func (*interruptibleIdleGate) WaitForMediaIdle(context.Context) error {
	return nil
}

func (*interruptibleIdleGate) WaitForMediaQuiet(
	context.Context,
	time.Duration,
) error {
	return nil
}

func (g *interruptibleIdleGate) BackgroundWorkContext(
	parent context.Context,
) (context.Context, context.CancelFunc) {
	g.mu.Lock()
	started := g.started
	g.mu.Unlock()
	ctx, cancel := context.WithCancel(parent)
	go func() {
		select {
		case <-started:
			cancel()
		case <-ctx.Done():
		}
	}()
	return ctx, cancel
}

func (g *interruptibleIdleGate) beginStream() {
	g.mu.Lock()
	close(g.started)
	g.started = make(chan struct{})
	g.mu.Unlock()
}

func (w *fakeIdleWaiter) WaitForMediaIdle(ctx context.Context) error {
	w.calls.Add(1)
	w.once.Do(func() { close(w.started) })
	select {
	case <-w.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (e *fakeExtractor) Extract(ctx context.Context, _, output string) error {
	e.calls.Add(1)
	active := e.active.Add(1)
	defer e.active.Add(-1)
	for {
		max := e.maxActive.Load()
		if active <= max || e.maxActive.CompareAndSwap(max, active) {
			break
		}
	}
	if e.release != nil {
		select {
		case <-e.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	for {
		remaining := e.failures.Load()
		if remaining <= 0 {
			break
		}
		if e.failures.CompareAndSwap(remaining, remaining-1) {
			return errors.New("temporary extraction failure")
		}
	}
	if e.err != nil {
		return e.err
	}
	return os.WriteFile(output, []byte("jpeg"), 0o600)
}

func video(id, cacheKey string) library.Media {
	return library.Media{
		ID:           id,
		Type:         library.MediaTypeVideo,
		RootName:     "video",
		RelativePath: id + ".mp4",
		Thumbnail: library.Thumbnail{
			CacheKey: cacheKey,
			Status:   library.ThumbnailStatusPending,
		},
	}
}

func imageItem(id, cacheKey string) library.Media {
	return library.Media{
		ID:           id,
		Type:         library.MediaTypeImage,
		RootName:     "image",
		RelativePath: id + ".png",
		Thumbnail: library.Thumbnail{
			CacheKey: cacheKey,
			Status:   library.ThumbnailStatusPending,
		},
	}
}

func TestEnqueueReadyItemSkipsRedundantReadyCallback(t *testing.T) {
	item := video("ready", "ready-key")
	item.Thumbnail.Status = library.ThumbnailStatusReady
	var readyCalls atomic.Int32
	manager, err := NewManager(Options{
		CacheDir: t.TempDir(),
		Resolver: fakeResolver{},
		Extract:  &fakeExtractor{},
		OnReady: func(library.Media) {
			readyCalls.Add(1)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	if err := os.WriteFile(manager.Path(item), []byte("jpeg"), 0o600); err != nil {
		t.Fatal(err)
	}

	if manager.Enqueue(item) {
		t.Fatal("ready item was queued")
	}
	if got := readyCalls.Load(); got != 0 {
		t.Fatalf("ready callbacks = %d, want 0", got)
	}
}

func TestEnqueueReadyPendingItemPublishesReadyOnce(t *testing.T) {
	item := video("pending", "pending-key")
	var readyCalls atomic.Int32
	manager, err := NewManager(Options{
		CacheDir: t.TempDir(),
		Resolver: fakeResolver{},
		Extract:  &fakeExtractor{},
		OnReady: func(library.Media) {
			readyCalls.Add(1)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	if err := os.WriteFile(manager.Path(item), []byte("jpeg"), 0o600); err != nil {
		t.Fatal(err)
	}

	manager.Enqueue(item)
	if got := readyCalls.Load(); got != 1 {
		t.Fatalf("ready callbacks = %d, want 1", got)
	}
}

func TestPlaybackInterruptionRequeuesWithoutFailure(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source.mp4")
	if err := os.WriteFile(source, []byte("video"), 0o600); err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	extractor := &fakeExtractor{release: release}
	gate := newInterruptibleIdleGate()
	var failures atomic.Int32
	manager, err := NewManager(Options{
		CacheDir:    filepath.Join(dir, "cache"),
		Resolver:    fakeResolver{path: source},
		Idle:        gate,
		Extract:     extractor,
		RetryBase:   time.Millisecond,
		RetryMax:    time.Millisecond,
		MaxAttempts: 1,
		OnFailure: func(library.Media) {
			failures.Add(1)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	item := video("interrupt", "interrupt-key")
	manager.Enqueue(item)
	waitFor(t, func() bool { return extractor.calls.Load() == 1 })

	gate.beginStream()
	waitFor(t, func() bool { return extractor.calls.Load() >= 2 })
	close(release)
	waitFor(t, func() bool { return manager.Ready(item) })

	if got := failures.Load(); got != 0 {
		t.Fatalf("failure callbacks = %d, want 0", got)
	}
}

func TestManagerUsesDedicatedImageWorker(t *testing.T) {
	extractor := &fakeExtractor{}
	manager, err := NewManager(Options{
		CacheDir:     t.TempDir(),
		Resolver:     fakeResolver{path: "/media"},
		Extract:      extractor,
		ImageExtract: extractor,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()

	manager.Sync([]library.Media{
		video("video", "video-key"),
		imageItem("image", "image-key"),
	})
	waitFor(t, func() bool {
		return manager.Ready(video("video", "video-key")) &&
			manager.Ready(imageItem("image", "image-key"))
	})
	if extractor.maxActive.Load() > 2 {
		t.Fatalf("max active extractors = %d, want at most 2", extractor.maxActive.Load())
	}
}

func TestManagerRunsVideoWhileImageWorkerIsBusy(t *testing.T) {
	imageRelease := make(chan struct{})
	imageExtractor := &fakeExtractor{release: imageRelease}
	videoExtractor := &fakeExtractor{}
	manager, err := NewManager(Options{
		CacheDir:     t.TempDir(),
		Resolver:     fakeResolver{path: "/media"},
		Extract:      videoExtractor,
		ImageExtract: imageExtractor,
		Workers:      2,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()

	image := imageItem("image", "image-key")
	video := video("video", "video-key")
	manager.Sync([]library.Media{image, video})
	waitFor(t, func() bool { return imageExtractor.active.Load() == 1 })
	waitFor(t, func() bool { return manager.Ready(video) })
	if videoExtractor.calls.Load() != 1 {
		t.Fatalf("video extractor calls = %d, want 1", videoExtractor.calls.Load())
	}

	close(imageRelease)
	waitFor(t, func() bool { return manager.Ready(image) })
}

func TestManagerDeduplicatesAndRunsOneExtractor(t *testing.T) {
	release := make(chan struct{})
	extractor := &fakeExtractor{release: release}
	var readyMu sync.Mutex
	var ready []string
	manager, err := NewManager(Options{
		CacheDir: t.TempDir(),
		Resolver: fakeResolver{path: "/video.mp4"},
		Extract:  extractor,
		OnReady: func(item library.Media) {
			readyMu.Lock()
			ready = append(ready, item.ID)
			readyMu.Unlock()
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()

	if !manager.Enqueue(video("a", "key-a")) {
		t.Fatal("first enqueue rejected")
	}
	if manager.Enqueue(video("a", "key-a")) {
		t.Fatal("duplicate enqueue accepted")
	}
	if !manager.Enqueue(video("b", "key-b")) {
		t.Fatal("second key enqueue rejected")
	}
	close(release)
	waitFor(t, func() bool {
		if !manager.Ready(video("a", "key-a")) ||
			!manager.Ready(video("b", "key-b")) {
			return false
		}
		readyMu.Lock()
		defer readyMu.Unlock()
		return len(ready) == 2
	})
	if extractor.maxActive.Load() != 1 {
		t.Fatalf("max active extractors = %d", extractor.maxActive.Load())
	}
	readyMu.Lock()
	defer readyMu.Unlock()
	if len(ready) != 2 {
		t.Fatalf("ready callbacks = %v", ready)
	}
}

func TestManagerSkipsExistingCache(t *testing.T) {
	cacheDir := t.TempDir()
	item := video("a", "key-a")
	if err := os.WriteFile(filepath.Join(cacheDir, "key-a.jpg"), []byte("jpeg"), 0o600); err != nil {
		t.Fatal(err)
	}
	extractor := &fakeExtractor{}
	ready := make(chan struct{}, 1)
	manager, err := NewManager(Options{
		CacheDir: cacheDir,
		Resolver: fakeResolver{},
		Extract:  extractor,
		OnReady: func(library.Media) {
			ready <- struct{}{}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	if manager.Enqueue(item) {
		t.Fatal("existing cache was queued")
	}
	select {
	case <-ready:
	case <-time.After(time.Second):
		t.Fatal("ready callback not delivered")
	}
	if extractor.calls.Load() != 0 {
		t.Fatalf("extractor calls = %d", extractor.calls.Load())
	}
}

func TestManagerRunsWorkersConcurrentlyWhenIdle(t *testing.T) {
	const workers = 3
	release := make(chan struct{})
	extractor := &fakeExtractor{release: release}
	manager, err := NewManager(Options{
		CacheDir: t.TempDir(),
		Resolver: fakeResolver{path: "/video.mp4"},
		Extract:  extractor,
		Workers:  workers,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()

	items := []library.Media{
		video("a", "key-a"),
		video("b", "key-b"),
		video("c", "key-c"),
	}
	for _, item := range items {
		if !manager.Enqueue(item) {
			t.Fatalf("enqueue rejected for %s", item.ID)
		}
	}

	// All workers should run their extraction at once because no media is
	// playing and the idle waiter is absent (always idle).
	waitFor(t, func() bool { return extractor.active.Load() == workers })
	close(release)

	waitFor(t, func() bool {
		for _, item := range items {
			if !manager.Ready(item) {
				return false
			}
		}
		return true
	})
	if got := extractor.maxActive.Load(); got != workers {
		t.Fatalf("max active extractors = %d, want %d", got, workers)
	}
}

func TestManagerWorkersWaitForIdleBeforeExtraction(t *testing.T) {
	idle := &fakeIdleWaiter{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	extractor := &fakeExtractor{}
	manager, err := NewManager(Options{
		CacheDir: t.TempDir(),
		Resolver: fakeResolver{path: "/video.mp4"},
		Idle:     idle,
		Extract:  extractor,
		Workers:  3,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()

	for _, item := range []library.Media{
		video("a", "key-a"),
		video("b", "key-b"),
		video("c", "key-c"),
	} {
		if !manager.Enqueue(item) {
			t.Fatalf("enqueue rejected for %s", item.ID)
		}
	}

	select {
	case <-idle.started:
	case <-time.After(time.Second):
		t.Fatal("idle wait did not start")
	}
	if extractor.calls.Load() != 0 {
		t.Fatalf("extractor started during active playback: %d", extractor.calls.Load())
	}
}

func TestManagerFailureLeavesNoFinalOrTemporaryFile(t *testing.T) {
	cacheDir := t.TempDir()
	extractor := &fakeExtractor{err: errors.New("broken")}
	manager, err := NewManager(Options{
		CacheDir: cacheDir,
		Resolver: fakeResolver{path: "/video.mp4"},
		Extract:  extractor,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	item := video("a", "key-a")
	if !manager.Enqueue(item) {
		t.Fatal("enqueue rejected")
	}
	waitFor(t, func() bool { return extractor.calls.Load() == 1 })
	time.Sleep(20 * time.Millisecond)
	entries, err := os.ReadDir(cacheDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("cache entries after failure = %v", entries)
	}
}

func TestManagerCloseCancelsRunningJob(t *testing.T) {
	extractor := &fakeExtractor{release: make(chan struct{})}
	manager, err := NewManager(Options{
		CacheDir: t.TempDir(),
		Resolver: fakeResolver{path: "/video.mp4"},
		Extract:  extractor,
	})
	if err != nil {
		t.Fatal(err)
	}
	manager.Enqueue(video("a", "key-a"))
	waitFor(t, func() bool { return extractor.active.Load() == 1 })
	done := make(chan struct{})
	go func() {
		manager.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Close did not cancel extractor")
	}
}

func TestManagerWaitsForIdleBeforeExtraction(t *testing.T) {
	release := make(chan struct{})
	idle := &fakeIdleWaiter{
		started: make(chan struct{}),
		release: release,
	}
	extractor := &fakeExtractor{}
	manager, err := NewManager(Options{
		CacheDir: t.TempDir(),
		Resolver: fakeResolver{path: "/video.mp4"},
		Idle:     idle,
		Extract:  extractor,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()

	item := video("idle", "key-idle")
	if !manager.Enqueue(item) {
		t.Fatal("enqueue rejected")
	}
	select {
	case <-idle.started:
	case <-time.After(time.Second):
		t.Fatal("idle wait did not start")
	}
	if extractor.calls.Load() != 0 {
		t.Fatalf("extractor started during active playback")
	}
	close(release)
	waitFor(t, func() bool { return manager.Ready(item) })
}

func TestManagerJobTimeoutStopsExtraction(t *testing.T) {
	failure := make(chan struct{}, 1)
	extractor := &fakeExtractor{release: make(chan struct{})}
	manager, err := NewManager(Options{
		CacheDir:    t.TempDir(),
		Resolver:    fakeResolver{path: "/video.mp4"},
		Extract:     extractor,
		Timeout:     20 * time.Millisecond,
		MaxAttempts: 1,
		OnFailure: func(library.Media) {
			failure <- struct{}{}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()

	if !manager.Enqueue(video("timeout", "key-timeout")) {
		t.Fatal("enqueue rejected")
	}
	select {
	case <-failure:
	case <-time.After(time.Second):
		t.Fatal("timed out job did not fail")
	}
	if manager.Enqueue(video("timeout", "key-timeout")) {
		t.Fatal("failed cache key was accepted again")
	}
	time.Sleep(30 * time.Millisecond)
	if got := extractor.calls.Load(); got != 1 {
		t.Fatalf("extractor calls = %d, want 1", got)
	}
}

func TestManagerQueueIsBoundedNonBlockingAndEventuallyDrains(t *testing.T) {
	release := make(chan struct{})
	extractor := &fakeExtractor{release: release}
	manager, err := NewManager(Options{
		CacheDir:  t.TempDir(),
		Resolver:  fakeResolver{path: "/video.mp4"},
		Extract:   extractor,
		QueueSize: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()

	startedAt := time.Now()
	accepted := 0
	for index := 0; index < 500; index++ {
		if manager.Enqueue(video(
			fmt.Sprintf("video-%d", index),
			fmt.Sprintf("key-%d", index),
		)) {
			accepted++
		}
	}
	if elapsed := time.Since(startedAt); elapsed > time.Second {
		t.Fatalf("bounded enqueue blocked for %s", elapsed)
	}
	if accepted != 500 {
		t.Fatalf("accepted %d jobs, want 500", accepted)
	}
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for extractor.calls.Load() != 500 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := extractor.calls.Load(); got != 500 {
		t.Fatalf("extractor calls = %d, want 500", got)
	}
	if got := extractor.maxActive.Load(); got != 1 {
		t.Fatalf("max active extractors = %d, want 1", got)
	}
}

func TestManagerRetriesTransientExtractionFailure(t *testing.T) {
	extractor := &fakeExtractor{}
	extractor.failures.Store(1)
	failures := make(chan struct{}, 1)
	manager, err := NewManager(Options{
		CacheDir:    t.TempDir(),
		Resolver:    fakeResolver{path: "/video.mp4"},
		Extract:     extractor,
		RetryBase:   5 * time.Millisecond,
		RetryMax:    10 * time.Millisecond,
		MaxAttempts: 3,
		OnFailure: func(library.Media) {
			failures <- struct{}{}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()

	item := video("retry", "key-retry")
	if !manager.Enqueue(item) {
		t.Fatal("enqueue rejected")
	}
	waitFor(t, func() bool { return manager.Ready(item) })
	if got := extractor.calls.Load(); got != 2 {
		t.Fatalf("extractor calls = %d, want 2", got)
	}
	select {
	case <-failures:
		t.Fatal("transient failure published fallback")
	default:
	}
}

func TestManagerDefersActivePlaybackWithoutPoisoningKey(t *testing.T) {
	release := make(chan struct{})
	idle := &fakeIdleWaiter{
		started: make(chan struct{}),
		release: release,
	}
	extractor := &fakeExtractor{}
	failures := make(chan struct{}, 1)
	manager, err := NewManager(Options{
		CacheDir:    t.TempDir(),
		Resolver:    fakeResolver{path: "/video.mp4"},
		Idle:        idle,
		Extract:     extractor,
		IdleTimeout: 10 * time.Millisecond,
		RetryBase:   5 * time.Millisecond,
		RetryMax:    10 * time.Millisecond,
		MaxAttempts: 1,
		OnFailure: func(library.Media) {
			failures <- struct{}{}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()

	item := video("active", "key-active")
	if !manager.Enqueue(item) {
		t.Fatal("enqueue rejected")
	}
	waitFor(t, func() bool { return idle.calls.Load() >= 2 })
	close(release)
	waitFor(t, func() bool { return manager.Ready(item) })
	if extractor.calls.Load() != 1 {
		t.Fatalf("extractor calls = %d, want 1", extractor.calls.Load())
	}
	select {
	case <-failures:
		t.Fatal("idle deferral published fallback")
	default:
	}
}

func TestManagerDoesNotPublishSupersededRunningJob(t *testing.T) {
	release := make(chan struct{})
	extractor := &fakeExtractor{release: release}
	var readyMu sync.Mutex
	var ready []string
	manager, err := NewManager(Options{
		CacheDir: t.TempDir(),
		Resolver: fakeResolver{path: "/video.mp4"},
		Extract:  extractor,
		OnReady: func(item library.Media) {
			readyMu.Lock()
			ready = append(ready, item.Thumbnail.CacheKey)
			readyMu.Unlock()
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()

	oldItem := video("video", "old-key")
	newItem := video("video", "new-key")
	manager.Sync([]library.Media{oldItem})
	waitFor(t, func() bool { return extractor.active.Load() == 1 })
	manager.Sync([]library.Media{newItem})
	close(release)
	waitFor(t, func() bool {
		if !manager.Ready(newItem) {
			return false
		}
		readyMu.Lock()
		defer readyMu.Unlock()
		return len(ready) == 1
	})

	if _, err := os.Stat(manager.Path(oldItem)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("superseded thumbnail exists: %v", err)
	}
	readyMu.Lock()
	defer readyMu.Unlock()
	if fmt.Sprint(ready) != "[new-key]" {
		t.Fatalf("ready callbacks = %v", ready)
	}
}

func TestManagerStartupRemovesLegacyAndJPEGTemporaryFiles(t *testing.T) {
	cacheDir := t.TempDir()
	temporary := []string{"legacy.tmp", "key.123.tmp.jpg"}
	for _, name := range temporary {
		if err := os.WriteFile(filepath.Join(cacheDir, name), []byte("partial"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	final := filepath.Join(cacheDir, "ready.jpg")
	if err := os.WriteFile(final, []byte("jpeg"), 0o600); err != nil {
		t.Fatal(err)
	}

	manager, err := NewManager(Options{
		CacheDir: cacheDir,
		Resolver: fakeResolver{},
		Extract:  &fakeExtractor{},
	})
	if err != nil {
		t.Fatal(err)
	}
	manager.Close()

	for _, name := range temporary {
		if _, err := os.Stat(filepath.Join(cacheDir, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("temporary file %q remains: %v", name, err)
		}
	}
	if _, err := os.Stat(final); err != nil {
		t.Fatalf("final thumbnail removed: %v", err)
	}
}

func TestManagerReconcileRemovesOrphansAndPreservesOfflineGrace(t *testing.T) {
	cacheDir := t.TempDir()
	manager, err := NewManager(Options{
		CacheDir: cacheDir,
		Resolver: fakeResolver{},
		Extract:  &fakeExtractor{},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()

	active := video("active", "key-active")
	offline := video("offline", "key-offline")
	offline.Offline = true
	for _, path := range []string{
		manager.Path(active),
		manager.Path(offline),
		filepath.Join(cacheDir, "orphan.jpg"),
	} {
		if err := os.WriteFile(path, []byte("jpeg"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	now := time.Now()
	result, err := manager.Reconcile([]library.Media{active, offline}, now)
	if err != nil {
		t.Fatal(err)
	}
	if result.RemovedImages != 1 {
		t.Fatalf("cleanup result = %#v", result)
	}
	if _, err := os.Stat(manager.Path(active)); err != nil {
		t.Fatalf("active thumbnail removed: %v", err)
	}
	if _, err := os.Stat(manager.Path(offline)); err != nil {
		t.Fatalf("offline thumbnail removed before grace: %v", err)
	}

	marker := manager.offlineMarker(offline.Thumbnail.CacheKey)
	expired := now.Add(-offlineGrace - time.Hour)
	if err := os.Chtimes(marker, expired, expired); err != nil {
		t.Fatal(err)
	}
	result, err = manager.Reconcile([]library.Media{active, offline}, now)
	if err != nil {
		t.Fatal(err)
	}
	if result.RemovedImages != 1 {
		t.Fatalf("expired cleanup result = %#v", result)
	}
	if _, err := os.Stat(manager.Path(offline)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("offline thumbnail still exists: %v", err)
	}
}

func TestManagerReconcileRemovesOfflineMarkerAfterReconnect(t *testing.T) {
	cacheDir := t.TempDir()
	manager, err := NewManager(Options{
		CacheDir: cacheDir,
		Resolver: fakeResolver{},
		Extract:  &fakeExtractor{},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()

	item := video("reconnect", "key-reconnect")
	item.Offline = true
	if _, err := manager.Reconcile([]library.Media{item}, time.Now()); err != nil {
		t.Fatal(err)
	}
	marker := manager.offlineMarker(item.Thumbnail.CacheKey)
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("offline marker missing: %v", err)
	}

	item.Offline = false
	if _, err := manager.Reconcile([]library.Media{item}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("offline marker remains: %v", err)
	}
}

func waitFor(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !predicate() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !predicate() {
		t.Fatal("condition not met")
	}
}
