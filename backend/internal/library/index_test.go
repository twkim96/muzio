package library

import (
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"muzio/backend/internal/mediapath"
)

func TestPersistentIndexRoundTripAndIncrementalAppend(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library-index.v1.log")
	settings := MediaRootSettings{AudioRoots: []string{"/music"}}
	index, _, err := OpenPersistentIndex(path, settings)
	if index == nil || !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("OpenPersistentIndex = %#v, %v", index, err)
	}
	initial := []Media{
		{ID: "a", Type: MediaTypeAudio, RootName: "music", RelativePath: "a.mp3"},
		{ID: "b", Type: MediaTypeAudio, RootName: "music", RelativePath: "b.mp3"},
	}
	verified := time.Date(2026, 6, 11, 0, 0, 0, 0, time.UTC)
	if err := index.Reset(settings, initial, 4, verified); err != nil {
		t.Fatalf("Reset: %v", err)
	}
	if err := index.Append(5, []Media{{
		ID: "c", Type: MediaTypeAudio, RootName: "music", RelativePath: "c.mp3",
	}}, []string{"a"}, time.Time{}); err != nil {
		t.Fatalf("Append: %v", err)
	}

	_, state, err := OpenPersistentIndex(path, settings)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if state.Revision != 5 || len(state.Items) != 2 || !state.LastVerifiedAt.Equal(verified) {
		t.Fatalf("state = %#v", state)
	}
	if state.Items[0].ID != "b" || state.Items[1].ID != "c" {
		t.Fatalf("items = %#v", state.Items)
	}
}

func TestPersistentIndexIgnoresInterruptedTailFrame(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library-index.v1.log")
	settings := MediaRootSettings{VideoRoots: []string{"/video"}}
	index, _, _ := OpenPersistentIndex(path, settings)
	if err := index.Reset(settings, []Media{{
		ID: "v", Type: MediaTypeVideo, RootName: "video", RelativePath: "v.mp4",
	}}, 7, time.Time{}); err != nil {
		t.Fatalf("Reset: %v", err)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte{0, 0, 0, 100, 1, 2}); err != nil {
		t.Fatal(err)
	}
	file.Close()

	_, state, err := OpenPersistentIndex(path, settings)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if state.Revision != 7 || len(state.Items) != 1 {
		t.Fatalf("state = %#v", state)
	}
}

func TestPersistentIndexCorruptionIsReset(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library-index.v1.log")
	settings := MediaRootSettings{AudioRoots: []string{"/music"}}
	index, _, _ := OpenPersistentIndex(path, settings)
	if err := index.Reset(settings, []Media{{
		ID: "a", Type: MediaTypeAudio, RootName: "music", RelativePath: "a.mp3",
	}}, 1, time.Time{}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data[len(data)-1] ^= 0xff
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}

	index, state, err := OpenPersistentIndex(path, settings)
	if index == nil || !errors.Is(err, ErrIndexCorrupt) || len(state.Items) != 0 {
		t.Fatalf("open corrupt = %#v, %#v, %v", index, state, err)
	}
	_, clean, err := OpenPersistentIndex(path, settings)
	if err != nil || len(clean.Items) != 0 {
		t.Fatalf("clean reopen = %#v, %v", clean, err)
	}
}

func TestPersistentIndexUsesValidBackupWhenCurrentBatchIsCorrupt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library-index.v1.log")
	settings := MediaRootSettings{AudioRoots: []string{"/music"}}
	index, _, _ := OpenPersistentIndex(path, settings)
	if err := index.Reset(settings, []Media{{
		ID: "a", Type: MediaTypeAudio, RootName: "music", RelativePath: "a.mp3",
	}}, 2, time.Time{}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path+".bak", data, 0o600); err != nil {
		t.Fatal(err)
	}
	data[len(data)-1] ^= 0xff
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}

	_, state, err := OpenPersistentIndex(path, settings)
	if err != nil || state.Revision != 2 || len(state.Items) != 1 {
		t.Fatalf("backup state = %#v, %v", state, err)
	}
}

func TestPersistentIndexRecoversInterruptedCheckpointBackup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library-index.v1.log")
	settings := MediaRootSettings{AudioRoots: []string{"/music"}}
	index, _, _ := OpenPersistentIndex(path, settings)
	if err := index.Reset(settings, []Media{{
		ID: "a", Type: MediaTypeAudio, RootName: "music", RelativePath: "a.mp3",
	}}, 6, time.Time{}); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, path+".bak"); err != nil {
		t.Fatal(err)
	}

	_, state, err := OpenPersistentIndex(path, settings)
	if err != nil || state.Revision != 6 || len(state.Items) != 1 {
		t.Fatalf("recovered state = %#v, err = %v", state, err)
	}
}

