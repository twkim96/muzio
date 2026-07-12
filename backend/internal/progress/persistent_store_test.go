package progress

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestPersistentStoreRestoresRecordsAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "progress.v1.json")
	store, err := OpenPersistentStore(path)
	if err != nil {
		t.Fatalf("OpenPersistentStore: %v", err)
	}
	playedAt := time.Date(2026, 6, 12, 1, 2, 3, 0, time.UTC)
	if _, err := store.Put(Record{
		MediaID:      "video-1",
		PositionSec:  42,
		DurationSec:  600,
		LastPlayedAt: playedAt,
	}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	reopened, err := OpenPersistentStore(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	got, err := reopened.Get("video-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.PositionSec != 42 || !got.LastPlayedAt.Equal(playedAt) {
		t.Fatalf("restored record = %#v", got)
	}
}

func TestPersistentStoreKeepsNewerRecordAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "progress.v1.json")
	store, err := OpenPersistentStore(path)
	if err != nil {
		t.Fatal(err)
	}
	newer := time.Date(2026, 6, 12, 2, 0, 0, 0, time.UTC)
	if _, err := store.Put(Record{
		MediaID:      "audio-1",
		PositionSec:  90,
		DurationSec:  300,
		LastPlayedAt: newer,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenPersistentStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	saved, err := reopened.Put(Record{
		MediaID:      "audio-1",
		PositionSec:  10,
		DurationSec:  300,
		LastPlayedAt: newer.Add(-time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if saved.PositionSec != 90 {
		t.Fatalf("PositionSec = %v, want 90", saved.PositionSec)
	}
}

func TestPersistentStorePersistsDelete(t *testing.T) {
	path := filepath.Join(t.TempDir(), "progress.v1.json")
	store, err := OpenPersistentStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put(Record{MediaID: "m1", DurationSec: 1}); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	store, err = OpenPersistentStore(path)
	if err != nil {
		t.Fatal(err)
	}
	store.Delete("m1")
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenPersistentStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	if _, err := reopened.Get("m1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get error = %v, want ErrNotFound", err)
	}
}

func TestPersistentStoreCorruptFileDoesNotBlockStartup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "progress.v1.json")
	if err := os.WriteFile(path, []byte(`{"version":1,"records":[`), 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := OpenPersistentStore(path)
	if store == nil {
		t.Fatal("OpenPersistentStore returned nil store")
	}
	if !errors.Is(err, ErrPersistenceCorrupt) {
		t.Fatalf("OpenPersistentStore error = %v, want ErrPersistenceCorrupt", err)
	}
	if closeErr := store.Close(); closeErr != nil {
		t.Fatalf("Close after corrupt load: %v", closeErr)
	}

	reopened, err := OpenPersistentStore(path)
	if err != nil {
		t.Fatalf("reopen repaired store: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	if records := reopened.List(); len(records) != 0 {
		t.Fatalf("repaired records = %#v", records)
	}
	if _, err := reopened.Put(Record{MediaID: "recovered", DurationSec: 1}); err != nil {
		t.Fatalf("Put after recovery: %v", err)
	}
}

func TestPersistentStoreRecoversValidBackup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "progress.v1.json")
	store, err := OpenPersistentStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put(Record{MediaID: "from-backup", DurationSec: 1}); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, path+".bak"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"version":1,"records":[`), 0o600); err != nil {
		t.Fatal(err)
	}

	recovered, err := OpenPersistentStore(path)
	if err != nil {
		t.Fatalf("OpenPersistentStore: %v", err)
	}
	t.Cleanup(func() { _ = recovered.Close() })
	if _, err := recovered.Get("from-backup"); err != nil {
		t.Fatalf("Get recovered record: %v", err)
	}
	if _, err := os.Stat(path + ".bak"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("backup still exists: %v", err)
	}
}

func TestPersistentStoreCoalescesWriteBurst(t *testing.T) {
	path := filepath.Join(t.TempDir(), "progress.v1.json")
	var writes atomic.Int32
	store, err := openPersistentStore(path, persistentStoreOptions{
		quietWindow: 20 * time.Millisecond,
		writeFile: func(path string, data []byte) error {
			writes.Add(1)
			return atomicWriteProgressFile(path, data)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 20; index++ {
		if _, err := store.Put(Record{
			MediaID:     "m1",
			PositionSec: float64(index),
			DurationSec: 100,
		}); err != nil {
			t.Fatal(err)
		}
	}
	waitFor(t, time.Second, func() bool { return writes.Load() == 1 })
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if got := writes.Load(); got != 1 {
		t.Fatalf("writes = %d, want 1", got)
	}
}

func TestPersistentStoreRetriesFailedFlushWithoutAnotherMutation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "progress.v1.json")
	var attempts atomic.Int32
	store, err := openPersistentStore(path, persistentStoreOptions{
		quietWindow: 10 * time.Millisecond,
		writeFile: func(path string, data []byte) error {
			if attempts.Add(1) == 1 {
				return errors.New("temporary write failure")
			}
			return atomicWriteProgressFile(path, data)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	if _, err := store.Put(Record{
		MediaID:     "retry",
		PositionSec: 42,
		DurationSec: 100,
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, time.Second, func() bool { return attempts.Load() >= 2 })
	waitFor(t, time.Second, func() bool { return store.LastError() == nil })

	reopened, err := OpenPersistentStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	record, err := reopened.Get("retry")
	if err != nil || record.PositionSec != 42 {
		t.Fatalf("record = %#v, error = %v", record, err)
	}
}

func TestPersistentStoreCloseContextHonorsDeadline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "progress.v1.json")
	writeStarted := make(chan struct{})
	releaseWrite := make(chan struct{})
	store, err := openPersistentStore(path, persistentStoreOptions{
		quietWindow: time.Hour,
		writeFile: func(string, []byte) error {
			close(writeStarted)
			<-releaseWrite
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put(Record{MediaID: "m1", DurationSec: 1}); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	err = store.CloseContext(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("CloseContext error = %v, want deadline exceeded", err)
	}
	<-writeStarted
	close(releaseWrite)
	if err := store.Close(); err != nil {
		t.Fatalf("Close after releasing writer: %v", err)
	}
}

func waitFor(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition was not met before timeout")
}
