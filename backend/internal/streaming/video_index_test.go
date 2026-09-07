package streaming

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"muzio/backend/internal/library"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func indexAtom(kind string, payload []byte) []byte {
	data := make([]byte, 8+len(payload))
	binary.BigEndian.PutUint32(data, uint32(len(data)))
	copy(data[4:8], kind)
	copy(data[8:], payload)
	return data
}
func TestVideoIndexPrefixAndRevision(t *testing.T) {
	prefix := append(indexAtom("ftyp", []byte("isom0000")), indexAtom("moov", indexAtom("mvhd", make([]byte, 100)))...)
	body := append(append([]byte{}, prefix...), indexAtom("mdat", []byte("media payload"))...)
	roots, media := newFixture(t, string(body), "video.mp4")
	media.Type = library.MediaTypeVideo
	handler := Handler(roots, fakeLookup{media: media}, discardLogger())
	request := func(query, rangeValue string) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/api/media/fixture-id"+query, nil)
		if rangeValue != "" {
			req.Header.Set("Range", rangeValue)
		}
		handler(rec, req)
		return rec
	}
	rec := request("?index=manifest", "")
	var manifest videoIndexManifest
	if err := json.Unmarshal(rec.Body.Bytes(), &manifest); err != nil {
		t.Fatal(err)
	}
	if rec.Code != 200 || !manifest.Eligible || manifest.IndexBytes != int64(len(prefix)) || manifest.FileSize != int64(len(body)) || len(manifest.Revision) != 64 || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("manifest: %+v, response %v", manifest, rec)
	}
	if _, err := http.ParseTime(manifest.ModifiedAt); err != nil {
		t.Fatal(err)
	}
	rec = request("?index=data&revision="+manifest.Revision, "bytes=0-1")
	if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), prefix) || rec.Header().Get("Content-Length") == "" {
		t.Fatalf("prefix response: %v", rec)
	}
	rec = request("?index_revision="+manifest.Revision, "bytes=2-7")
	if rec.Code != 206 || !bytes.Equal(rec.Body.Bytes(), body[2:8]) || rec.Header().Get("X-Muzio-Revision") != manifest.Revision {
		t.Fatalf("range: %v", rec)
	}
	for _, query := range []string{"?index=data&revision=stale", "?index_revision=stale"} {
		if got := request(query, "bytes=2-7"); got.Code != 409 {
			t.Fatalf("stale: %v", got)
		}
	}
	path, err := roots.ResolveStrict(media.RootName, media.RelativePath)
	if err != nil {
		t.Fatal(err)
	}
	changed := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(path, changed, changed); err != nil {
		t.Fatal(err)
	}
	if got := request("?index=data&revision="+manifest.Revision, ""); got.Code != 409 {
		t.Fatalf("changed: %v", got)
	}
}
func TestVideoIndexUnsupportedAndOversize(t *testing.T) {
	for _, tc := range []struct {
		name string
		body []byte
		size int64
	}{
		{"invalid.mp4", []byte("not mp4"), 0},
		{"end.mov", append(indexAtom("mdat", nil), indexAtom("moov", nil)...), 0},
		{"fragmented.mp4", append(append(indexAtom("moov", nil), indexAtom("moof", nil)...), indexAtom("mdat", nil)...), 0},
		{"other.mkv", append(indexAtom("moov", nil), indexAtom("mdat", nil)...), 0},
		{"oversize.mp4", nil, maxVideoIndexBytes + 24},
		{"headers.mp4", bytes.Repeat(indexAtom("free", nil), 4097), 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			roots, media := newFixture(t, string(tc.body), tc.name)
			media.Type = library.MediaTypeVideo
			if tc.size > 0 {
				path, _ := roots.ResolveStrict(media.RootName, media.RelativePath)
				f, err := os.OpenFile(path, os.O_RDWR, 0600)
				if err != nil {
					t.Fatal(err)
				}
				defer f.Close()
				if err = f.Truncate(tc.size); err != nil {
					t.Fatal(err)
				}
				header := indexAtom("moov", nil)
				binary.BigEndian.PutUint32(header, uint32(maxVideoIndexBytes+16))
				if _, err = f.WriteAt(header, 0); err != nil {
					t.Fatal(err)
				}
				if _, err = f.WriteAt(indexAtom("mdat", nil), maxVideoIndexBytes+16); err != nil {
					t.Fatal(err)
				}
			}
			rec := httptest.NewRecorder()
			Handler(roots, fakeLookup{media: media}, discardLogger())(rec, httptest.NewRequest("GET", "/api/media/fixture-id?index=manifest", nil))
			var manifest videoIndexManifest
			if err := json.Unmarshal(rec.Body.Bytes(), &manifest); err != nil {
				t.Fatal(err)
			}
			if rec.Code != 200 || manifest.Eligible || manifest.IndexBytes != 0 {
				t.Fatalf("unsupported: %+v %d", manifest, rec.Code)
			}
		})
	}
}
