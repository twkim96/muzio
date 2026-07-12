package thumbnail

import (
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestImageExtractorWritesBoundedJPEG(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source.png")
	output := filepath.Join(dir, "preview.jpg")
	file, err := os.Create(source)
	if err != nil {
		t.Fatal(err)
	}
	input := image.NewRGBA(image.Rect(0, 0, 800, 600))
	for y := 0; y < input.Bounds().Dy(); y++ {
		for x := 0; x < input.Bounds().Dx(); x++ {
			input.SetRGBA(x, y, color.RGBA{R: 20, G: 80, B: 140, A: 255})
		}
	}
	if err := png.Encode(file, input); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(output, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	if err := (ImageExtractor{}).Extract(context.Background(), source, output); err != nil {
		t.Fatal(err)
	}
	preview, err := os.Open(output)
	if err != nil {
		t.Fatal(err)
	}
	defer preview.Close()
	config, format, err := image.DecodeConfig(preview)
	if err != nil {
		t.Fatal(err)
	}
	if format != "jpeg" {
		t.Fatalf("format = %q, want jpeg", format)
	}
	if config.Width != 240 || config.Height != 180 {
		t.Fatalf("dimensions = %dx%d, want 240x180", config.Width, config.Height)
	}
}

func TestImageExtractorRejectsUnsafeDimensions(t *testing.T) {
	if err := validateImageDimensions(100_000, 100); err == nil {
		t.Fatal("oversized side accepted")
	}
	if err := validateImageDimensions(10_000, 10_000); err == nil {
		t.Fatal("oversized pixel count accepted")
	}
}

func TestImageExtractorHonorsCanceledContext(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source.png")
	if err := os.WriteFile(source, []byte("not-read"), 0o600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(dir, "preview.jpg")
	if err := os.WriteFile(output, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := (ImageExtractor{}).Extract(ctx, source, output); err == nil {
		t.Fatal("canceled extraction succeeded")
	}
}
