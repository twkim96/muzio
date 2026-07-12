package library

import (
	"path/filepath"
	"testing"
	"time"
)

func BenchmarkPersistentIndexLoadFifteenThousand(b *testing.B) {
	path := filepath.Join(b.TempDir(), "library-index.v1.log")
	settings := MediaRootSettings{VideoRoots: []string{"/video"}}
	index, _, _ := OpenPersistentIndex(path, settings)
	items := benchmarkSnapshotItems()
	if err := index.Reset(settings, items, 1, time.Now().UTC()); err != nil {
		b.Fatal(err)
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, state, err := OpenPersistentIndex(path, settings)
		if err != nil {
			b.Fatal(err)
		}
		if len(state.Items) != len(items) {
			b.Fatalf("items = %d", len(state.Items))
		}
	}
}

func BenchmarkPersistentIndexAppendOneOfFifteenThousand(b *testing.B) {
	path := filepath.Join(b.TempDir(), "library-index.v1.log")
	settings := MediaRootSettings{VideoRoots: []string{"/video"}}
	index, _, _ := OpenPersistentIndex(path, settings)
	items := benchmarkSnapshotItems()
	if err := index.Reset(settings, items, 1, time.Now().UTC()); err != nil {
		b.Fatal(err)
	}
	target := items[len(items)/2]

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		target.SizeBytes = int64(i + 1)
		if err := index.Append(
			uint64(i+2),
			[]Media{target},
			nil,
			time.Time{},
		); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkPersistentIndexResetFifteenThousand(b *testing.B) {
	path := filepath.Join(b.TempDir(), "library-index.v1.log")
	settings := MediaRootSettings{VideoRoots: []string{"/video"}}
	index, _, _ := OpenPersistentIndex(path, settings)
	items := benchmarkSnapshotItems()

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := index.Reset(settings, items, uint64(i+1), time.Time{}); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkIndexWriterResetFifteenThousand(b *testing.B) {
	path := filepath.Join(b.TempDir(), "library-index.v1.log")
	settings := MediaRootSettings{VideoRoots: []string{"/video"}}
	index, _, _ := OpenPersistentIndex(path, settings)
	writer := newIndexWriter(index, time.Millisecond)
	defer writer.Close()
	items := benchmarkSnapshotItems()

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := writer.Reset(settings, items, uint64(i+1), time.Time{}); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkIndexWriterResetHundredThousand(b *testing.B) {
	path := filepath.Join(b.TempDir(), "library-index.v1.log")
	settings := MediaRootSettings{VideoRoots: []string{"/video"}}
	index, _, _ := OpenPersistentIndex(path, settings)
	writer := newIndexWriter(index, time.Millisecond)
	defer writer.Close()
	items := benchmarkSnapshotItemsN(100000)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := writer.Reset(settings, items, uint64(i+1), time.Time{}); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkIndexWriterCheckpointCompactionFifteenThousand(b *testing.B) {
	benchmarkIndexWriterCheckpointCompaction(b, benchmarkSnapshotItems())
}

func BenchmarkIndexWriterCheckpointCompactionHundredThousand(b *testing.B) {
	benchmarkIndexWriterCheckpointCompaction(b, benchmarkSnapshotItemsN(100000))
}

func benchmarkIndexWriterCheckpointCompaction(b *testing.B, items []Media) {
	settings := MediaRootSettings{VideoRoots: []string{"/video"}}
	target := items[len(items)/2]

	b.ReportAllocs()
	b.ResetTimer()
	for iteration := 0; iteration < b.N; iteration++ {
		b.StopTimer()
		path := filepath.Join(b.TempDir(), "library-index.v1.log")
		index, _, _ := OpenPersistentIndex(path, settings)
		if err := index.Reset(settings, items, 1, time.Time{}); err != nil {
			b.Fatal(err)
		}
		index.batchCount = defaultIndexCompactBatchLimit - 1
		checkpoint := cloneMediaSlice(items)
		checkpoint[len(checkpoint)/2].SizeBytes = int64(iteration + 1)
		writer := newIndexWriter(
			index,
			time.Hour,
			func(revision uint64) (indexCheckpoint, bool) {
				return indexCheckpoint{
					settings: settings,
					items:    checkpoint,
					revision: revision,
				}, true
			},
		)
		b.StartTimer()
		target.SizeBytes = int64(iteration + 1)
		writer.Enqueue(indexMutation{revision: 2, upserts: []Media{target}})
		if err := writer.Close(); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkPendingIndexMutationMergeFiveThousand(b *testing.B) {
	items := benchmarkSnapshotItems()[:5000]
	b.ReportAllocs()
	for iteration := 0; iteration < b.N; iteration++ {
		var pending pendingIndexMutation
		for index, item := range items {
			pending.merge(indexMutation{
				revision: uint64(index + 1),
				upserts:  []Media{item},
			})
		}
		if len(pending.upserts) != len(items) {
			b.Fatalf("upserts = %d", len(pending.upserts))
		}
	}
}
