package library

import (
	"encoding/binary"
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const maxAudioTagBytes = 4 << 20

type audioTagFields struct {
	Title  string
	Artist string
	Album  string
	Year   int
}

func applyAudioTagFields(metadata *Metadata, fields audioTagFields) {
	if fields.Title != "" {
		metadata.Title = fields.Title
	}
	if fields.Artist != "" {
		metadata.Artist = fields.Artist
	}
	if fields.Album != "" {
		metadata.Album = fields.Album
	}
	if fields.Year != 0 {
		metadata.Year = fields.Year
	}
}

func parseTagYear(value string) int {
	value = strings.TrimSpace(value)
	if len(value) < 4 {
		return 0
	}
	year, err := strconv.Atoi(value[:4])
	if err != nil || year < 1000 || year > 9999 {
		return 0
	}
	return year
}

func readID3v2Tags(path string) (audioTagFields, error) {
	f, err := os.Open(path)
	if err != nil {
		return audioTagFields{}, err
	}
	defer f.Close()
	header := make([]byte, 10)
	if _, err := io.ReadFull(f, header); err != nil {
		return audioTagFields{}, err
	}
	if string(header[:3]) != "ID3" || header[3] < 2 || header[3] > 4 {
		return audioTagFields{}, errors.New("unsupported ID3 header")
	}
	size := syncsafe(header[6:10])
	if size < 0 || size > maxAudioTagBytes {
		return audioTagFields{}, errors.New("ID3 tag too large")
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(f, data); err != nil {
		return audioTagFields{}, err
	}
	fields := audioTagFields{}
	for offset := 0; offset+10 <= len(data); {
		id := string(data[offset : offset+4])
		if data[offset] == 0 {
			break
		}
		frameSize := int(binary.BigEndian.Uint32(data[offset+4 : offset+8]))
		if header[3] == 4 {
			frameSize = syncsafe(data[offset+4 : offset+8])
		}
		if frameSize <= 0 || offset+10+frameSize > len(data) {
			break
		}
		value := decodeID3Text(data[offset+10 : offset+10+frameSize])
		switch id {
		case "TIT2":
			fields.Title = value
		case "TPE1":
			fields.Artist = value
		case "TALB":
			fields.Album = value
		case "TDRC", "TYER":
			fields.Year = parseTagYear(value)
		}
		offset += 10 + frameSize
	}
	return fields, nil
}

func syncsafe(value []byte) int {
	if len(value) != 4 {
		return -1
	}
	for _, b := range value {
		if b&0x80 != 0 {
			return -1
		}
	}
	return int(value[0])<<21 | int(value[1])<<14 | int(value[2])<<7 | int(value[3])
}

func decodeID3Text(value []byte) string {
	if len(value) < 2 {
		return ""
	}
	encoding := value[0]
	payload := value[1:]
	if encoding == 0 || encoding == 3 {
		return strings.Trim(string(payload), "\x00 \t\r\n")
	}
	if encoding != 1 && encoding != 2 {
		return ""
	}
	little := encoding == 1 && len(payload) >= 2 && payload[0] == 0xff && payload[1] == 0xfe
	if len(payload) >= 2 && ((payload[0] == 0xff && payload[1] == 0xfe) || (payload[0] == 0xfe && payload[1] == 0xff)) {
		payload = payload[2:]
	}
	units := make([]uint16, 0, len(payload)/2)
	for i := 0; i+1 < len(payload); i += 2 {
		if little {
			units = append(units, binary.LittleEndian.Uint16(payload[i:i+2]))
		} else {
			units = append(units, binary.BigEndian.Uint16(payload[i:i+2]))
		}
	}
	return strings.Trim(string(utf16.Decode(units)), "\x00 \t\r\n")
}

func readFLACTags(path string) (audioTagFields, error) {
	f, err := os.Open(path)
	if err != nil {
		return audioTagFields{}, err
	}
	defer f.Close()
	magic := make([]byte, 4)
	if _, err := io.ReadFull(f, magic); err != nil || string(magic) != "fLaC" {
		return audioTagFields{}, errors.New("invalid FLAC")
	}
	for total := 0; total <= maxAudioTagBytes; {
		header := make([]byte, 4)
		if _, err := io.ReadFull(f, header); err != nil {
			return audioTagFields{}, err
		}
		last, blockType := header[0]&0x80 != 0, header[0]&0x7f
		size := int(header[1])<<16 | int(header[2])<<8 | int(header[3])
		total += size
		if total > maxAudioTagBytes {
			return audioTagFields{}, errors.New("FLAC metadata too large")
		}
		if blockType != 4 {
			if _, err := f.Seek(int64(size), io.SeekCurrent); err != nil {
				return audioTagFields{}, err
			}
		} else {
			data := make([]byte, size)
			if _, err := io.ReadFull(f, data); err != nil {
				return audioTagFields{}, err
			}
			return parseVorbisComment(data)
		}
		if last {
			break
		}
	}
	return audioTagFields{}, nil
}

func parseVorbisComment(data []byte) (audioTagFields, error) {
	offset := 0
	read := func() ([]byte, bool) {
		if offset+4 > len(data) {
			return nil, false
		}
		size := int(binary.LittleEndian.Uint32(data[offset : offset+4]))
		offset += 4
		if size < 0 || offset+size > len(data) {
			return nil, false
		}
		value := data[offset : offset+size]
		offset += size
		return value, true
	}
	if _, ok := read(); !ok {
		return audioTagFields{}, errors.New("invalid Vorbis vendor")
	}
	if offset+4 > len(data) {
		return audioTagFields{}, errors.New("invalid Vorbis comments")
	}
	count := int(binary.LittleEndian.Uint32(data[offset : offset+4]))
	offset += 4
	fields := audioTagFields{}
	for i := 0; i < count && i < 4096; i++ {
		value, ok := read()
		if !ok {
			return audioTagFields{}, errors.New("invalid Vorbis comment")
		}
		if !utf8.Valid(value) {
			continue
		}
		parts := strings.SplitN(string(value), "=", 2)
		if len(parts) != 2 {
			continue
		}
		switch strings.ToUpper(parts[0]) {
		case "TITLE":
			fields.Title = strings.TrimSpace(parts[1])
		case "ARTIST":
			fields.Artist = strings.TrimSpace(parts[1])
		case "ALBUM":
			fields.Album = strings.TrimSpace(parts[1])
		case "DATE", "YEAR":
			fields.Year = parseTagYear(parts[1])
		}
	}
	return fields, nil
}
