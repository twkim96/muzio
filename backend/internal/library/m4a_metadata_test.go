package library

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"

	"muzio/backend/internal/mediapath"
)

func TestEnrichMetadataFromFileUsesEmbeddedM4AArtist(t *testing.T) {
	path := filepath.Join(t.TempDir(), "010_guitar(260803).m4a")
	writeTestM4A(t, path, "010_guitar")

	metadata := EnrichMetadataFromFile(
		path,
		MediaTypeAudio,
		Metadata{Title: "010_guitar(260803)", Artist: "filename fallback"},
	)
	if metadata.Artist != "010_guitar" {
		t.Fatalf("Artist = %q, want embedded tag", metadata.Artist)
	}
	if metadata.Title != "010_guitar(260803)" {
		t.Fatalf("Title = %q, want unchanged fallback title", metadata.Title)
	}
}

func TestEnrichMetadataFromFileUsesM4ATitleAlbumAndYear(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tagged.m4a")
	var entries []byte
	for _, entry := range []struct {
		atom  [4]byte
		value string
	}{
		{mp4AtomTitle, "Tagged title"},
		{mp4AtomArtist, "Tagged artist"},
		{mp4AtomAlbum, "Tagged album"},
		{mp4AtomYear, "2026-08-11"},
	} {
		data := testMP4Atom(mp4AtomData, append(make([]byte, 8), []byte(entry.value)...))
		entries = append(entries, testMP4Atom(entry.atom, data)...)
	}
	ilst := testMP4Atom(mp4AtomIlst, entries)
	meta := testMP4Atom(mp4AtomMeta, append(make([]byte, 4), ilst...))
	moov := testMP4Atom(mp4AtomMoov, testMP4Atom(mp4AtomUdta, meta))
	if err := os.WriteFile(path, moov, 0o600); err != nil {
		t.Fatal(err)
	}
	got := EnrichMetadataFromFile(path, MediaTypeAudio, Metadata{Title: "fallback"})
	if got.Title != "Tagged title" || got.Artist != "Tagged artist" || got.Album != "Tagged album" || got.Year != 2026 {
		t.Fatalf("metadata = %#v", got)
	}
}

func TestScanPublishesEmbeddedM4AArtist(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "010_guitar(260803).m4a")
	writeTestM4A(t, path, "010_guitar")
	roots, err := mediapath.NewRoots([]string{dir})
	if err != nil {
		t.Fatal(err)
	}
	items, err := Scan(roots, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("len(items) = %d, want 1", len(items))
	}
	if items[0].Metadata.Artist != "010_guitar" {
		t.Fatalf("Artist = %q, want embedded tag", items[0].Metadata.Artist)
	}
}

func writeTestM4A(t *testing.T, path, artist string) {
	t.Helper()
	dataAtom := testMP4Atom(mp4AtomData, append(make([]byte, 8), []byte(artist)...))
	artistAtom := testMP4Atom(mp4AtomArtist, dataAtom)
	ilstAtom := testMP4Atom(mp4AtomIlst, artistAtom)
	metaAtom := testMP4Atom(mp4AtomMeta, append(make([]byte, 4), ilstAtom...))
	udtaAtom := testMP4Atom(mp4AtomUdta, metaAtom)
	moovAtom := testMP4Atom(mp4AtomMoov, udtaAtom)
	ftypAtom := testMP4Atom([4]byte{'f', 't', 'y', 'p'}, []byte("M4A \x00\x00\x00\x00"))
	if err := os.WriteFile(path, append(ftypAtom, moovAtom...), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestEnrichMetadataFromFileKeepsFallbackForMalformedOrUnrelatedFiles(t *testing.T) {
	dir := t.TempDir()
	m4aPath := filepath.Join(dir, "broken.m4a")
	if err := os.WriteFile(m4aPath, []byte("not-an-mp4"), 0o600); err != nil {
		t.Fatal(err)
	}
	fallback := Metadata{Title: "broken", Artist: "fallback"}
	if got := EnrichMetadataFromFile(m4aPath, MediaTypeAudio, fallback); got.Artist != fallback.Artist {
		t.Fatalf("malformed Artist = %q, want %q", got.Artist, fallback.Artist)
	}
	if got := EnrichMetadataFromFile(
		filepath.Join(dir, "song.mp3"),
		MediaTypeAudio,
		fallback,
	); got.Artist != fallback.Artist {
		t.Fatalf("MP3 Artist = %q, want %q", got.Artist, fallback.Artist)
	}
}

func testMP4Atom(atomType [4]byte, payload []byte) []byte {
	atom := make([]byte, 8+len(payload))
	binary.BigEndian.PutUint32(atom[:4], uint32(len(atom)))
	copy(atom[4:8], atomType[:])
	copy(atom[8:], payload)
	return atom
}
