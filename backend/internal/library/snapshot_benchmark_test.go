package library

import (
	"fmt"
	"testing"
	"time"
)

func BenchmarkSnapshotApplyOneOfFifteenThousand(b *testing.B) {
	items := benchmarkSnapshotItems()
	snapshot := NewSnapshot(items)
	target := items[len(items)/2]

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		target.SizeBytes = int64(i + 1)
		result := snapshot.Apply([]Media{target}, nil)
		if result.Updated != 1 {
			b.Fatalf("Apply result = %#v", result)
		}
	}
}

func BenchmarkSnapshotRenameOneOfFifteenThousand(b *testing.B) {
	items := benchmarkSnapshotItems()
	snapshot := NewSnapshot(items)
	current := items[len(items)/2]

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		next := current
		next.ID = fmt.Sprintf("renamed-%d", i)
		next.RelativePath = fmt.Sprintf("folder/renamed-%d.mp4", i)
		next.Name = fmt.Sprintf("renamed-%d.mp4", i)
		result := snapshot.Apply([]Media{next}, []string{current.ID})
		if result.Added != 1 || result.Removed != 1 {
			b.Fatalf("Apply result = %#v", result)
		}
		current = next
	}
}

func BenchmarkSnapshotListFifteenThousand(b *testing.B) {
	snapshot := NewSnapshot(benchmarkSnapshotItems())

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if items := snapshot.List(""); len(items) != 15000 {
			b.Fatalf("List len = %d", len(items))
		}
	}
}

func BenchmarkSnapshotListHundredThousand(b *testing.B) {
	snapshot := NewSnapshot(benchmarkSnapshotItemsN(100000))

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if items := snapshot.List(""); len(items) != 100000 {
			b.Fatalf("List len = %d", len(items))
		}
	}
}

func BenchmarkSnapshotReconciledUnchangedFifteenThousand(b *testing.B) {
	benchmarkSnapshotReconciledUnchanged(b, 15000)
}

func BenchmarkSnapshotReconciledUnchangedHundredThousand(b *testing.B) {
	benchmarkSnapshotReconciledUnchanged(b, 100000)
}

func BenchmarkSnapshotReconciledOneChangeFifteenThousand(b *testing.B) {
	items := benchmarkSnapshotItems()
	snapshot := NewSnapshot(items)
	target := len(items) / 2

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		items[target].SizeBytes = int64(i + 1)
		next, result := snapshot.Reconciled(items)
		if next == snapshot || result.Updated != 1 {
			b.Fatalf("Reconciled result = %#v", result)
		}
		snapshot = next
	}
}

func benchmarkSnapshotReconciledUnchanged(b *testing.B, count int) {
	items := benchmarkSnapshotItemsN(count)
	snapshot := NewSnapshot(items)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		next, result := snapshot.Reconciled(items)
		if result.Revision != snapshot.Revision() ||
			result.Added != 0 || result.Updated != 0 || result.Removed != 0 {
			b.Fatalf("Reconciled result = %#v", result)
		}
		snapshot = next
	}
}

func benchmarkSnapshotItems() []Media {
	return benchmarkSnapshotItemsN(15000)
}

func benchmarkSnapshotItemsN(count int) []Media {
	items := make([]Media, count)
	for i := range items {
		items[i] = Media{
			ID:           fmt.Sprintf("id-%05d", i),
			Type:         MediaTypeVideo,
			RootName:     "video",
			RelativePath: fmt.Sprintf("folder/item-%05d.mp4", i),
			Name:         fmt.Sprintf("item-%05d.mp4", i),
			ModifiedAt:   time.Unix(int64(i), 0),
		}
	}
	return items
}
