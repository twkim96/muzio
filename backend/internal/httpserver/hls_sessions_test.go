package httpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testHLSRegistry(t *testing.T) (*hlsSessions, *time.Time) {
	now := time.Now()
	s := newHLSSessions()
	s.timer.Stop()
	s.timer = nil
	s.root = t.TempDir()
	s.now = func() time.Time { return now }
	t.Cleanup(func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.timer != nil {
			s.timer.Stop()
		}
		for _, row := range s.rows {
			row.cache.close()
		}
	})
	return s, &now
}
func hlsRequest(s *hlsSessions, method, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(method, "http://muzio.test/api/hls-sessions", strings.NewReader(body)))
	s.mu.Lock()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	s.mu.Unlock()
	return w
}
func commandHLS(s *hlsSessions, action, id, raw string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"action": action, "id": id, "url": raw, "title": "Stream"})
	return hlsRequest(s, "POST", string(body))
}
func registerHLS(t *testing.T, s *hlsSessions, raw string) *hlsSession {
	t.Helper()
	w := commandHLS(s, "register", "", raw)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var result struct{ ID string }
	if json.Unmarshal(w.Body.Bytes(), &result) != nil {
		t.Fatal(w.Body.String())
	}
	return s.rows[result.ID]
}
func maintainHLS(s *hlsSessions) {
	s.maintain()
	s.mu.Lock()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	s.mu.Unlock()
}
func TestHLSViewersShareOneStreamAndSignedQueriesRemainDistinct(t *testing.T) {
	s, _ := testHLSRegistry(t)
	a := registerHLS(t, s, "https://example.com/live?sig=a%2Bb#one")
	b := registerHLS(t, s, "https://example.com/live?sig=a%2Bb#two")
	other := registerHLS(t, s, "https://example.com/live?sig=other")
	if a != b || a.PlaybackURL != b.PlaybackURL || a.cache != b.cache {
		t.Fatal("same HLS created multiple caches")
	}
	if other == a || len(s.rows) != 2 {
		t.Fatal("different signed HLS merged")
	}
	// Old page-exit messages cannot delete a shared recording.
	if w := commandHLS(s, "close", a.ID, ""); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if len(s.rows) != 2 {
		t.Fatal("one viewer's exit removed shared recording")
	}
}
func TestHLSConcurrentRegistrationsCreateOnlyOneRecorder(t *testing.T) {
	s, _ := testHLSRegistry(t)
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := commandHLS(s, "register", "", "https://example.com/live")
			if w.Code != 200 {
				t.Error(w.Code)
			}
		}()
	}
	wg.Wait()
	if len(s.rows) != 1 {
		t.Fatal("concurrent viewers created duplicate recordings", len(s.rows))
	}
	entries, _ := os.ReadDir(s.root)
	if len(entries) != 1 {
		t.Fatal("duplicate disk directories", len(entries))
	}
}
func TestHLSViewerGraceKeepsRecordingAndRejoinsBeforeExpiry(t *testing.T) {
	s, now := testHLSRegistry(t)
	row := registerHLS(t, s, "https://example.com/live")
	row.polling = true // isolate the lease from asynchronous source I/O
	*now = now.Add(29 * time.Minute)
	maintainHLS(s)
	if len(s.rows) != 1 || row.cache.stopped {
		t.Fatal("brief viewer absence stopped recording")
	}
	again := registerHLS(t, s, row.URL)
	if row != again {
		t.Fatal("returning viewer lost cached session")
	}
	*now = now.Add(29 * time.Minute)
	if w := commandHLS(s, "heartbeat", row.ID, ""); w.Code != 204 {
		t.Fatal(w.Code)
	}
	*now = now.Add(29 * time.Minute)
	maintainHLS(s)
	if s.rows[row.ID] == nil {
		t.Fatal("another viewer heartbeat was ignored")
	}
	*now = now.Add(time.Minute)
	maintainHLS(s)
	if len(s.rows) != 0 {
		t.Fatal("30 min absent viewer retained")
	}
	if _, err := os.Stat(row.cache.dir); !os.IsNotExist(err) {
		t.Fatal("expired files retained")
	}
	fresh := registerHLS(t, s, row.URL)
	if fresh.ID == row.ID {
		t.Fatal("expired identity reused")
	}
}
func TestHLSViewerMediaRequestsRenewButListingAndRecorderDoNot(t *testing.T) {
	s, now := testHLSRegistry(t)
	row := registerHLS(t, s, "https://example.com/live")
	row.cache.masters[row.cache.root] = "#EXTM3U\n"
	row.polling = true
	*now = now.Add(29 * time.Minute)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "http://muzio.test"+row.PlaybackURL, nil))
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	if !row.touched.Equal(*now) {
		t.Fatal("viewer GET did not renew")
	}
	touched := row.touched
	*now = now.Add(time.Minute)
	hlsRequest(s, "GET", "")
	maintainHLS(s)
	if !row.touched.Equal(touched) {
		t.Fatal("server work or discovery renewed viewer lease")
	}
	*now = now.Add(29 * time.Minute)
	maintainHLS(s)
	if len(s.rows) != 0 {
		t.Fatal("server kept itself alive")
	}
}
func TestHLSEndedAndUnknownRecordingsKeepBytesWhileViewed(t *testing.T) {
	s, now := testHLSRegistry(t)
	row := registerHLS(t, s, "https://example.com/ended")
	row.cache.state = "ended"
	row.cache.confirmed = now.Add(-4 * time.Hour)
	row.polling = true
	*now = now.Add(29 * time.Minute)
	commandHLS(s, "heartbeat", row.ID, "")
	maintainHLS(s)
	if row.cache.state != "ended" || s.rows[row.ID] == nil {
		t.Fatal("broadcast ending deleted history")
	}
	other := registerHLS(t, s, "https://example.com/unknown")
	other.cache.confirmed = now.Add(-31 * time.Minute)
	other.polling = true
	maintainHLS(s)
	if !other.cache.stopped || s.rows[other.ID] == nil {
		t.Fatal("unknown source should stop capture but retain viewed bytes")
	}
}
func TestHLSSessionsRejectCrossOriginAndInvalidInput(t *testing.T) {
	s, _ := testHLSRegistry(t)
	for _, raw := range []string{"file:///tmp/a", "https://u:p@example.com/a"} {
		if w := commandHLS(s, "register", "", raw); w.Code != 400 {
			t.Fatal(w.Code)
		}
	}
	r := httptest.NewRequest("POST", "http://muzio.test/api/hls-sessions", strings.NewReader(`{}`))
	r.Header.Set("Origin", "https://evil.test")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}
