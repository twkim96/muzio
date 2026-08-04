// Package videoopt contains the bounded inspection and preparation primitives
// used by the explicit video optimization cache.
package videoopt

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
)

var ErrInvalidMP4 = errors.New("invalid MP4 container")

// Layout describes the position of the movie index relative to media data.
type Layout string

const (
	LayoutUnknown    Layout = "unknown"
	LayoutFrontMoov  Layout = "front-moov"
	LayoutEndMoov    Layout = "end-moov"
	LayoutFragmented Layout = "fragmented"
)

// Atom identifies one top-level MP4 atom without retaining its payload.
type Atom struct {
	Type       string
	Offset     int64
	Size       int64
	HeaderSize int64
}

// Inspection is the bounded result needed to decide whether a file can
// benefit from a faststart sidecar. It intentionally retains only relevant
// top-level atom locations instead of a potentially unbounded atom list.
type Inspection struct {
	FileSize int64
	Layout   Layout

	FileType           *Atom
	Movie              *Atom
	FirstMediaPayload  *Atom
	LastMediaPayload   *Atom
	MediaPayloadCount  int64
	MovieFragmentCount int64

	AtomCount       int64
	HeaderBytesRead int64
}

// InspectMP4 walks top-level atom headers using ReaderAt. It never reads atom
// payloads, including moov, so work is proportional to the number of top-level
// atoms rather than the media size.
func InspectMP4(reader io.ReaderAt, fileSize int64) (Inspection, error) {
	result := Inspection{FileSize: fileSize, Layout: LayoutUnknown}
	if reader == nil {
		return result, fmt.Errorf("%w: reader is required", ErrInvalidMP4)
	}
	if fileSize < 8 {
		return result, fmt.Errorf("%w: file is smaller than an atom header", ErrInvalidMP4)
	}

	var header [16]byte
	for offset := int64(0); offset < fileSize; {
		remaining := fileSize - offset
		if remaining < 8 {
			return result, invalidAtom(offset, "truncated atom header")
		}
		if err := readHeaderAt(reader, header[:8], offset, &result); err != nil {
			return result, err
		}

		size32 := binary.BigEndian.Uint32(header[:4])
		atom := Atom{
			Type:       string(header[4:8]),
			Offset:     offset,
			HeaderSize: 8,
		}

		switch size32 {
		case 0:
			// A zero size in the encoded header is the ISO BMFF size-to-EOF
			// form. The computed atom size must still contain its header.
			atom.Size = remaining
		case 1:
			if remaining < 16 {
				return result, invalidAtom(offset, "truncated extended-size atom header")
			}
			if err := readHeaderAt(reader, header[8:16], offset+8, &result); err != nil {
				return result, err
			}
			extended := binary.BigEndian.Uint64(header[8:16])
			if extended > math.MaxInt64 {
				return result, invalidAtom(offset, "extended atom size overflows int64")
			}
			atom.HeaderSize = 16
			atom.Size = int64(extended)
		default:
			atom.Size = int64(size32)
		}

		if atom.Size < atom.HeaderSize {
			return result, invalidAtom(offset, "atom size is smaller than its header")
		}
		// Comparing against remaining avoids offset+size overflow.
		if atom.Size > remaining {
			return result, invalidAtom(offset, "atom extends beyond the file")
		}

		result.AtomCount++
		switch atom.Type {
		case "ftyp":
			if result.FileType == nil {
				result.FileType = cloneAtom(atom)
			}
		case "moov":
			if result.Movie != nil {
				return result, invalidAtom(offset, "multiple top-level moov atoms")
			}
			result.Movie = cloneAtom(atom)
		case "mdat":
			if result.FirstMediaPayload == nil {
				result.FirstMediaPayload = cloneAtom(atom)
			}
			result.LastMediaPayload = cloneAtom(atom)
			result.MediaPayloadCount++
		case "moof":
			result.MovieFragmentCount++
		}

		offset += atom.Size
	}

	switch {
	case result.MovieFragmentCount > 0:
		result.Layout = LayoutFragmented
	case result.Movie != nil && result.FirstMediaPayload != nil &&
		result.Movie.Offset < result.FirstMediaPayload.Offset:
		result.Layout = LayoutFrontMoov
	case result.Movie != nil && result.FirstMediaPayload != nil:
		result.Layout = LayoutEndMoov
	}

	return result, nil
}

func readHeaderAt(reader io.ReaderAt, buffer []byte, offset int64, result *Inspection) error {
	n, err := reader.ReadAt(buffer, offset)
	result.HeaderBytesRead += int64(n)
	if n != len(buffer) {
		if err == nil {
			err = io.ErrUnexpectedEOF
		}
		return invalidAtom(offset, fmt.Sprintf("read atom header: %v", err))
	}
	return nil
}

func invalidAtom(offset int64, reason string) error {
	return fmt.Errorf("%w at offset %d: %s", ErrInvalidMP4, offset, reason)
}

func cloneAtom(atom Atom) *Atom {
	copy := atom
	return &copy
}
