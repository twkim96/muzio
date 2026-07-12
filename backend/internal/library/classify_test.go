package library

import "testing"

func TestClassifyExtKnownTypes(t *testing.T) {
	cases := map[string]MediaType{
		"Inception.mkv": MediaTypeVideo,
		"trailer.MP4":   MediaTypeVideo,
		"clip.WebM":     MediaTypeVideo,
		"song.mp3":      MediaTypeAudio,
		"track.FLAC":    MediaTypeAudio,
		"audiobook.m4a": MediaTypeAudio,
		"sample.opus":   MediaTypeAudio,
		"image.jpg":     MediaTypeImage,
		"photo.WEBP":    MediaTypeImage,
		"cover.heic":    MediaTypeImage,
	}
	for name, want := range cases {
		got, ok := classifyExt(name)
		if !ok {
			t.Errorf("classifyExt(%q) ok = false, want true", name)
			continue
		}
		if got != want {
			t.Errorf("classifyExt(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestClassifyExtUnknownReturnsFalse(t *testing.T) {
	cases := []string{
		"notes.txt",
		"archive.zip",
		"README",
		".hiddenfile",
		"video.unknownext",
	}
	for _, name := range cases {
		if _, ok := classifyExt(name); ok {
			t.Errorf("classifyExt(%q) ok = true, want false", name)
		}
	}
}

func TestMIMEForKnownTypes(t *testing.T) {
	cases := map[string]string{
		"clip.mp4":   "video/mp4",
		"clip.MKV":   "video/x-matroska",
		"song.mp3":   "audio/mpeg",
		"track.FLAC": "audio/flac",
		"image.jpg":  "image/jpeg",
		"photo.WEBP": "image/webp",
	}
	for name, want := range cases {
		got, ok := MIMEFor(name)
		if !ok {
			t.Errorf("MIMEFor(%q) ok=false, want true", name)
			continue
		}
		if got != want {
			t.Errorf("MIMEFor(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestMIMEForUnknownReturnsFalse(t *testing.T) {
	if _, ok := MIMEFor("notes.txt"); ok {
		t.Fatal("MIMEFor(notes.txt) ok=true, want false")
	}
}
