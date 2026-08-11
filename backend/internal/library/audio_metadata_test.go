package library

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

func TestEnrichMetadataFromID3v2AndFLAC(t *testing.T) {
	tests := []struct {
		name  string
		ext   string
		write func(*testing.T, string)
	}{
		{"mp3", ".mp3", writeTestID3v2},
		{"flac", ".flac", writeTestFLAC},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "fallback"+test.ext)
			test.write(t, path)
			got := EnrichMetadataFromFile(path, MediaTypeAudio, Metadata{Title: "fallback"})
			if got.Title != "Tagged title" || got.Artist != "Tagged artist" || got.Album != "Tagged album" || got.Year != 2026 {
				t.Fatalf("metadata = %#v", got)
			}
		})
	}
}

func TestAudioMetadataCorruptAndOversizedKeepFallback(t *testing.T) {
	dir := t.TempDir()
	corrupt := filepath.Join(dir, "broken.flac")
	if err := os.WriteFile(corrupt, []byte("fLaC\x04\xff\xff\xff"), 0o600); err != nil {
		t.Fatal(err)
	}
	oversized := filepath.Join(dir, "large.mp3")
	header := []byte{'I', 'D', '3', 3, 0, 0, 0x02, 0, 0, 1}
	if err := os.WriteFile(oversized, header, 0o600); err != nil {
		t.Fatal(err)
	}
	fallback := Metadata{Title: "fallback", Artist: "artist"}
	for _, path := range []string{corrupt, oversized} {
		if got := EnrichMetadataFromFile(path, MediaTypeAudio, fallback); got != fallback {
			t.Fatalf("%s metadata = %#v, want fallback", path, got)
		}
	}
}

func writeTestID3v2(t *testing.T, path string) {
	t.Helper()
	var frames []byte
	for _, entry := range []struct{ id, value string }{
		{"TIT2", "Tagged title"}, {"TPE1", "Tagged artist"},
		{"TALB", "Tagged album"}, {"TDRC", "2026-08-11"},
	} {
		payload := append([]byte{3}, []byte(entry.value)...)
		frame := make([]byte, 10+len(payload))
		copy(frame[:4], entry.id)
		binary.BigEndian.PutUint32(frame[4:8], uint32(len(payload)))
		copy(frame[10:], payload)
		frames = append(frames, frame...)
	}
	header := []byte{'I', 'D', '3', 3, 0, 0, byte(len(frames) >> 21), byte(len(frames)>>14) & 0x7f, byte(len(frames)>>7) & 0x7f, byte(len(frames)) & 0x7f}
	if err := os.WriteFile(path, append(header, frames...), 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeTestFLAC(t *testing.T, path string) {
	t.Helper()
	var comments bytes.Buffer
	writeLEString := func(value string) {
		_ = binary.Write(&comments, binary.LittleEndian, uint32(len(value)))
		comments.WriteString(value)
	}
	writeLEString("Muzio")
	values := []string{"TITLE=Tagged title", "ARTIST=Tagged artist", "ALBUM=Tagged album", "DATE=2026-08-11"}
	_ = binary.Write(&comments, binary.LittleEndian, uint32(len(values)))
	for _, value := range values {
		writeLEString(value)
	}
	payload := comments.Bytes()
	header := []byte{0x84, byte(len(payload) >> 16), byte(len(payload) >> 8), byte(len(payload))}
	data := append([]byte("fLaC"), header...)
	data = append(data, payload...)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}