func TestPersistentIndexRecoversPreparedResetForConfiguredRoots(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library-index.v1.log")
	oldSettings := MediaRootSettings{AudioRoots: []string{"/music"}}
	newSettings := MediaRootSettings{AudioRoots: []string{"/other"}}
	index, _, _ := OpenPersistentIndex(path, oldSettings)
	if err := index.Reset(oldSettings, []Media{{
		ID: "old", Type: MediaTypeAudio, RootName: "music", RelativePath: "old.mp3",
	}}, 3, time.Time{}); err != nil {
		t.Fatal(err)
	}
	if err := index.PrepareReset(newSettings, []Media{{
		ID: "new", Type: MediaTypeAudio, RootName: "other", RelativePath: "new.mp3",
	}}, 4, time.Time{}); err != nil {
		t.Fatal(err)
	}

	_, oldState, err := OpenPersistentIndex(path, oldSettings)
	if err != nil || oldState.Revision != 3 || oldState.Items[0].ID != "old" {
		t.Fatalf("old config recovery = %#v, %v", oldState, err)
	}

	index, _, _ = OpenPersistentIndex(path, oldSettings)
	if err := index.PrepareReset(newSettings, []Media{{
		ID: "new", Type: MediaTypeAudio, RootName: "other", RelativePath: "new.mp3",
	}}, 4, time.Time{}); err != nil {
		t.Fatal(err)
	}
	_, newState, err := OpenPersistentIndex(path, newSettings)
	if err != nil || newState.Revision != 4 || newState.Items[0].ID != "new" {
		t.Fatalf("new config recovery = %#v, %v", newState, err)
	}
}

func TestPersistentIndexSettingsMismatchInvalidatesCache(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library-index.v1.log")
	first := MediaRootSettings{AudioRoots: []string{"/music"}}
	index, _, _ := OpenPersistentIndex(path, first)
	if err := index.Reset(first, []Media{{
		ID: "a", Type: MediaTypeAudio, RootName: "music", RelativePath: "a.mp3",
	}}, 1, time.Time{}); err != nil {
		t.Fatal(err)
	}

	second := MediaRootSettings{AudioRoots: []string{"/other"}}
	_, state, err := OpenPersistentIndex(path, second)
	if !errors.Is(err, errIndexSettingsMismatch) || len(state.Items) != 0 {
		t.Fatalf("mismatch = %#v, %v", state, err)
	}
}

func TestPersistentIndexFingerprintIgnoresRootOrderAndTrailingSeparators(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library-index.v1.log")
	firstRoot := t.TempDir()
	secondRoot := t.TempDir()
	first := MediaRootSettings{AudioRoots: []string{firstRoot, secondRoot}}
	index, _, _ := OpenPersistentIndex(path, first)
	if err := index.Reset(first, []Media{{
		ID: "a", Type: MediaTypeAudio, RootName: "music", RelativePath: "a.mp3",
	}}, 3, time.Time{}); err != nil {
		t.Fatal(err)
	}

	second := MediaRootSettings{AudioRoots: []string{
		secondRoot + string(os.PathSeparator),
		firstRoot + string(os.PathSeparator),
	}}
	_, state, err := OpenPersistentIndex(path, second)
	if err != nil || state.Revision != 3 || len(state.Items) != 1 {
		t.Fatalf("reopen = %#v, %v", state, err)
	}
}