func TestHLSStatusProbeRejectsPrivateDestination(t *testing.T) {
	origin := httptest.NewServer(nil)
	defer origin.Close()
	state, _ := probeHLSStatus(context.Background(), origin.URL)
	if state != "unknown" {
		t.Fatal(state)
	}
}

func TestHLSStatusReadsOnlyManifestsAndRecognizesEnd(t *testing.T) {
	var ended atomic.Bool
	var mediaRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/master.m3u8":
			_, _ = w.Write([]byte("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nmedia.m3u8?token=a%2Bb\n"))
		case "/media.m3u8":
			if r.URL.RawQuery != "token=a%2Bb" {
				t.Error("signed query changed")
			}
			text := "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:6,\nseg.ts\n"
			if ended.Load() {
				text += "#EXT-X-ENDLIST\n"
			}
			_, _ = w.Write([]byte(text))
		default:
			mediaRequests.Add(1)
			w.WriteHeader(500)
		}
	}))
	defer server.Close()
	state, hash := probeHLSWithClient(context.Background(), server.URL+"/master.m3u8", server.Client())
	if state != "live" || hash == "" {
		t.Fatal(state, hash)
	}
	ended.Store(true)
	state, _ = probeHLSWithClient(context.Background(), server.URL+"/master.m3u8", server.Client())
	if state != "ended" || mediaRequests.Load() != 0 {
		t.Fatal(state, mediaRequests.Load())
	}
}
func TestHLSStatusBlocksNonPublicNetworks(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "100.100.100.200", "::1", "::ffff:192.168.1.1", "64:ff9b::a00:1"} {
		if publicHLSAddress(net.ParseIP(address)) {
			t.Fatal(address)
		}
	}
	if !publicHLSAddress(net.ParseIP("8.8.8.8")) {
		t.Fatal("public address rejected")
	}
}

func TestHLSAbandonedInstanceCleanupPreservesFreshServer(t *testing.T) {
	s, _ := testHLSRegistry(t)
	base := t.TempDir()
	for _, name := range []string{"instance-old", "instance-fresh"} {
		path := filepath.Join(base, name)
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "lease"), []byte("active"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-31 * time.Minute)
	if err := os.Chtimes(filepath.Join(base, "instance-old", "lease"), old, old); err != nil {
		t.Fatal(err)
	}
	s.sweepAbandoned(base)
	if _, err := os.Stat(filepath.Join(base, "instance-old")); !os.IsNotExist(err) {
		t.Fatal("crashed instance retained")
	}
	if _, err := os.Stat(filepath.Join(base, "instance-fresh")); err != nil {
		t.Fatal("another running server deleted")
	}
}

func TestHLSSharedViewersFetchEachSegmentOnlyOnce(t *testing.T) {
	var requests atomic.Int32
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/live.m3u8" {
			fmt.Fprint(w, "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n")
			return
		}
		requests.Add(1)
		fmt.Fprint(w, "saved video")
	}))
	defer origin.Close()
	s, _ := testHLSRegistry(t)
	s.clientFactory = origin.Client
	a, b := registerHLS(t, s, origin.URL+"/live.m3u8"), registerHLS(t, s, origin.URL+"/live.m3u8")
	for _, row := range []*hlsSession{a, b} {
		manifest := httptest.NewRecorder()
		s.ServeHTTP(manifest, httptest.NewRequest("GET", "http://muzio.test"+row.PlaybackURL, nil))
		if manifest.Code != 200 {
			t.Fatal(manifest.Code)
		}
		for _, line := range strings.Split(manifest.Body.String(), "\n") {
			if strings.HasPrefix(line, "/api/hls-cache/") {
				segment := httptest.NewRecorder()
				s.ServeHTTP(segment, httptest.NewRequest("GET", "http://muzio.test"+line, nil))
				if segment.Body.String() != "saved video" {
					t.Fatal(segment.Code, segment.Body.String())
				}
			}
		}
	}
	if requests.Load() != 1 || a.cache.bytes != int64(len("saved video")) {
		t.Fatal("shared viewers duplicated origin/disk bytes", requests.Load(), a.cache.bytes)
	}
}

