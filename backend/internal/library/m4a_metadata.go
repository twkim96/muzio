package library

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const maxM4AMetadataValueBytes = 64 << 10

var (
	mp4AtomMoov   = [4]byte{'m', 'o', 'o', 'v'}
	mp4AtomUdta   = [4]byte{'u', 'd', 't', 'a'}
	mp4AtomMeta   = [4]byte{'m', 'e', 't', 'a'}
	mp4AtomIlst   = [4]byte{'i', 'l', 's', 't'}
	mp4AtomArtist = [4]byte{0xa9, 'A', 'R', 'T'}
	mp4AtomData   = [4]byte{'d', 'a', 't', 'a'}
)

type mp4Atom struct {
	payloadOffset int64
	payloadSize   int64
}

// EnrichMetadataFromFile overlays cheap, container-native metadata on top of
// the filename/path fallback. Only M4A artist is read today: the scanner must
// not spawn one ffprobe process per library item, and unrelated formats keep
// their established naming behavior.
func EnrichMetadataFromFile(path string, mediaType MediaType, metadata Metadata) Metadata {
	if mediaType != MediaTypeAudio || !strings.EqualFold(filepath.Ext(path), ".m4a") {
		return metadata
	}
	artist, err := readM4AArtist(path)
	if err == nil && artist != "" {
		metadata.Artist = artist
	}
	return metadata
}

func readM4AArtist(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	moov, ok, err := findMP4Atom(file, 0, info.Size(), mp4AtomMoov)
	if err != nil || !ok {
		return "", err
	}

	// iTunes-style metadata normally lives at moov/udta/meta/ilst. A few
	// writers place meta directly under moov, so accept that layout as well.
	if udta, found, findErr := findMP4Atom(
		file,
		moov.payloadOffset,
		moov.payloadSize,
		mp4AtomUdta,
	); findErr != nil {
		return "", findErr
	} else if found {
		if artist, found, readErr := readArtistFromMetaParent(file, udta); readErr != nil || found {
			return artist, readErr
		}
	}
	artist, _, err := readArtistFromMetaParent(file, moov)
	return artist, err
}

func readArtistFromMetaParent(reader io.ReaderAt, parent mp4Atom) (string, bool, error) {
	meta, ok, err := findMP4Atom(
		reader,
		parent.payloadOffset,
		parent.payloadSize,
		mp4AtomMeta,
	)
	if err != nil || !ok {
		return "", false, err
	}
	if meta.payloadSize < 4 {
		return "", false, nil
	}
	// meta is a FullBox. Its four-byte version/flags prefix is not an atom.
	ilst, ok, err := findMP4Atom(
		reader,
		meta.payloadOffset+4,
		meta.payloadSize-4,
		mp4AtomIlst,
	)
	if err != nil || !ok {
		return "", false, err
	}
	artistAtom, ok, err := findMP4Atom(
		reader,
		ilst.payloadOffset,
		ilst.payloadSize,
		mp4AtomArtist,
	)
	if err != nil || !ok {
		return "", false, err
	}
	dataAtom, ok, err := findMP4Atom(
		reader,
		artistAtom.payloadOffset,
		artistAtom.payloadSize,
		mp4AtomData,
	)
	if err != nil || !ok || dataAtom.payloadSize <= 8 {
		return "", false, err
	}
	valueSize := dataAtom.payloadSize - 8 // type/flags + locale
	if valueSize > maxM4AMetadataValueBytes {
		return "", false, errors.New("m4a artist metadata is too large")
	}
	value := make([]byte, int(valueSize))
	if _, err := reader.ReadAt(value, dataAtom.payloadOffset+8); err != nil {
		return "", false, err
	}
	if !utf8.Valid(value) {
		return "", false, errors.New("m4a artist metadata is not UTF-8")
	}
	artist := strings.Trim(string(value), "\x00 \t\r\n")
	return artist, artist != "", nil
}

func findMP4Atom(
	reader io.ReaderAt,
	start int64,
	length int64,
	target [4]byte,
) (mp4Atom, bool, error) {
	if start < 0 || length < 0 || start > int64(^uint64(0)>>1)-length {
		return mp4Atom{}, false, errors.New("invalid MP4 atom bounds")
	}
	end := start + length
	for offset := start; offset+8 <= end; {
		header := make([]byte, 16)
		if _, err := reader.ReadAt(header[:8], offset); err != nil {
			return mp4Atom{}, false, err
		}
		size := int64(binary.BigEndian.Uint32(header[:4]))
		headerSize := int64(8)
		if size == 1 {
			if offset+16 > end {
				return mp4Atom{}, false, errors.New("truncated extended MP4 atom")
			}
			if _, err := reader.ReadAt(header[8:16], offset+8); err != nil {
				return mp4Atom{}, false, err
			}
			extended := binary.BigEndian.Uint64(header[8:16])
			if extended > uint64(^uint64(0)>>1) {
				return mp4Atom{}, false, errors.New("MP4 atom size overflows int64")
			}
			size = int64(extended)
			headerSize = 16
		} else if size == 0 {
			size = end - offset
		}
		if size < headerSize || size > end-offset {
			return mp4Atom{}, false, fmt.Errorf("invalid MP4 atom size %d", size)
		}
		if [4]byte(header[4:8]) == target {
			return mp4Atom{
				payloadOffset: offset + headerSize,
				payloadSize:   size - headerSize,
			}, true, nil
		}
		offset += size
	}
	return mp4Atom{}, false, nil
}