func TestIndexWriterCoalescesBurstAndFlushesOnClose(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library-index.v1.log")
	settings := MediaRootSettings{AudioRoots: []string{"/music"}}
	index, _, _ := OpenPersistentIndex(path, settings)
	writer := newIndexWriter(index, time.Hour)
	for revision := uint64(1); revision <= 50; revision++ {
		writer.Enqueue(indexMutation{
			revision: revision,
			upserts: []Media{{
				ID:           "same",
				Type:         MediaTypeAudio,
				RootName:     "music",
				RelativePath: "same.mp3",
				SizeBytes:    int64(revision),
			}},
		})
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if frames := countIndexFrames(t, path); frames != 2 {
		t.Fatalf("frames = %d, want header + one coalesced batch", frames)
	}
	_, state, err := OpenPersistentIndex(path, settings)
	if err != nil || state.Revision != 50 || state.Items[0].SizeBytes != 50 {
		t.Fatalf("state = %#v, err = %v", state, err)
	}
}

func TestPersistentIndexRepairsInterruptedTailBeforeNextAppend(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library-index.v1.log")
	settings := MediaRootSettings{AudioRoots: []string{"/music"}}
	index, _, _ := OpenPersistentIndex(path, settings)
	if err := index.Reset(settings, []Media{{
		ID: "a", Type: MediaTypeAudio, RootName: "music", RelativePath: "a.mp3",
	}}, 1, time.Time{}); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte{0, 0, 1, 0, 1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	file.Close()

	repaired, state, err := OpenPersistentIndex(path, settings)
	if err != nil || state.Revision != 1 {
		t.Fatalf("repair open = %#v, %v", state, err)
	}
	if err := repaired.Append(2, []Media{{
		ID: "b", Type: MediaTypeAudio, RootName: "music", RelativePath: "b.mp3",
	}}, nil, time.Time{}); err != nil {
		t.Fatal(err)
	}
	_, reopened, err := OpenPersistentIndex(path, settings)
	if err != nil || reopened.Revision != 2 || len(reopened.Items) != 2 {
		t.Fatalf("reopened = %#v, %v", reopened, err)
	}
}

func TestIndexWriterCompactsAccumulatedBatches(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library-index.v1.log")
	settings := MediaRootSettings{AudioRoots: []string{"/music"}}
	index, _, _ := OpenPersistentIndex(path, settings)
	index.batchCount = defaultIndexCompactBatchLimit - 1
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte{0, 0, 0, 4, 1, 2}); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	checkpointCalls := 0
	writer := newIndexWriter(
		index,
		time.Hour,
		func(revision uint64) (indexCheckpoint, bool) {
			checkpointCalls++
			if revision != 1 {
				t.Fatalf("checkpoint revision = %d, want 1", revision)
			}
			return indexCheckpoint{
				settings: settings,
				items: []Media{{
					ID: "a", Type: MediaTypeAudio, RootName: "music", RelativePath: "a.mp3",
				}},
				revision: revision,
			}, true
		},
	)
	writer.Enqueue(indexMutation{
		revision: 1,
		upserts: []Media{{
			ID: "a", Type: MediaTypeAudio, RootName: "music", RelativePath: "a.mp3",
		}},
	})
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if checkpointCalls != 1 {
		t.Fatalf("checkpoint calls = %d, want 1", checkpointCalls)
	}
	if frames := countIndexFrames(t, path); frames != 2 {
		t.Fatalf("frames after compaction = %d, want header + checkpoint", frames)
	}
	_, state, err := OpenPersistentIndex(path, settings)
	if err != nil || state.Revision != 1 || len(state.Items) != 1 {
		t.Fatalf("compacted state = %#v, %v", state, err)
	}
}

func TestIndexWriterRetriesTimedWriteFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library-index.v1.log")
	settings := MediaRootSettings{AudioRoots: []string{"/music"}}
	index, _, _ := OpenPersistentIndex(path, settings)
	writer := newIndexWriter(index, 10*time.Millisecond)
	if err := os.Rename(path, path+".offline"); err != nil {
		t.Fatal(err)
	}
	writer.Enqueue(indexMutation{
		revision: 1,
		upserts: []Media{{
			ID: "a", Type: MediaTypeAudio, RootName: "music", RelativePath: "a.mp3",
		}},
	})
	deadline := time.Now().Add(time.Second)
	for writer.LastError() == nil && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if writer.LastError() == nil {
		t.Fatal("timed write failure was not exposed")
	}
	if err := index.Reset(settings, nil, 0, time.Time{}); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(2 * time.Second)
	for writer.LastError() != nil && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	_, state, err := OpenPersistentIndex(path, settings)
	if err != nil || state.Revision != 1 || len(state.Items) != 1 {
		t.Fatalf("retried state = %#v, %v", state, err)
	}
}

