package httpserver

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testCache(t *testing.T, origin *httptest.Server, path string) *hlsCache {
	t.Helper()
	c, err := newHLSCache(filepath.Join(t.TempDir(), "cache"), "/api/hls-cache/test/", origin.URL+path, origin.Client())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.close)
	return c
}
func TestHLSCacheHistoryHasNoTimeLimitAndReopensAfterOriginEnds(t *testing.T) {
	var sn atomic.Int64
	sn.Store(1)
	var ended, offline atomic.Bool
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if offline.Load() {
			w.WriteHeader(410)
			return
		}
		switch r.URL.Path {
		case "/master":
			fmt.Fprint(w, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10\nmedia?token=a%2Bb\n")
		case "/media":
			if r.URL.RawQuery != "token=a%2Bb" {
				t.Error("signed query changed")
			}
			fmt.Fprintf(w, "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:%d\n#EXTINF:6,\nseg%d\n", sn.Load(), sn.Load())
			if ended.Load() {
				fmt.Fprint(w, "#EXT-X-ENDLIST\n")
			}
		default:
			fmt.Fprint(w, r.URL.Path)
		}
	}))
	defer origin.Close()
	c := testCache(t, origin, "/master")
	master, err := c.manifest(c.root, false)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(master)), "\n")
	id := strings.TrimPrefix(lines[len(lines)-1], c.prefix)
	if _, err = c.manifest(id, true); err != nil {
		t.Fatal(err)
	}
	oldID := c.playlists[id].segments[0].resources[0]
	c.resources[oldID].at = time.Now().Add(-4 * time.Hour)
	sn.Store(2)
	c.playlists[id].updated = time.Now().Add(-time.Minute)
	c.playlists[id].touched = time.Now().Add(-time.Hour)
	c.poll() // Polling continues even when a paused player has not requested a playlist for an hour.
	if len(c.playlists[id].segments) != 2 {
		t.Fatal("paused tab stopped recording")
	}
	ended.Store(true)
	if _, err = c.manifest(id, true); err != nil {
		t.Fatal(err)
	}
	offline.Store(true)
	if _, err = c.manifest(c.root, false); err != nil {
		t.Fatal("ended master unavailable", err)
	}
	body, err := c.manifest(id, false)
	if err != nil || !strings.Contains(string(body), "#EXT-X-ENDLIST") || !strings.Contains(string(body), oldID) {
		t.Fatal("history missing after broadcast end", string(body), err)
	}
	bytes, err := c.binary(oldID)
	if err != nil || string(bytes) != "/seg1" {
		t.Fatal("old origin-free replay failed", string(bytes), err)
	}
}
func TestHLSCacheBudgetIsPerSessionAndEvictsOldestBytes(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "1234") }))
	defer origin.Close()
	a, b := testCache(t, origin, "/root"), testCache(t, origin, "/root")
	a.budget = 8
	b.budget = 8
	first := a.register(origin.URL+"/1", false, 0, 0, "")
	other := b.register(origin.URL+"/1", false, 0, 0, "")
	for _, pair := range []struct {
		c *hlsCache
		r *cachedHLSResource
	}{{a, first}, {b, other}} {
		if _, err := pair.c.binary(pair.r.id); err != nil {
			t.Fatal(err)
		}
	}
	first.at = time.Now().Add(-2 * time.Hour)
	for _, path := range []string{"/2", "/3"} {
		r := a.register(origin.URL+path, false, 0, 0, "")
		if _, err := a.binary(r.id); err != nil {
			t.Fatal(err)
		}
	}
	if a.bytes != 8 || b.bytes != 4 {
		t.Fatal(a.bytes, b.bytes)
	}
	if _, err := os.Stat(filepath.Join(a.dir, first.id)); !os.IsNotExist(err) {
		t.Fatal("oldest bytes retained")
	}
	if _, err := os.Stat(filepath.Join(b.dir, other.id)); err != nil {
		t.Fatal("other session evicted")
	}
}
func TestHLSCacheByteRangesMapsAndEncryptionIV(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/key" {
			fmt.Fprint(w, "0123456789abcdef")
			return
		}
		if r.URL.Path == "/bytes" {
			if r.Header.Get("Range") != "bytes=4-7" && r.Header.Get("Range") != "bytes=0-3" {
				t.Error(r.Header.Get("Range"))
			}
			w.WriteHeader(206)
			fmt.Fprint(w, "data")
			return
		}
		fmt.Fprint(w, "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:42\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXT-X-MAP:URI=\"bytes\",BYTERANGE=\"4@0\"\n#EXTINF:6,\n#EXT-X-BYTERANGE:4@4\nbytes\n")
	}))
	defer origin.Close()
	c := testCache(t, origin, "/media")
	out, err := c.manifest(c.root, true)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "BYTERANGE") || !strings.Contains(string(out), "IV=0x0000000000000000000000000000002a") {
		t.Fatal(string(out))
	}
	if c.bytes != 24 {
		t.Fatal("dependencies not retained", c.bytes)
	}
}
func TestHLSCloseCancelsWriterWithoutRecreatingDirectory(t *testing.T) {
	started := make(chan struct{})
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done() }))
	defer origin.Close()
	c := testCache(t, origin, "/root")
	r := c.register(origin.URL+"/segment", false, 0, 0, "")
	done := make(chan error, 1)
	go func() { _, err := c.binary(r.id); done <- err }()
	<-started
	c.close()
	if err := <-done; err == nil {
		t.Fatal("closed fetch succeeded")
	}
	if _, err := os.Stat(c.dir); !os.IsNotExist(err) {
		t.Fatal("late writer restored deleted files")
	}
}
func TestHLSStoppedCacheServesSavedBytesWithoutOriginRequests(t *testing.T) {
	var requests atomic.Int32
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1); fmt.Fprint(w, "data") }))
	defer origin.Close()
	c := testCache(t, origin, "/root")
	saved := c.register(origin.URL+"/saved", false, 0, 0, "")
	missing := c.register(origin.URL+"/missing", false, 0, 0, "")
	if _, err := c.binary(saved.id); err != nil {
		t.Fatal(err)
	}
	c.stop()
	if _, err := c.binary(saved.id); err != nil {
		t.Fatal(err)
	}
	if _, err := c.binary(missing.id); err == nil {
		t.Fatal("stopped session fetched origin")
	}
	if requests.Load() != 1 {
		t.Fatal(requests.Load())
	}
}

