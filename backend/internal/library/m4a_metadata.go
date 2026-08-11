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
	mp4AtomAlbum  = [4]byte{0xa9, 'a', 'l', 'b'}
	mp4AtomTitle  = [4]byte{0xa9, 'n', 'a', 'm'}
	mp4AtomYear   = [4]byte{0xa9, 'd', 'a', 'y'}
	mp4AtomData   = [4]byte{'d', 'a', 't', 'a'}
)

type mp4Atom struct {
	payloadOffset int64
	payloadSize   int64
}

// EnrichMetadataFromFile overlays bounded, container-native audio tags without
// spawning one ffprobe process per library item.
func EnrichMetadataFromFile(path string, mediaType MediaType, metadata Metadata) Metadata {
	if mediaType != MediaTypeAudio {
		return metadata
	}
	var fields audioTagFields
	var err error
	switch strings.ToLower(filepath.Ext(path)) {
	case ".m4a", ".mp4":
		fields, err = readM4ATags(path)
	case ".mp3":
		fields, err = readID3v2Tags(path)
	case ".flac":
		fields, err = readFLACTags(path)
	default:
		return metadata
	}
	if err != nil {
		return metadata
	}
	applyAudioTagFields(&metadata, fields)
	return metadata
}

func readM4AArtist(path string) (string, error) {
	fields, err := readM4ATags(path)
	return fields.Artist, err
}

func readM4ATags(path string) (audioTagFields, error) {
	file, err := os.Open(path)
	if err != nil {
		return audioTagFields{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return audioTagFields{}, err
	}
	moov, ok, err := findMP4Atom(file, 0, info.Size(), mp4AtomMoov)
	if err != nil || !ok {
		return audioTagFields{}, err
	}

	// iTunes-style metadata normally lives at moov/udta/meta/ilst. A few
	// writers place meta directly under moov, so accept that layout as well.
	if udta, found, findErr := findMP4Atom(
		file,
		moov.payloadOffset,
		moov.payloadSize,
		mp4AtomUdta,
	); findErr != nil {
		return audioTagFields{}, findErr
	} else if found {
		if fields, found, readErr := readTagsFromMetaParent(file, udta); readErr != nil || found {
			return fields, readErr
		}
	}
	fields, _, err := readTagsFromMetaParent(file, moov)
	return fields, err
}

func readTagsFromMetaParent(reader io.ReaderAt, parent mp4Atom) (audioTagFields, bool, error) {
	meta, ok, err := findMP4Atom(
		reader,
		parent.payloadOffset,
		parent.payloadSize,
		mp4AtomMeta,
	)
	if err != nil || !ok {
		return audioTagFields{}, false, err
	}
	if meta.payloadSize < 4 {
		return audioTagFields{}, false, nil
	}
	// meta is a FullBox. Its four-byte version/flags prefix is not an atom.
	ilst, ok, err := findMP4Atom(
		reader,
		meta.payloadOffset+4,
		meta.payloadSize-4,
		mp4AtomIlst,
	)
	if err != nil || !ok {
		return audioTagFields{}, false, err
	}
	fields := audioTagFields{}
	foundAny := false
	for _, tag := range []struct {
		atom [4]byte
		set  func(string)
	}{
		{mp4AtomTitle, func(value string) { fields.Title = value }},
		{mp4AtomArtist, func(value string) { fields.Artist = value }},
		{mp4AtomAlbum, func(value string) { fields.Album = value }},
		{mp4AtomYear, func(value string) { fields.Year = parseTagYear(value) }},
	} {
		value, found, readErr := readMP4TextTag(reader, ilst, tag.atom)
		if readErr != nil {
			return audioTagFields{}, false, readErr
		}
		if found {
			tag.set(value)
			foundAny = true
		}
	}
	return fields, foundAny, nil
}

func readMP4TextTag(reader io.ReaderAt, ilst mp4Atom, target [4]byte) (string, bool, error) {
	tagAtom, ok, err := findMP4Atom(reader, ilst.payloadOffset, ilst.payloadSize, target)
	if err != nil || !ok {
		return "", false, err
	}
	dataAtom, ok, err := findMP4Atom(
		reader,
		tagAtom.payloadOffset,
		tagAtom.payloadSize,
		mp4AtomData,
	)
	if err != nil || !ok || dataAtom.payloadSize <= 8 {
		return "", false, err
	}
	valueSize := dataAtom.payloadSize - 8 // type/flags + locale
	if valueSize > maxM4AMetadataValueBytes {
		return "", false, errors.New("m4a metadata value is too large")
	}
	value := make([]byte, int(valueSize))
	if _, err := reader.ReadAt(value, dataAtom.payloadOffset+8); err != nil {
		return "", false, err
	}
	if !utf8.Valid(value) {
		return "", false, errors.New("m4a metadata value is not UTF-8")
	}
	text := strings.Trim(string(value), "\x00 \t\r\n")
	return text, text != "", nil
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