func TestIndexWriterCoalescesLargeUniqueBurst(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library-index.v1.log")
	settings := MediaRootSettings{AudioRoots: []string{"/music"}}
	index, _, _ := OpenPersistentIndex(path, settings)
	writer := newIndexWriter(index, time.Hour)
	const itemCount = 5000
	for item := 0; item < itemCount; item++ {
		id := stringID(item)
		writer.Enqueue(indexMutation{
			revision: uint64(item + 1),
			upserts: []Media{{
				ID: id, Type: MediaTypeAudio, RootName: "music", RelativePath: id + ".mp3",
			}},
		})
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	_, state, err := OpenPersistentIndex(path, settings)
	if err != nil || state.Revision != itemCount || len(state.Items) != itemCount {
		t.Fatalf("large burst items = %d revision = %d err = %v", len(state.Items), state.Revision, err)
	}
}

func TestPersistentIndexOneFileAppendDoesNotRewriteCheckpoint(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library-index.v1.log")
	settings := MediaRootSettings{VideoRoots: []string{"/video"}}
	index, _, _ := OpenPersistentIndex(path, settings)
	items := make([]Media, 1000)
	for item := range items {
		items[item] = Media{
			ID:           stringID(item),
			Type:         MediaTypeVideo,
			RootName:     "video",
			RelativePath: stringID(item) + ".mp4",
		}
	}
	if err := index.Reset(settings, items, 1, time.Time{}); err != nil {
		t.Fatal(err)
	}
	before, _ := os.Stat(path)
	changed := items[500]
	changed.SizeBytes = 123
	if err := index.Append(2, []Media{changed}, nil, time.Time{}); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(path)
	if growth := after.Size() - before.Size(); growth >= before.Size()/10 {
		t.Fatalf("incremental growth = %d, checkpoint size = %d", growth, before.Size())
	}
}

func TestPersistentServiceReturnsCacheBeforeBlockedReconciliation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(t.TempDir(), "library-index.v1.log")
	settings := MediaRootSettings{AudioRoots: []string{dir}}
	roots, _, err := scanMediaRootSettingsReport(settings, nil)
	if err != nil {
		t.Fatal(err)
	}
	root := roots.All()[0]
	index, _, _ := OpenPersistentIndex(path, settings)
	cached := Media{
		ID: "cached", Type: MediaTypeAudio, RootName: root.Name, RelativePath: "cached.mp3",
	}
	if err := index.Reset(settings, []Media{cached}, 9, time.Time{}); err != nil {
		t.Fatal(err)
	}
	service, err := NewPersistentService(
		settings,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
		path,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()

	started := make(chan struct{})
	release := make(chan struct{})
	service.scanner = func(settings MediaRootSettings, logger *slog.Logger) (*mediapath.Roots, []RootScanResult, error) {
		close(started)
		<-release
		return roots, []RootScanResult{{Root: root, Complete: true}}, nil
	}
	done := make(chan struct{})
	go func() {
		_, _ = service.RescanMediaRoots()
		close(done)
	}()
	<-started
	if got := service.List(MediaTypeAudio); len(got) != 1 || got[0].ID != "cached" {
		t.Fatalf("cached list = %#v", got)
	}
	close(release)
	<-done
}

func TestPersistentServiceFlushesIncrementalChangeOnClose(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(t.TempDir(), "library-index.v1.log")
	settings := MediaRootSettings{AudioRoots: []string{dir}}
	service, err := NewPersistentService(
		settings,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
		path,
	)
	if err != nil {
		t.Fatal(err)
	}
	root := service.roots.All()[0]
	result := service.ApplyChanges([]Media{{
		ID:           "new",
		Type:         MediaTypeAudio,
		RootName:     root.Name,
		RelativePath: "new.mp3",
	}}, nil)
	if result.Added != 1 {
		t.Fatalf("ApplyChanges = %#v", result)
	}
	if err := service.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	reopened, err := NewPersistentService(
		settings,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
		path,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if got := reopened.List(MediaTypeAudio); len(got) != 1 || got[0].ID != "new" {
		t.Fatalf("reopened list = %#v", got)
	}
}

func TestPersistentServiceCheckpointsBatchLargerThanJournal(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(t.TempDir(), "library-index.v1.log")
	settings := MediaRootSettings{AudioRoots: []string{dir}}
	service, err := NewPersistentService(
		settings,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
		path,
	)
	if err != nil {
		t.Fatal(err)
	}
	root := service.roots.All()[0]
	items := make([]Media, defaultJournalRecordLimit+1)
	for item := range items {
		items[item] = Media{
			ID:           stringID(item),
			Type:         MediaTypeAudio,
			RootName:     root.Name,
			RelativePath: stringID(item) + ".mp3",
		}
	}
	result := service.ApplyChanges(items, nil)
	if result.Added != len(items) {
		t.Fatalf("ApplyChanges = %#v", result)
	}
	if err := service.Close(); err != nil {
		t.Fatal(err)
	}

	_, state, err := OpenPersistentIndex(path, settings)
	if err != nil || len(state.Items) != len(items) {
		t.Fatalf("state items = %d, err = %v", len(state.Items), err)
	}
}

func countIndexFrames(t *testing.T, path string) int {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	count := 0
	for {
		_, complete, err := readIndexFrame(file)
		if err != nil {
			t.Fatal(err)
		}
		if !complete {
			return count
		}
		count++
	}
}

func stringID(value int) string {
	return time.Unix(int64(value), 0).UTC().Format("150405.000000000")
}
