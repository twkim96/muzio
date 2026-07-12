package mediapath

import "testing"

func TestEncodeIDIsStable(t *testing.T) {
	a := EncodeID("movies", "Inception/Inception.mkv")
	b := EncodeID("movies", "Inception/Inception.mkv")
	if a != b {
		t.Fatalf("EncodeID not stable: %q vs %q", a, b)
	}
	if len(a) != 16 {
		t.Fatalf("EncodeID length = %d, want 16", len(a))
	}
}

func TestEncodeIDNormalizesEquivalentPaths(t *testing.T) {
	a := EncodeID("movies", "Inception/Inception.mkv")
	b := EncodeID("movies", "Inception/./Inception.mkv")
	c := EncodeID("movies", "Inception/sub/../Inception.mkv")
	if a != b || a != c {
		t.Fatalf("equivalent paths produced different IDs: %q %q %q", a, b, c)
	}
}

func TestEncodeIDDiffersByRoot(t *testing.T) {
	a := EncodeID("movies", "song.mp3")
	b := EncodeID("music", "song.mp3")
	if a == b {
		t.Fatalf("IDs should differ across roots, got %q for both", a)
	}
}

func TestEncodeIDDiffersByPath(t *testing.T) {
	a := EncodeID("movies", "a.mp4")
	b := EncodeID("movies", "b.mp4")
	if a == b {
		t.Fatalf("IDs should differ across paths, got %q for both", a)
	}
}
