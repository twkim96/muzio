package library

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"muzio/backend/internal/mediapath"
)

func TestServiceUpdatesRootsAndRescans(t *testing.T) {
	audioDir := t.TempDir()
	videoDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(audioDir, "song.mp3"), []byte("song"), 0o600); err != nil {
		t.Fatalf("write song: %v", err)
	}
	if err := os.WriteFile(filepath.Join(videoDir, "clip.mp4"), []byte("clip"), 0o600); err != nil {
		t.Fatalf("write clip: %v", err)
	}

	service, err := NewService(
		MediaRootSettings{AudioRoots: []string{audioDir}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	if got := service.List(MediaTypeAudio); len(got) != 1 {
		t.Fatalf("audio len = %d, want 1", len(got))
	}

	result, err := service.UpdateMediaRoots(MediaRootSettings{
		AudioRoots: []string{audioDir},
		VideoRoots: []string{videoDir},
	})
	if err != nil {
		t.Fatalf("UpdateMediaRoots: %v", err)
	}
	if result.ItemCount != 2 {
		t.Fatalf("ItemCount = %d, want 2", result.ItemCount)
	}
	if got := service.List(MediaTypeVideo); len(got) != 1 {
		t.Fatalf("video len = %d, want 1", len(got))
	}
}

func TestPersistentServiceRestoresIndexWhenSettingsPersistFails(t *testing.T) {
	oldDir := t.TempDir()
	newDir := t.TempDir()
	indexPath := filepath.Join(t.TempDir(), "library-index.v1.log")
	oldSettings := MediaRootSettings{AudioRoots: []string{oldDir}}
	index, _, _ := OpenPersistentIndex(indexPath, oldSettings)
	oldRoots, err := mediapath.NewRoots([]string{oldDir})
	if err != nil {
		t.Fatal(err)
	}
	oldItem := Media{
		ID:           "old",
		Type:         MediaTypeAudio,
		RootName:     oldRoots.All()[0].Name,
		RelativePath: "old.mp3",
		Name:         "old.mp3",
	}
	if err := index.Reset(oldSettings, []Media{oldItem}, 3, time.Time{}); err != nil {
		t.Fatal(err)
	}
	service, err := NewPersistentService(
		oldSettings,
		newTestLogger(),
		func(MediaRootSettings) error { return errors.New("persist failed") },
		indexPath,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	newRoots, err := mediapath.NewRoots([]string{newDir})
	if err != nil {
		t.Fatal(err)
	}
	service.scanner = func(
		settings MediaRootSettings,
		logger *slog.Logger,
	) (*mediapath.Roots, []RootScanResult, error) {
		return newRoots, []RootScanResult{{
			Root:     newRoots.All()[0],
			Complete: true,
			Items: []Media{{
				ID:           "new",
				Type:         MediaTypeAudio,
				RootName:     newRoots.All()[0].Name,
				RelativePath: "new.mp3",
			}},
		}}, nil
	}
	_, err = service.UpdateMediaRoots(MediaRootSettings{AudioRoots: []string{newDir}})
	if err == nil {
		t.Fatal("UpdateMediaRoots succeeded despite persist failure")
	}

	_, state, err := OpenPersistentIndex(indexPath, oldSettings)
	if err != nil || state.Revision != 3 || len(state.Items) != 1 || state.Items[0].ID != oldItem.ID {
		t.Fatalf("restored state = %#v, %v", state, err)
	}
}

func TestServiceWaitsBetweenRootsWhileStreaming(t *testing.T) {
	service, err := NewService(MediaRootSettings{}, newTestLogger(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	endStream := service.BeginMediaStream()
	waitDone := make(chan error, 1)
	go func() {
		waitDone <- service.waitBeforeScanRoot(context.Background(), false)
	}()
	select {
	case err := <-waitDone:
		t.Fatalf("scan root did not wait for stream: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	endStream()
	select {
	case err := <-waitDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("scan root did not resume after stream")
	}
}

func TestServiceMediaQuietWindowRestartsForNewStream(t *testing.T) {
	service, err := NewService(MediaRootSettings{}, newTestLogger(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()

	quiet := 30 * time.Millisecond
	waitDone := make(chan error, 1)
	go func() {
		waitDone <- service.WaitForMediaQuiet(context.Background(), quiet)
	}()
	time.Sleep(15 * time.Millisecond)
	endStream := service.BeginMediaStream()
	time.Sleep(10 * time.Millisecond)
	endStream()

	select {
	case err := <-waitDone:
		t.Fatalf("quiet wait returned before restarted window: %v", err)
	case <-time.After(15 * time.Millisecond):
	}
	select {
	case err := <-waitDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("quiet wait did not finish")
	}
}

func TestServiceBackgroundWorkContextCancelsOnNewStream(t *testing.T) {
	service, err := NewService(MediaRootSettings{}, newTestLogger(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()

	ctx, cancel := service.BackgroundWorkContext(context.Background())
	defer cancel()
	endStream := service.BeginMediaStream()
	defer endStream()
	select {
	case <-ctx.Done():
		if !errors.Is(ctx.Err(), context.Canceled) {
			t.Fatalf("background context error = %v", ctx.Err())
		}
	case <-time.After(time.Second):
		t.Fatal("background work was not canceled by a stream")
	}
}

func TestPersistentServiceCloseCancelsScanWaitingForStream(t *testing.T) {
	dir := t.TempDir()
	service, err := NewPersistentService(
		MediaRootSettings{AudioRoots: []string{dir}},
		newTestLogger(),
		nil,
		filepath.Join(t.TempDir(), "library-index.v1.log"),
	)
	if err != nil {
		t.Fatal(err)
	}
	endStream := service.BeginMediaStream()
	defer endStream()
	rescanErr := make(chan error, 1)
	go func() {
		_, err := service.RescanMediaRoots()
		rescanErr <- err
	}()
	time.Sleep(25 * time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := service.CloseContext(ctx); err != nil {
		t.Fatalf("CloseContext: %v", err)
	}
	select {
	case err := <-rescanErr:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("rescan error = %v, want context canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("rescan did not stop during close")
	}
}

func TestServicePausesActiveRootScanWhenStreamingStarts(t *testing.T) {
	dir := t.TempDir()
	for item := 0; item < 300; item++ {
		if err := os.WriteFile(
			filepath.Join(dir, fmt.Sprintf("%03d.mp3", item)),
			[]byte("x"),
			0o600,
		); err != nil {
			t.Fatal(err)
		}
	}
	service, err := NewService(MediaRootSettings{}, newTestLogger(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	reachedCheckpoint := make(chan struct{})
	continueCheckpoint := make(chan struct{})
	var once sync.Once
	service.scanner = func(
		settings MediaRootSettings,
		logger *slog.Logger,
	) (*mediapath.Roots, []RootScanResult, error) {
		return scanMediaRootSettingsReportContext(
			service.scans.ctx,
			settings,
			logger,
			func(ctx context.Context, first bool) error {
				if !first {
					once.Do(func() {
						close(reachedCheckpoint)
						<-continueCheckpoint
					})
				}
				return service.waitBeforeScanRoot(ctx, first)
			},
		)
	}
	done := make(chan error, 1)
	go func() {
		_, err := service.UpdateMediaRoots(MediaRootSettings{
			AudioRoots: []string{dir},
		})
		done <- err
	}()
	<-reachedCheckpoint
	endStream := service.BeginMediaStream()
	close(continueCheckpoint)
	select {
	case err := <-done:
		t.Fatalf("scan completed while stream active: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	endStream()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("scan did not resume after stream")
	}
}

func TestServiceRescansCurrentRoots(t *testing.T) {
	audioDir := t.TempDir()
	service, err := NewService(
		MediaRootSettings{AudioRoots: []string{audioDir}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	if got := service.List(MediaTypeAudio); len(got) != 0 {
		t.Fatalf("initial audio len = %d, want 0", len(got))
	}

	if err := os.WriteFile(filepath.Join(audioDir, "new-song.mp3"), []byte("song"), 0o600); err != nil {
		t.Fatalf("write song: %v", err)
	}
	result, err := service.RescanMediaRoots()
	if err != nil {
		t.Fatalf("RescanMediaRoots: %v", err)
	}
	if result.ItemCount != 1 {
		t.Fatalf("ItemCount = %d, want 1", result.ItemCount)
	}
	if got := service.List(MediaTypeAudio); len(got) != 1 {
		t.Fatalf("audio len = %d, want 1", len(got))
	}
	if result.Reconciliation.Added != 1 || result.Reconciliation.Revision == 0 {
		t.Fatalf("Reconciliation = %#v", result.Reconciliation)
	}
}

func TestServicePreservesItemsWhenRootBecomesUnavailable(t *testing.T) {
	parent := t.TempDir()
	audioDir := filepath.Join(parent, "music")
	if err := os.MkdirAll(audioDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(audioDir, "song.mp3"), []byte("song"), 0o600); err != nil {
		t.Fatalf("write song: %v", err)
	}
	service, err := NewService(
		MediaRootSettings{AudioRoots: []string{audioDir}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	before := service.Revision()

	if err := os.RemoveAll(audioDir); err != nil {
		t.Fatalf("remove root: %v", err)
	}
	result, err := service.RescanMediaRoots()
	if err != nil {
		t.Fatalf("RescanMediaRoots: %v", err)
	}
	if got := service.List(MediaTypeAudio); len(got) != 0 {
		t.Fatalf("audio after disconnected root = %#v", got)
	}
	stored := service.ListStored(MediaTypeAudio)
	if len(stored) != 1 || stored[0].Name != "song.mp3" || !stored[0].Offline {
		t.Fatalf("stored audio after disconnected root = %#v", stored)
	}
	if result.Reconciliation.Revision != before+1 ||
		result.Reconciliation.Added != 0 ||
		result.Reconciliation.Updated != 1 ||
		result.Reconciliation.Removed != 0 {
		t.Fatalf("Reconciliation = %#v, before revision = %d", result.Reconciliation, before)
	}
	changes := service.ChangesSince(before, MediaTypeAudio)
	if len(changes.Upserts) != 0 || fmt.Sprint(changes.DeletedIDs) !=
		fmt.Sprintf("[%s]", stored[0].ID) {
		t.Fatalf("offline changes = %#v", changes)
	}

	if err := os.MkdirAll(audioDir, 0o755); err != nil {
		t.Fatalf("restore root: %v", err)
	}
	if err := os.WriteFile(filepath.Join(audioDir, "song.mp3"), []byte("song"), 0o600); err != nil {
		t.Fatalf("restore song: %v", err)
	}
	offlineRevision := service.Revision()
	if _, err := service.RescanMediaRoots(); err != nil {
		t.Fatalf("RescanMediaRoots after reconnect: %v", err)
	}
	if got := service.List(MediaTypeAudio); len(got) != 1 || got[0].Offline {
		t.Fatalf("audio after reconnect = %#v", got)
	}
	changes = service.ChangesSince(offlineRevision, MediaTypeAudio)
	if len(changes.Upserts) != 1 || len(changes.DeletedIDs) != 0 ||
		changes.Upserts[0].Offline {
		t.Fatalf("reconnect changes = %#v", changes)
	}
}

func TestServiceLenAndListStoredTypesAvoidPublicVisibilityFiltering(t *testing.T) {
	service, err := NewService(
		MediaRootSettings{},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	service.ApplyChanges([]Media{
		{
			ID: "audio", Type: MediaTypeAudio, RootName: "root",
			RelativePath: "audio.mp3", Name: "audio.mp3",
		},
		{
			ID: "video", Type: MediaTypeVideo, RootName: "root",
			RelativePath: "video.mp4", Name: "video.mp4",
		},
		{
			ID: "image", Type: MediaTypeImage, RootName: "root",
			RelativePath: "image.jpg", Name: "image.jpg", Offline: true,
		},
	}, nil)

	if got := service.Len(); got != 2 {
		t.Fatalf("Len = %d, want 2 visible records", got)
	}
	stored := service.ListStoredTypes(MediaTypeVideo, MediaTypeImage)
	if len(stored) != 2 || stored[0].ID != "image" || stored[1].ID != "video" {
		t.Fatalf("stored types = %#v", stored)
	}
	if !stored[0].Offline {
		t.Fatalf("offline record was filtered: %#v", stored[0])
	}
}

func TestServiceAppliesIncrementalChangesAndExposesJournal(t *testing.T) {
	dir := t.TempDir()
	service, err := NewService(
		MediaRootSettings{AudioRoots: []string{dir}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	base := service.Revision()
	item := Media{
		ID:           "new",
		Type:         MediaTypeAudio,
		RootName:     "music",
		RelativePath: "new.mp3",
		Name:         "new.mp3",
	}

	result := service.ApplyChanges([]Media{item}, nil)
	if result.Added != 1 || result.Revision != base+1 {
		t.Fatalf("ApplyChanges = %#v", result)
	}
	if got, err := service.GetByPath("music", "new.mp3"); err != nil || got.ID != "new" {
		t.Fatalf("GetByPath = %#v, err = %v", got, err)
	}
	changes := service.ChangesSince(base, MediaTypeAudio)
	if changes.ResetRequired || len(changes.Upserts) != 1 || changes.Upserts[0].ID != "new" {
		t.Fatalf("ChangesSince = %#v", changes)
	}
}

func TestServiceCoalescesConcurrentScansForSameSettings(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "song.mp3"), []byte("song"), 0o600); err != nil {
		t.Fatalf("write song: %v", err)
	}
	service, err := NewService(
		MediaRootSettings{AudioRoots: []string{dir}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	originalScanner := service.scanner
	var scanCount atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	var startOnce sync.Once
	service.scanner = func(settings MediaRootSettings, logger *slog.Logger) (*mediapath.Roots, []RootScanResult, error) {
		scanCount.Add(1)
		startOnce.Do(func() { close(started) })
		<-release
		return originalScanner(settings, logger)
	}

	errs := make(chan error, 2)
	go func() {
		_, err := service.RescanMediaRoots()
		errs <- err
	}()
	<-started
	go func() {
		_, err := service.RescanMediaRoots()
		errs <- err
	}()
	time.Sleep(20 * time.Millisecond)
	close(release)

	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("RescanMediaRoots: %v", err)
		}
	}
	if got := scanCount.Load(); got != 1 {
		t.Fatalf("scan count = %d, want 1", got)
	}
}

func TestServiceJoinedRescanSharesFinalReconciliation(t *testing.T) {
	dir := t.TempDir()
	service, err := NewService(
		MediaRootSettings{AudioRoots: []string{dir}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	root := service.roots.All()[0]
	started := make(chan struct{})
	release := make(chan struct{})
	var scanCount atomic.Int32
	var startedOnce sync.Once
	service.scanner = func(settings MediaRootSettings, logger *slog.Logger) (*mediapath.Roots, []RootScanResult, error) {
		scanCount.Add(1)
		startedOnce.Do(func() { close(started) })
		<-release
		return service.roots, []RootScanResult{{
			Root:     root,
			Complete: true,
			Items: []Media{{
				ID:           "scan",
				Type:         MediaTypeAudio,
				RootName:     root.Name,
				RelativePath: "scan.mp3",
				Name:         "scan.mp3",
			}},
		}}, nil
	}

	results := make(chan MediaRootUpdateResult, 2)
	go func() {
		result, _ := service.RescanMediaRoots()
		results <- result
	}()
	<-started
	go func() {
		result, _ := service.RescanMediaRoots()
		results <- result
	}()
	time.Sleep(20 * time.Millisecond)
	service.ApplyChanges([]Media{{
		ID:           "watch",
		Type:         MediaTypeAudio,
		RootName:     root.Name,
		RelativePath: "watch.mp3",
		Name:         "watch.mp3",
	}}, nil)
	close(release)

	first := <-results
	second := <-results
	if scanCount.Load() != 1 {
		t.Fatalf("scan count = %d, want 1", scanCount.Load())
	}
	if first.Reconciliation.Revision != second.Reconciliation.Revision ||
		first.ItemCount != second.ItemCount {
		t.Fatalf("joined results differ: %#v vs %#v", first, second)
	}
	if got := service.List(MediaTypeAudio); len(got) != 2 {
		t.Fatalf("items = %#v", got)
	}
}

func TestServiceApplyChangesDoesNotWaitForNetworkScan(t *testing.T) {
	dir := t.TempDir()
	service, err := NewService(
		MediaRootSettings{AudioRoots: []string{dir}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	root := service.roots.All()[0]
	started := make(chan struct{})
	release := make(chan struct{})
	service.scanner = func(settings MediaRootSettings, logger *slog.Logger) (*mediapath.Roots, []RootScanResult, error) {
		close(started)
		<-release
		return service.roots, []RootScanResult{{Root: root, Complete: true}}, nil
	}

	rescanDone := make(chan struct{})
	go func() {
		_, _ = service.RescanMediaRoots()
		close(rescanDone)
	}()
	<-started
	applied := make(chan struct{})
	go func() {
		service.ApplyChanges([]Media{{
			ID:           "watch",
			Type:         MediaTypeAudio,
			RootName:     root.Name,
			RelativePath: "watch.mp3",
		}}, nil)
		close(applied)
	}()
	select {
	case <-applied:
	case <-time.After(time.Second):
		t.Fatal("ApplyChanges blocked behind active scan")
	}
	close(release)
	<-rescanDone
}

func TestServiceNewerRootUpdateSupersedesOlderScan(t *testing.T) {
	firstDir := t.TempDir()
	secondDir := t.TempDir()
	service, err := NewService(
		MediaRootSettings{},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	originalScanner := service.scanner
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	service.scanner = func(settings MediaRootSettings, logger *slog.Logger) (*mediapath.Roots, []RootScanResult, error) {
		if len(settings.AudioRoots) == 1 && settings.AudioRoots[0] == firstDir {
			close(firstStarted)
			<-releaseFirst
		}
		return originalScanner(settings, logger)
	}

	firstErr := make(chan error, 1)
	go func() {
		_, err := service.UpdateMediaRoots(MediaRootSettings{AudioRoots: []string{firstDir}})
		firstErr <- err
	}()
	<-firstStarted
	secondDone := make(chan error, 1)
	go func() {
		_, err := service.UpdateMediaRoots(MediaRootSettings{AudioRoots: []string{secondDir}})
		secondDone <- err
	}()
	time.Sleep(20 * time.Millisecond)
	close(releaseFirst)

	if err := <-firstErr; !errors.Is(err, ErrMediaRootUpdateSuperseded) {
		t.Fatalf("first update err = %v", err)
	}
	if err := <-secondDone; err != nil {
		t.Fatalf("second update err = %v", err)
	}
	if got := service.MediaRootSettings(); len(got.AudioRoots) != 1 || got.AudioRoots[0] != secondDir {
		t.Fatalf("settings = %#v", got)
	}
}

func TestServiceRootUpdateRetriesWhenJournalFallsBehind(t *testing.T) {
	dir := t.TempDir()
	service, err := NewService(
		MediaRootSettings{},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	originalScanner := service.scanner
	started := make(chan struct{})
	release := make(chan struct{})
	service.scanner = func(settings MediaRootSettings, logger *slog.Logger) (*mediapath.Roots, []RootScanResult, error) {
		close(started)
		<-release
		return originalScanner(settings, logger)
	}

	errCh := make(chan error, 1)
	go func() {
		_, err := service.UpdateMediaRoots(MediaRootSettings{AudioRoots: []string{dir}})
		errCh <- err
	}()
	<-started
	for i := 0; i < defaultJournalBatchLimit+1; i++ {
		service.ApplyChanges([]Media{{
			ID:           fmt.Sprintf("change-%d", i),
			Type:         MediaTypeAudio,
			RootName:     "old-root",
			RelativePath: fmt.Sprintf("change-%d.mp3", i),
		}}, nil)
	}
	close(release)

	if err := <-errCh; !errors.Is(err, ErrMediaRootUpdateRetry) {
		t.Fatalf("update err = %v", err)
	}
	if got := service.MediaRootSettings(); len(got.AudioRoots) != 0 {
		t.Fatalf("settings changed after retry error: %#v", got)
	}
}

func TestServiceRescanRetryPersistsDegradedHealth(t *testing.T) {
	dir := t.TempDir()
	service, err := NewService(
		MediaRootSettings{AudioRoots: []string{dir}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	root := service.roots.All()[0]
	started := make(chan struct{})
	release := make(chan struct{})
	service.scanner = func(settings MediaRootSettings, logger *slog.Logger) (*mediapath.Roots, []RootScanResult, error) {
		close(started)
		<-release
		return service.roots, []RootScanResult{{
			Root:     root,
			Complete: false,
			Err:      os.ErrPermission,
		}}, nil
	}

	errCh := make(chan error, 1)
	go func() {
		_, err := service.RescanMediaRoots()
		errCh <- err
	}()
	<-started
	for i := 0; i < defaultJournalBatchLimit+1; i++ {
		service.ApplyChanges([]Media{{
			ID:           fmt.Sprintf("change-%d", i),
			Type:         MediaTypeAudio,
			RootName:     root.Name,
			RelativePath: fmt.Sprintf("change-%d.mp3", i),
		}}, nil)
	}
	close(release)

	if err := <-errCh; !errors.Is(err, ErrMediaRootUpdateRetry) {
		t.Fatalf("rescan err = %v", err)
	}
	degraded := service.DegradedRoots()
	if len(degraded) != 1 || degraded[0].Path != root.Path {
		t.Fatalf("degraded = %#v", degraded)
	}
}

func TestServiceReplaysChangesAppliedDuringFullScan(t *testing.T) {
	dir := t.TempDir()
	service, err := NewService(
		MediaRootSettings{AudioRoots: []string{dir}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	root := service.roots.All()[0]
	scanStarted := make(chan struct{})
	releaseScan := make(chan struct{})
	service.scanner = func(settings MediaRootSettings, logger *slog.Logger) (*mediapath.Roots, []RootScanResult, error) {
		close(scanStarted)
		<-releaseScan
		return service.roots, []RootScanResult{{
			Root:     root,
			Complete: true,
			Items: []Media{{
				ID:           "from-scan",
				Type:         MediaTypeAudio,
				RootName:     root.Name,
				RelativePath: "scan.mp3",
				Name:         "scan.mp3",
			}},
		}}, nil
	}

	errCh := make(chan error, 1)
	go func() {
		_, err := service.RescanMediaRoots()
		errCh <- err
	}()
	<-scanStarted
	service.ApplyChanges([]Media{{
		ID:           "from-watcher",
		Type:         MediaTypeAudio,
		RootName:     root.Name,
		RelativePath: "watcher.mp3",
		Name:         "watcher.mp3",
	}}, nil)
	close(releaseScan)
	if err := <-errCh; err != nil {
		t.Fatalf("RescanMediaRoots: %v", err)
	}

	items := service.List(MediaTypeAudio)
	if len(items) != 2 {
		t.Fatalf("items = %#v", items)
	}
	if _, err := service.Get("from-watcher"); err != nil {
		t.Fatalf("concurrent change was lost: %v", err)
	}
}

func TestServiceReplaysDeletionAppliedDuringFullScan(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "old.mp3"), []byte("old"), 0o600); err != nil {
		t.Fatalf("write old file: %v", err)
	}
	service, err := NewService(
		MediaRootSettings{AudioRoots: []string{dir}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	old := service.List(MediaTypeAudio)[0]
	root := service.roots.All()[0]
	scanStarted := make(chan struct{})
	releaseScan := make(chan struct{})
	service.scanner = func(settings MediaRootSettings, logger *slog.Logger) (*mediapath.Roots, []RootScanResult, error) {
		close(scanStarted)
		<-releaseScan
		return service.roots, []RootScanResult{{
			Root:     root,
			Complete: true,
			Items:    []Media{old},
		}}, nil
	}

	errCh := make(chan error, 1)
	go func() {
		_, err := service.RescanMediaRoots()
		errCh <- err
	}()
	<-scanStarted
	service.ApplyChanges(nil, []string{old.ID})
	close(releaseScan)
	if err := <-errCh; err != nil {
		t.Fatalf("RescanMediaRoots: %v", err)
	}
	if _, err := service.Get(old.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("concurrent deletion was lost: %v", err)
	}
}

func TestMergeRootScanResultsAppliesPartialUpsertsWithoutDeletingUnknownItems(t *testing.T) {
	root := mediapath.Root{Name: "music", Path: "/music"}
	snapshot := NewSnapshot([]Media{
		{ID: "old", Type: MediaTypeAudio, RootName: root.Name, RelativePath: "old.mp3", Name: "old.mp3"},
		{ID: "updated", Type: MediaTypeAudio, RootName: root.Name, RelativePath: "updated.mp3", Name: "before.mp3"},
	})

	items := mergeRootScanResults(
		snapshot,
		[]RootScanResult{{
			Root:     root,
			Complete: false,
			Err:      os.ErrPermission,
			Items: []Media{
				{ID: "updated", Type: MediaTypeAudio, RootName: root.Name, RelativePath: "updated.mp3", Name: "after.mp3"},
				{ID: "new", Type: MediaTypeAudio, RootName: root.Name, RelativePath: "new.mp3", Name: "new.mp3"},
			},
		}},
		MediaRootSettings{AudioRoots: []string{root.Path}},
	)

	merged := NewSnapshot(items)
	if len(merged.List("")) != 3 {
		t.Fatalf("items = %#v", items)
	}
	if got, err := merged.Get("updated"); err != nil || got.Name != "after.mp3" {
		t.Fatalf("updated = %#v, err = %v", got, err)
	}
	if _, err := merged.Get("old"); err != nil {
		t.Fatalf("unseen old item was deleted: %v", err)
	}
}

func TestMergeRootScanResultsDropsTypesRemovedFromSettings(t *testing.T) {
	root := mediapath.Root{Name: "shared", Path: "/shared"}
	snapshot := NewSnapshot([]Media{
		{ID: "video", Type: MediaTypeVideo, RootName: root.Name, RelativePath: "clip.mp4"},
		{ID: "image", Type: MediaTypeImage, RootName: root.Name, RelativePath: "cover.jpg"},
	})

	items := mergeRootScanResults(
		snapshot,
		[]RootScanResult{{Root: root, Complete: false, Err: os.ErrPermission}},
		MediaRootSettings{VideoRoots: []string{root.Path}},
	)
	if len(items) != 1 || items[0].ID != "video" {
		t.Fatalf("items = %#v", items)
	}
}

func TestMergeRootScanResultsKeepsAccessiblePartialRootVisible(t *testing.T) {
	root := mediapath.Root{Name: "music", Path: "/music"}
	snapshot := NewSnapshot([]Media{{
		ID:           "old",
		Type:         MediaTypeAudio,
		RootName:     root.Name,
		RelativePath: "old.mp3",
		Offline:      true,
	}})

	items := mergeRootScanResults(
		snapshot,
		[]RootScanResult{{
			Root:        root,
			Complete:    false,
			Unavailable: false,
			Err:         os.ErrPermission,
		}},
		MediaRootSettings{AudioRoots: []string{root.Path}},
	)
	if len(items) != 1 || items[0].Offline {
		t.Fatalf("items = %#v", items)
	}
}

func TestMergeRootScanResultsPreservesReadyThumbnailForSameCacheKey(t *testing.T) {
	root := mediapath.Root{Name: "videos", Path: "/videos"}
	current := Media{
		ID:           "video",
		Type:         MediaTypeVideo,
		RootName:     root.Name,
		RelativePath: "clip.mp4",
		Thumbnail: Thumbnail{
			URL:      "/api/thumbnails/video?v=key&state=ready",
			Kind:     ThumbnailKindVideo,
			Status:   ThumbnailStatusReady,
			CacheKey: "key",
		},
	}
	scanned := current
	scanned.Thumbnail = Thumbnail{
		URL:      "/api/thumbnails/video?v=key&state=pending",
		Kind:     ThumbnailKindVideo,
		Status:   ThumbnailStatusPending,
		CacheKey: "key",
	}

	items := mergeRootScanResults(
		NewSnapshot([]Media{current}),
		[]RootScanResult{{
			Root:     root,
			Items:    []Media{scanned},
			Complete: true,
		}},
		MediaRootSettings{VideoRoots: []string{root.Path}},
	)

	if len(items) != 1 || items[0].Thumbnail != current.Thumbnail {
		t.Fatalf("thumbnail = %#v, want %#v", items, current.Thumbnail)
	}
}

func TestMergeRootScanResultsMigratesThumbnailKindForSameCacheKey(t *testing.T) {
	root := mediapath.Root{Name: "music", Path: "/music"}
	current := Media{
		ID:           "song",
		Type:         MediaTypeAudio,
		RootName:     root.Name,
		RelativePath: "song.m4a",
		Thumbnail: Thumbnail{
			URL:      "/api/thumbnails/song?v=key&state=ready",
			Kind:     ThumbnailKindFallback,
			Status:   ThumbnailStatusReady,
			CacheKey: "key",
		},
	}
	scanned := current
	scanned.Thumbnail = Thumbnail{
		URL:      "/api/thumbnails/song?v=key&state=pending",
		Kind:     ThumbnailKindAudio,
		Status:   ThumbnailStatusPending,
		CacheKey: "key",
	}

	items := mergeRootScanResults(
		NewSnapshot([]Media{current}),
		[]RootScanResult{{Root: root, Items: []Media{scanned}, Complete: true}},
		MediaRootSettings{AudioRoots: []string{root.Path}},
	)

	if len(items) != 1 || items[0].Thumbnail != scanned.Thumbnail {
		t.Fatalf("thumbnail = %#v, want %#v", items, scanned.Thumbnail)
	}
}

func TestMergeRootScanResultsResetsThumbnailForChangedCacheKey(t *testing.T) {
	root := mediapath.Root{Name: "videos", Path: "/videos"}
	current := Media{
		ID:           "video",
		Type:         MediaTypeVideo,
		RootName:     root.Name,
		RelativePath: "clip.mp4",
		Thumbnail: Thumbnail{
			URL:      "/api/thumbnails/video?v=old&state=ready",
			Kind:     ThumbnailKindVideo,
			Status:   ThumbnailStatusReady,
			CacheKey: "old",
		},
	}
	scanned := current
	scanned.Thumbnail = Thumbnail{
		URL:      "/api/thumbnails/video?v=new&state=pending",
		Kind:     ThumbnailKindVideo,
		Status:   ThumbnailStatusPending,
		CacheKey: "new",
	}

	items := mergeRootScanResults(
		NewSnapshot([]Media{current}),
		[]RootScanResult{{
			Root:     root,
			Items:    []Media{scanned},
			Complete: true,
		}},
		MediaRootSettings{VideoRoots: []string{root.Path}},
	)

	if len(items) != 1 || items[0].Thumbnail != scanned.Thumbnail {
		t.Fatalf("thumbnail = %#v, want %#v", items, scanned.Thumbnail)
	}
}

func TestServiceUnchangedRescanPreservesReadyThumbnailAndRevision(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "clip.mp4"), []byte("video"), 0o600); err != nil {
		t.Fatal(err)
	}
	service, err := NewService(
		MediaRootSettings{VideoRoots: []string{root}},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()

	item := service.List(MediaTypeVideo)[0]
	service.UpdateThumbnailStatus(
		item.ID,
		item.Thumbnail.CacheKey,
		ThumbnailStatusReady,
	)
	revision := service.Revision()
	if _, err := service.RescanMediaRoots(); err != nil {
		t.Fatal(err)
	}
	if got := service.Revision(); got != revision {
		t.Fatalf("revision = %d, want %d", got, revision)
	}
	updated, err := service.Get(item.ID)
	if err != nil || updated.Thumbnail.Status != ThumbnailStatusReady {
		t.Fatalf("item = %#v, error = %v", updated, err)
	}
}

func TestReplayConcurrentChangesFiltersRemovedMediaType(t *testing.T) {
	root := mediapath.Root{Name: "shared", Path: "/shared"}
	roots, err := mediapath.NewRoots([]string{root.Path})
	if err != nil {
		t.Fatalf("NewRoots: %v", err)
	}
	root = roots.All()[0]
	snapshot := NewSnapshot(nil)
	base := snapshot.Revision()
	snapshot.Apply([]Media{{
		ID:           "image",
		Type:         MediaTypeImage,
		RootName:     root.Name,
		RelativePath: "cover.jpg",
	}}, nil)
	scanned := []Media{{
		ID:           "video",
		Type:         MediaTypeVideo,
		RootName:     root.Name,
		RelativePath: "clip.mp4",
	}}

	items, ok := replayConcurrentChanges(
		snapshot,
		base,
		scanned,
		roots,
		MediaRootSettings{VideoRoots: []string{root.Path}},
	)
	if !ok || len(items) != 1 || items[0].ID != "video" {
		t.Fatalf("items = %#v, ok = %v", items, ok)
	}
}

func TestServiceDedupesSameRootAcrossMediaTypes(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "song.mp3"), []byte("song"), 0o600); err != nil {
		t.Fatalf("write song: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "clip.mp4"), []byte("clip"), 0o600); err != nil {
		t.Fatalf("write clip: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "photo.jpg"), []byte("photo"), 0o600); err != nil {
		t.Fatalf("write photo: %v", err)
	}

	service, err := NewService(
		MediaRootSettings{
			AudioRoots: []string{dir},
			VideoRoots: []string{dir + string(os.PathSeparator)},
			ImageRoots: []string{filepath.Clean(dir)},
		},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	if got := service.List(""); len(got) != 3 {
		t.Fatalf("all len = %d, want 3; got %#v", len(got), got)
	}
	if got := service.List(MediaTypeAudio); len(got) != 1 {
		t.Fatalf("audio len = %d, want 1", len(got))
	}
	if got := service.List(MediaTypeVideo); len(got) != 1 {
		t.Fatalf("video len = %d, want 1", len(got))
	}
	if got := service.List(MediaTypeImage); len(got) != 1 {
		t.Fatalf("image len = %d, want 1", len(got))
	}
}

func TestServiceFiltersMediaTypesPerConfiguredRoot(t *testing.T) {
	musicDir := t.TempDir()
	downloadsDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(musicDir, "song.mp3"), []byte("song"), 0o600); err != nil {
		t.Fatalf("write song: %v", err)
	}
	if err := os.WriteFile(filepath.Join(musicDir, "music-root-video.mp4"), []byte("clip"), 0o600); err != nil {
		t.Fatalf("write music-root-video: %v", err)
	}
	if err := os.WriteFile(filepath.Join(downloadsDir, "downloads-song.mp3"), []byte("song"), 0o600); err != nil {
		t.Fatalf("write downloads-song: %v", err)
	}
	if err := os.WriteFile(filepath.Join(downloadsDir, "clip.mp4"), []byte("clip"), 0o600); err != nil {
		t.Fatalf("write clip: %v", err)
	}
	if err := os.WriteFile(filepath.Join(downloadsDir, "photo.jpg"), []byte("photo"), 0o600); err != nil {
		t.Fatalf("write photo: %v", err)
	}

	service, err := NewService(
		MediaRootSettings{
			AudioRoots: []string{musicDir},
			VideoRoots: []string{downloadsDir},
			ImageRoots: []string{downloadsDir + string(os.PathSeparator)},
		},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	if got := service.List(""); len(got) != 3 {
		t.Fatalf("all len = %d, want 3; got %#v", len(got), got)
	}
	if got := service.List(MediaTypeAudio); len(got) != 1 || got[0].Name != "song.mp3" {
		t.Fatalf("audio = %#v, want only music root song", got)
	}
	if got := service.List(MediaTypeVideo); len(got) != 1 || got[0].Name != "clip.mp4" {
		t.Fatalf("video = %#v, want only downloads clip", got)
	}
	if got := service.List(MediaTypeImage); len(got) != 1 || got[0].Name != "photo.jpg" {
		t.Fatalf("image = %#v, want only downloads photo", got)
	}
}

func TestSettingsFromRootsInfersVideoPaths(t *testing.T) {
	settings := SettingsFromRoots([]string{"/Users/me/Music", "/Users/me/video", "/Users/me/Pictures"})
	if len(settings.AudioRoots) != 1 || settings.AudioRoots[0] != "/Users/me/Music" {
		t.Fatalf("AudioRoots = %#v", settings.AudioRoots)
	}
	if len(settings.VideoRoots) != 1 || settings.VideoRoots[0] != "/Users/me/video" {
		t.Fatalf("VideoRoots = %#v", settings.VideoRoots)
	}
	if len(settings.ImageRoots) != 1 || settings.ImageRoots[0] != "/Users/me/Pictures" {
		t.Fatalf("ImageRoots = %#v", settings.ImageRoots)
	}
}

func TestServicePublishesOnlyChangedLibraryRevisions(t *testing.T) {
	service, err := NewService(
		MediaRootSettings{},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	events, unsubscribe := service.SubscribeLibraryEvents()
	defer unsubscribe()

	item := Media{
		ID:           "audio-1",
		Type:         MediaTypeAudio,
		RootName:     "music",
		RelativePath: "song.mp3",
		Name:         "song.mp3",
	}
	result := service.ApplyChanges([]Media{item}, nil)
	select {
	case event := <-events:
		if event.Revision != result.Revision ||
			len(event.AffectedTypes) != 1 ||
			event.AffectedTypes[0] != MediaTypeAudio {
			t.Fatalf("event = %#v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for library event")
	}

	service.ApplyChanges([]Media{item}, nil)
	select {
	case event := <-events:
		t.Fatalf("unchanged apply published event: %#v", event)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestServiceCoalescesSlowSubscriberEvents(t *testing.T) {
	service, err := NewService(
		MediaRootSettings{},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	events, unsubscribe := service.SubscribeLibraryEvents()
	defer unsubscribe()

	service.applyChanges([]Media{{
		ID:           "audio-1",
		Type:         MediaTypeAudio,
		RootName:     "music",
		RelativePath: "song.mp3",
		Name:         "song.mp3",
	}}, nil, "watch")
	last := service.applyChanges([]Media{{
		ID:           "video-1",
		Type:         MediaTypeVideo,
		RootName:     "video",
		RelativePath: "movie.mp4",
		Name:         "movie.mp4",
	}}, nil, "watch")

	select {
	case event := <-events:
		if event.Revision != last.Revision {
			t.Fatalf("revision = %d, want %d", event.Revision, last.Revision)
		}
		if len(event.AffectedTypes) != 2 ||
			event.AffectedTypes[0] != MediaTypeAudio ||
			event.AffectedTypes[1] != MediaTypeVideo {
			t.Fatalf("affected types = %#v", event.AffectedTypes)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for coalesced event")
	}
}
