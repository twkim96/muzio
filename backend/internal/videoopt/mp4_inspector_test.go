package videoopt

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestInspectMP4ClassifiesLayouts(t *testing.T) {
	tests := []struct {
		name   string
		atoms  [][]byte
		layout Layout
	}{
		{
			name:   "front moov",
			atoms:  [][]byte{atom32("ftyp", nil), atom32("moov", []byte("index")), atom32("mdat", []byte("media"))},
			layout: LayoutFrontMoov,
		},
		{
			name:   "end moov",
			atoms:  [][]byte{atom32("ftyp", nil), atom32("mdat", []byte("media")), atom32("moov", []byte("index"))},
			layout: LayoutEndMoov,
		},
		{
			name:   "fragmented",
			atoms:  [][]byte{atom32("ftyp", nil), atom32("moov", nil), atom32("moof", nil), atom32("mdat", nil)},
			layout: LayoutFragmented,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := bytes.Join(test.atoms, nil)
			got, err := InspectMP4(bytes.NewReader(fixture), int64(len(fixture)))
			if err != nil {
				t.Fatalf("InspectMP4() error = %v", err)
			}
			if got.Layout != test.layout {
				t.Fatalf("Layout = %q, want %q", got.Layout, test.layout)
			}
			if got.HeaderBytesRead > got.AtomCount*16 {
				t.Fatalf("HeaderBytesRead = %d for %d atoms", got.HeaderBytesRead, got.AtomCount)
			}
		})
	}
}

func TestInspectMP4HandlesExtendedSizeAndSizeToEOF(t *testing.T) {
	extended := atom64("mdat", []byte("media"))
	toEOF := atomToEOF("moov", []byte("index"))
	fixture := bytes.Join([][]byte{atom32("ftyp", nil), extended, toEOF}, nil)

	got, err := InspectMP4(bytes.NewReader(fixture), int64(len(fixture)))
	if err != nil {
		t.Fatalf("InspectMP4() error = %v", err)
	}
	if got.Layout != LayoutEndMoov {
		t.Fatalf("Layout = %q, want %q", got.Layout, LayoutEndMoov)
	}
	if got.FirstMediaPayload == nil || got.FirstMediaPayload.HeaderSize != 16 {
		t.Fatalf("FirstMediaPayload = %#v, want extended-size atom", got.FirstMediaPayload)
	}
	if got.Movie == nil || got.Movie.Size != int64(len(toEOF)) {
		t.Fatalf("Movie = %#v, want size-to-EOF size %d", got.Movie, len(toEOF))
	}
}

func TestInspectMP4RejectsMalformedHeaders(t *testing.T) {
	tests := []struct {
		name    string
		fixture []byte
		size    int64
	}{
		{name: "short file", fixture: []byte{0, 0, 0}, size: 3},
		{name: "trailing partial header", fixture: append(atom32("ftyp", nil), 0), size: 9},
		{name: "size below header", fixture: rawHeader(4, "free"), size: 8},
		{name: "range beyond file", fixture: rawHeader(24, "mdat"), size: 8},
		{name: "truncated extended header", fixture: rawHeader(1, "mdat"), size: 8},
		{name: "extended size below header", fixture: extendedHeader(12, "mdat"), size: 16},
		{name: "extended size overflow", fixture: extendedHeader(^uint64(0), "mdat"), size: 16},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := InspectMP4(bytes.NewReader(test.fixture), test.size)
			if !errors.Is(err, ErrInvalidMP4) {
				t.Fatalf("InspectMP4() error = %v, want ErrInvalidMP4", err)
			}
		})
	}
}

func TestInspectMP4RejectsDuplicateMovieAtoms(t *testing.T) {
	fixture := bytes.Join([][]byte{atom32("moov", nil), atom32("moov", nil)}, nil)
	_, err := InspectMP4(bytes.NewReader(fixture), int64(len(fixture)))
	if !errors.Is(err, ErrInvalidMP4) {
		t.Fatalf("InspectMP4() error = %v, want ErrInvalidMP4", err)
	}
}

func TestInspectMP4LargeSparseFileReadsOnlyHeaders(t *testing.T) {
	const fileSize int64 = 16 << 30
	path := filepath.Join(t.TempDir(), "large-end-moov.mp4")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = file.Close() })
	if err := file.Truncate(fileSize); err != nil {
		t.Skipf("sparse files unavailable: %v", err)
	}

	if _, err := file.WriteAt(rawHeader(8, "ftyp"), 0); err != nil {
		t.Fatal(err)
	}
	mediaSize := uint64(fileSize - 16)
	if _, err := file.WriteAt(extendedHeader(mediaSize, "mdat"), 8); err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteAt(rawHeader(8, "moov"), fileSize-8); err != nil {
		t.Fatal(err)
	}

	reader := &countingReaderAt{reader: file}
	got, err := InspectMP4(reader, fileSize)
	if err != nil {
		t.Fatalf("InspectMP4() error = %v", err)
	}
	if got.Layout != LayoutEndMoov {
		t.Fatalf("Layout = %q, want %q", got.Layout, LayoutEndMoov)
	}
	if got.AtomCount != 3 || reader.bytesRead != 32 || got.HeaderBytesRead != 32 {
		t.Fatalf("atoms=%d reader bytes=%d reported bytes=%d, want 3/32/32", got.AtomCount, reader.bytesRead, got.HeaderBytesRead)
	}
}

type countingReaderAt struct {
	reader    io.ReaderAt
	bytesRead int64
}

func (r *countingReaderAt) ReadAt(buffer []byte, offset int64) (int, error) {
	n, err := r.reader.ReadAt(buffer, offset)
	r.bytesRead += int64(n)
	return n, err
}

func atom32(kind string, payload []byte) []byte {
	result := rawHeader(uint32(8+len(payload)), kind)
	return append(result, payload...)
}

func atom64(kind string, payload []byte) []byte {
	result := extendedHeader(uint64(16+len(payload)), kind)
	return append(result, payload...)
}

func atomToEOF(kind string, payload []byte) []byte {
	result := rawHeader(0, kind)
	return append(result, payload...)
}

func rawHeader(size uint32, kind string) []byte {
	result := make([]byte, 8)
	binary.BigEndian.PutUint32(result[:4], size)
	copy(result[4:8], kind)
	return result
}

func extendedHeader(size uint64, kind string) []byte {
	result := make([]byte, 16)
	binary.BigEndian.PutUint32(result[:4], 1)
	copy(result[4:8], kind)
	binary.BigEndian.PutUint64(result[8:16], size)
	return result
}
