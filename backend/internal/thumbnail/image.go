package thumbnail

import (
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"os"
)

const (
	imagePreviewMaxWidth  = 320
	imagePreviewMaxHeight = 180
	imageSourceMaxBytes   = 128 << 20
	imageSourceMaxPixels  = 50_000_000
	imageSourceMaxSide    = 32_768
)

// ImageExtractor decodes common Go-supported image formats and writes a
// bounded JPEG preview. Unsupported formats fall back to the generated SVG;
// the original media endpoint remains available to browsers that support them.
type ImageExtractor struct{}

func (ImageExtractor) Extract(
	ctx context.Context,
	source string,
	output string,
) error {
	file, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("open image preview source: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("stat image preview source: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 {
		return errors.New("image preview source is not a non-empty regular file")
	}
	if info.Size() > imageSourceMaxBytes {
		return fmt.Errorf("image preview source exceeds %d bytes", imageSourceMaxBytes)
	}

	reader := &contextReader{ctx: ctx, reader: file}
	config, _, err := image.DecodeConfig(reader)
	if err != nil {
		return fmt.Errorf("decode image preview config: %w", err)
	}
	if err := validateImageDimensions(config.Width, config.Height); err != nil {
		return err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("rewind image preview source: %w", err)
	}
	decoded, _, err := image.Decode(&contextReader{ctx: ctx, reader: file})
	if err != nil {
		return fmt.Errorf("decode image preview: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	preview := resizeNearest(decoded, imagePreviewMaxWidth, imagePreviewMaxHeight)
	target, err := os.OpenFile(output, os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("open image preview output: %w", err)
	}
	encodeErr := jpeg.Encode(target, preview, &jpeg.Options{Quality: 82})
	closeErr := target.Close()
	if encodeErr != nil {
		return fmt.Errorf("encode image preview: %w", encodeErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close image preview output: %w", closeErr)
	}
	return nil
}

func validateImageDimensions(width, height int) error {
	if width <= 0 || height <= 0 {
		return errors.New("image preview dimensions are invalid")
	}
	if width > imageSourceMaxSide || height > imageSourceMaxSide {
		return fmt.Errorf(
			"image preview dimensions exceed %dx%d",
			imageSourceMaxSide,
			imageSourceMaxSide,
		)
	}
	if int64(width)*int64(height) > imageSourceMaxPixels {
		return fmt.Errorf("image preview exceeds %d pixels", imageSourceMaxPixels)
	}
	return nil
}

func resizeNearest(source image.Image, maxWidth, maxHeight int) *image.RGBA {
	bounds := source.Bounds()
	sourceWidth := bounds.Dx()
	sourceHeight := bounds.Dy()
	targetWidth, targetHeight := fitDimensions(
		sourceWidth,
		sourceHeight,
		maxWidth,
		maxHeight,
	)
	target := image.NewRGBA(image.Rect(0, 0, targetWidth, targetHeight))
	for y := 0; y < targetHeight; y++ {
		sourceY := bounds.Min.Y + y*sourceHeight/targetHeight
		for x := 0; x < targetWidth; x++ {
			sourceX := bounds.Min.X + x*sourceWidth/targetWidth
			target.Set(x, y, color.RGBAModel.Convert(source.At(sourceX, sourceY)))
		}
	}
	return target
}

func fitDimensions(width, height, maxWidth, maxHeight int) (int, int) {
	if width <= maxWidth && height <= maxHeight {
		return width, height
	}
	if width*maxHeight >= height*maxWidth {
		targetHeight := max(1, height*maxWidth/width)
		return maxWidth, targetHeight
	}
	targetWidth := max(1, width*maxHeight/height)
	return targetWidth, maxHeight
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}
