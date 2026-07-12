package library

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"muzio/backend/internal/mediapath"
)

func BenchmarkScanDenseDirectory(b *testing.B) {
	dir := b.TempDir()
	for i := 0; i < 1000; i++ {
		name := fmt.Sprintf("track-%04d.mp3", i)
		if err := os.WriteFile(filepath.Join(dir, name), []byte("audio"), 0o600); err != nil {
			b.Fatal(err)
		}
		if i%10 == 0 {
			subtitle := fmt.Sprintf("track-%04d.en.srt", i)
			if err := os.WriteFile(filepath.Join(dir, subtitle), []byte("subtitle"), 0o600); err != nil {
				b.Fatal(err)
			}
		}
	}
	benchmarkScan(b, []string{dir})
}

func BenchmarkScanSubtitleDenseDirectory(b *testing.B) {
	dir := b.TempDir()
	for i := 0; i < 1000; i++ {
		name := fmt.Sprintf("episode-%04d.mkv", i)
		if err := os.WriteFile(filepath.Join(dir, name), []byte("video"), 0o600); err != nil {
			b.Fatal(err)
		}
		subtitle := fmt.Sprintf("episode-%04d.en.srt", i)
		if err := os.WriteFile(filepath.Join(dir, subtitle), []byte("subtitle"), 0o600); err != nil {
			b.Fatal(err)
		}
	}
	benchmarkScan(b, []string{dir})
}

func BenchmarkScanNestedDirectories(b *testing.B) {
	dir := b.TempDir()
	for directory := 0; directory < 100; directory++ {
		child := filepath.Join(dir, fmt.Sprintf("album-%03d", directory))
		if err := os.MkdirAll(child, 0o755); err != nil {
			b.Fatal(err)
		}
		for file := 0; file < 10; file++ {
			name := fmt.Sprintf("artist - track-%02d.mp3", file)
			if err := os.WriteFile(filepath.Join(child, name), []byte("audio"), 0o600); err != nil {
				b.Fatal(err)
			}
		}
	}
	benchmarkScan(b, []string{dir})
}

func BenchmarkScanRealLibrary(b *testing.B) {
	value := os.Getenv("VMA_BENCH_MEDIA_ROOTS")
	if value == "" {
		b.Skip("set VMA_BENCH_MEDIA_ROOTS to benchmark the real library")
	}
	benchmarkScan(b, filepath.SplitList(value))
}

func BenchmarkScanConfiguredLibrary(b *testing.B) {
	settings := MediaRootSettings{
		AudioRoots: splitBenchmarkRoots("VMA_BENCH_AUDIO_ROOTS"),
		VideoRoots: splitBenchmarkRoots("VMA_BENCH_VIDEO_ROOTS"),
		ImageRoots: splitBenchmarkRoots("VMA_BENCH_IMAGE_ROOTS"),
	}
	if len(settings.EffectiveRoots()) == 0 {
		b.Skip("set VMA_BENCH_AUDIO_ROOTS, VMA_BENCH_VIDEO_ROOTS, or VMA_BENCH_IMAGE_ROOTS")
	}
	logger := newTestLogger()

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, items, err := scanMediaRootSettings(settings, logger)
		if err != nil {
			b.Fatal(err)
		}
		if len(items) == 0 {
			b.Fatal("scan returned no media items")
		}
	}
}

func benchmarkScan(b *testing.B, paths []string) {
	b.Helper()
	roots, err := mediapath.NewRoots(paths)
	if err != nil {
		b.Fatal(err)
	}
	logger := newTestLogger()

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		items, err := Scan(roots, logger)
		if err != nil {
			b.Fatal(err)
		}
		if len(items) == 0 {
			b.Fatal("scan returned no media items")
		}
	}
}

func splitBenchmarkRoots(key string) []string {
	value := os.Getenv(key)
	if value == "" {
		return nil
	}
	return filepath.SplitList(value)
}