func TestHLSRecorderContinuesDuringViewerAbsenceWithoutRenewingItself(t *testing.T) {
	var sn atomic.Int64
	sn.Store(1)
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/live" {
			fmt.Fprintf(w, "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:%d\n#EXTINF:2,\nseg%d.ts\n", sn.Load(), sn.Load())
			return
		}
		fmt.Fprint(w, r.URL.Path)
	}))
	defer origin.Close()
	s, now := testHLSRegistry(t)
	s.clientFactory = origin.Client
	row := registerHLS(t, s, origin.URL+"/live")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "http://muzio.test"+row.PlaybackURL, nil))
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	touched := row.touched
	sn.Store(2)
	row.cache.mu.Lock()
	row.cache.playlists[row.cache.root].updated = time.Now().Add(-time.Minute)
	row.cache.mu.Unlock()
	*now = now.Add(10 * time.Minute)
	maintainHLS(s)
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.mu.Lock()
		done := !row.polling
		s.mu.Unlock()
		if done {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("recording stopped after viewer left")
		}
		time.Sleep(time.Millisecond)
	}
	row.cache.mu.Lock()
	saved := len(row.cache.playlists[row.cache.root].segments)
	row.cache.mu.Unlock()
	if saved != 2 || !row.touched.Equal(touched) {
		t.Fatal("background capture lost bytes or renewed its own lease", saved)
	}
	*now = now.Add(20 * time.Minute)
	maintainHLS(s)
	if s.rows[row.ID] != nil {
		t.Fatal("absent viewer recording never expired")
	}
}

func TestHLSManualDeletionIsImmediateIsolatedAndDoesNotResurrect(t *testing.T) {
	s, _ := testHLSRegistry(t)
	a := registerHLS(t, s, "https://example.com/a")
	b := registerHLS(t, s, "https://example.com/b")
	if w := commandHLS(s, "delete", a.ID, ""); w.Code != 204 {
		t.Fatal(w.Code)
	}
	if _, err := os.Stat(a.cache.dir); !os.IsNotExist(err) {
		t.Fatal("deleted bytes remain")
	}
	if _, err := os.Stat(b.cache.dir); err != nil {
		t.Fatal("other HLS deleted")
	}
	if w := commandHLS(s, "heartbeat", a.ID, ""); w.Code != 410 {
		t.Fatal("viewer resurrected deleted session")
	}
	if w := commandHLS(s, "delete", a.ID, ""); w.Code != 204 {
		t.Fatal("delete not idempotent")
	}
	fresh := registerHLS(t, s, a.URL)
	if fresh.ID == a.ID {
		t.Fatal("new playback reused deleted session")
	}
}
func TestHLSOrphanSweepKeepsActiveSessionAndUnrelatedFiles(t *testing.T) {
	s, _ := testHLSRegistry(t)
	active := registerHLS(t, s, "https://example.com/live")
	orphan := filepath.Join(s.root, strings.Repeat("a", 48))
	if err := os.Mkdir(orphan, 0700); err != nil {
		t.Fatal(err)
	}
	unrelated := filepath.Join(s.root, "unrelated")
	if err := os.Mkdir(unrelated, 0700); err != nil {
		t.Fatal(err)
	}
	s.sweepOrphansLocked()
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Fatal("orphan retained")
	}
	for _, path := range []string{active.cache.dir, unrelated} {
		if _, err := os.Stat(path); err != nil {
			t.Fatal("valid directory removed", err)
		}
	}
}

func TestHLSListShowsLastViewerSignalWithoutRefreshingIt(t *testing.T) {
	s, now := testHLSRegistry(t)
	row := registerHLS(t, s, "https://example.com/live")
	initial := row.touched.UnixMilli()
	*now = now.Add(time.Minute)
	read := func() int64 {
		t.Helper()
		w := hlsRequest(s, "GET", "")
		var list struct{ Items []hlsSession }
		if json.Unmarshal(w.Body.Bytes(), &list) != nil || len(list.Items) != 1 {
			t.Fatal(w.Body.String())
		}
		return list.Items[0].LastSeenAt
	}
	if read() != initial {
		t.Fatal("listing changed last viewer timestamp")
	}
	if commandHLS(s, "heartbeat", row.ID, "").Code != 204 {
		t.Fatal("heartbeat failed")
	}
	if read() != now.UnixMilli() {
		t.Fatal("last acknowledgement timestamp missing")
	}
}