func TestHLSMissingNewSegmentDoesNotDeleteEarlierHistory(t *testing.T) {
	var sn atomic.Int64
	sn.Store(1)
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/media" {
			fmt.Fprintf(w, "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:%d\n#EXTINF:6,\nseg%d\n", sn.Load(), sn.Load())
			return
		}
		if r.URL.Path == "/seg2" {
			w.WriteHeader(410)
			return
		}
		fmt.Fprint(w, "saved")
	}))
	defer origin.Close()
	c := testCache(t, origin, "/media")
	first, err := c.manifest(c.root, true)
	if err != nil {
		t.Fatal(err)
	}
	sn.Store(2)
	second, err := c.manifest(c.root, true)
	if err != nil || string(second) != string(first) {
		t.Fatal("new fetch failure discarded saved history", string(first), string(second), err)
	}
}
func TestHLSSequenceResetPreservesHistoryWithLocalDiscontinuity(t *testing.T) {
	var sn atomic.Int64
	sn.Store(50)
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/media" {
			fmt.Fprintf(w, "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:%d\n#EXTINF:6,\nseg%d\n", sn.Load(), sn.Load())
			return
		}
		fmt.Fprint(w, r.URL.Path)
	}))
	defer origin.Close()
	c := testCache(t, origin, "/media")
	if _, err := c.manifest(c.root, true); err != nil {
		t.Fatal(err)
	}
	old := c.playlists[c.root].segments[0].resources[0]
	sn.Store(1)
	out, err := c.manifest(c.root, true)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), old) || !strings.Contains(string(out), "\n#EXT-X-DISCONTINUITY\n") {
		t.Fatal(string(out))
	}
	segments := c.playlists[c.root].segments
	if len(segments) != 2 || segments[1].sn != segments[0].sn+1 {
		t.Fatal(segments)
	}
}
