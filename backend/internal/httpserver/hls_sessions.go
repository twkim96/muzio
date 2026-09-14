package httpserver

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const hlsUnknownTTL = 20 * time.Minute
const hlsViewerGrace = 20 * time.Minute

type hlsSession struct {
	ID           string `json:"id"`
	URL          string `json:"url"`
	Title        string `json:"title"`
	State        string `json:"state"`
	PlaybackURL  string `json:"playbackUrl"`
	ThumbnailURL string `json:"thumbnailUrl,omitempty"`
	LastSeenAt   int64  `json:"lastSeenAt"`
	Bytes        int64  `json:"bytes"`
	touched      time.Time
	cache        *hlsCache
	polling      bool
}
type hlsSessions struct {
	mu            sync.Mutex
	timer         *time.Timer
	rows          map[string]*hlsSession
	urls          map[string]string
	now           func() time.Time
	root          string
	clientFactory func() *http.Client
	lastSweep     time.Time
}

func newHLSSessions() *hlsSessions {
	s := &hlsSessions{rows: map[string]*hlsSession{}, urls: map[string]string{}, now: time.Now, clientFactory: hlsStatusClient}
	s.scheduleLocked()
	return s
}
func hlsRandom() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func (s *hlsSessions) ensureRoot() error {
	if s.root != "" {
		return nil
	}
	base, err := os.UserCacheDir()
	if err != nil {
		return err
	}
	base = filepath.Join(base, "muzio", "hls-server-v1")
	if err = os.MkdirAll(base, 0700); err != nil {
		return err
	}
	// Each server instance has its own lease directory. Never remove a fresh
	// instance belonging to another running Muzio process.
	s.sweepAbandoned(base)
	s.root, err = os.MkdirTemp(base, "instance-")
	return err
}
func (s *hlsSessions) sweepAbandoned(base string) {
	entries, _ := os.ReadDir(base)
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "instance-") {
			continue
		}
		path := filepath.Join(base, entry.Name())
		if path == s.root {
			continue
		}
		info, err := os.Stat(filepath.Join(path, "lease"))
		if err != nil {
			info, err = entry.Info()
		}
		if err == nil && time.Since(info.ModTime()) > hlsViewerGrace {
			_ = os.RemoveAll(path)
		}
	}
}

// A session belongs to one full HLS URL, not to a browser tab. Registrations
// are serialized so concurrent viewers share one directory and one recorder.
func (s *hlsSessions) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !musicSyncSameOrigin(r) {
		http.Error(w, "cross-origin session request", 403)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/hls-cache/") {
		s.serveCache(w, r)
		return
	}
	if r.Method != "GET" && r.Method != "POST" {
		w.WriteHeader(405)
		return
	}
	var input struct {
		Action string `json:"action"`
		ID     string `json:"id"`
		URL    string `json:"url"`
		Title  string `json:"title"`
	}
	if r.Method == "POST" {
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&input) != nil {
			w.WriteHeader(400)
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	if r.Method == "POST" {
		switch input.Action {
		case "register":
			raw, err := resolveHLS(input.URL, input.URL)
			if err != nil || len(input.URL) > 8192 || len(input.Title) > 800 {
				w.WriteHeader(400)
				return
			}
			row := s.rows[s.urls[raw]]
			if row == nil {
				if len(s.rows) >= 256 {
					w.WriteHeader(429)
					return
				}
				if s.ensureRoot() != nil {
					w.WriteHeader(507)
					return
				}
				access := hlsRandom()
				prefix := "/api/hls-cache/" + access + "/"
				cache, err := newHLSCache(filepath.Join(s.root, access), prefix, raw, s.clientFactory())
				if err != nil {
					w.WriteHeader(507)
					return
				}
				row = &hlsSession{ID: "temporary-hls:" + hlsRandom(), URL: raw, Title: input.Title, cache: cache, PlaybackURL: prefix + cache.root}
				s.rows[row.ID] = row
				s.urls[raw] = row.ID
			}
			row.touched = s.now()
			if s.timer != nil {
				s.timer.Stop()
				s.timer = nil
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"id": row.ID, "playbackUrl": row.PlaybackURL})
			s.scheduleLocked()
			return
		case "delete":
			if input.ID == "" {
				w.WriteHeader(400)
				return
			}
			if row := s.rows[input.ID]; row != nil {
				if err := s.deleteLocked(row); err != nil {
					http.Error(w, "HLS cache cleanup failed; retry deletion", 500)
					return
				}
			}
			w.WriteHeader(204)
			return
		case "heartbeat":
			row := s.rows[input.ID]
			if row == nil {
				w.WriteHeader(410)
				return
			}
			row.touched = s.now()
			w.WriteHeader(204)
			return
		default:
			// In particular, a viewer leaving must never close a shared recording.
			w.WriteHeader(400)
			return
		}
	}
	items := make([]hlsSession, 0, len(s.rows))
	for _, row := range s.rows {
		c := row.cache
		c.mu.Lock()
		state, size := c.state, c.bytes
		thumbnailURL := ""
		if len(c.thumbnail) > 0 {
			thumbnailURL = c.prefix + "thumbnail.jpg?v=" + strconv.FormatInt(c.thumbnailAt.UnixNano(), 10)
		}
		if (c.stopped || c.closed) && state != "ended" {
			state = "stopped"
		}
		c.mu.Unlock()
		items = append(items, hlsSession{ID: row.ID, URL: row.URL, Title: row.Title, State: state, PlaybackURL: row.PlaybackURL, Bytes: size, ThumbnailURL: thumbnailURL, LastSeenAt: row.touched.UnixMilli()})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Title == items[j].Title {
			return items[i].ID < items[j].ID
		}
		return items[i].Title < items[j].Title
	})
	s.scheduleLocked()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"items": items})
}
func (s *hlsSessions) deleteLocked(row *hlsSession) error {
	row.cache.close()
	// Keep failed cleanup visible so the user can retry it; maintenance retries too.
	if _, err := os.Stat(row.cache.dir); !os.IsNotExist(err) {
		if err != nil {
			return err
		}
		return errors.New("HLS directory still exists")
	}
	delete(s.rows, row.ID)
	delete(s.urls, row.URL)
	return nil
}

// A failed/aborted registration may leave a directory with no in-memory session.
// Sweep only this instance's opaque session directories, never active sessions.
func (s *hlsSessions) sweepOrphansLocked() {
	if s.root == "" {
		return
	}
	used := map[string]bool{}
	for _, row := range s.rows {
		used[filepath.Base(row.cache.dir)] = true
	}
	entries, _ := os.ReadDir(s.root)
	for _, entry := range entries {
		if !entry.IsDir() || used[entry.Name()] || len(entry.Name()) != 48 {
			continue
		}
		if _, err := hex.DecodeString(entry.Name()); err != nil {
			continue
		}
		_ = os.RemoveAll(filepath.Join(s.root, entry.Name()))
	}
}
func (s *hlsSessions) expireLocked() {
	for _, row := range s.rows {
		row.cache.mu.Lock()
		closed := row.cache.closed
		row.cache.mu.Unlock()
		if closed || s.now().Sub(row.touched) >= hlsViewerGrace {
			_ = s.deleteLocked(row)
		}
	}
}
func (s *hlsSessions) maintain() {
	s.mu.Lock()
	s.timer = nil
	now := s.now()
	s.expireLocked()
	var pending []*hlsSession
	for _, row := range s.rows {
		c := row.cache
		c.mu.Lock()
		if c.state != "ended" && now.Sub(c.confirmed) >= hlsUnknownTTL {
			c.stopped = true
			c.state = "stopped"
		}
		stopped := c.stopped || c.closed
		c.mu.Unlock()
		if !row.polling && !stopped {
			row.polling = true
			pending = append(pending, row)
		}
	}
	if time.Since(s.lastSweep) >= 30*time.Second {
		s.sweepOrphansLocked()
		if s.root != "" {
			_ = os.WriteFile(filepath.Join(s.root, "lease"), []byte("active"), 0600)
		}
		if base, err := os.UserCacheDir(); err == nil {
			s.sweepAbandoned(filepath.Join(base, "muzio", "hls-server-v1"))
		}
		s.lastSweep = time.Now()
	}
	s.scheduleLocked()
	s.mu.Unlock()
	for _, row := range pending {
		go func(row *hlsSession) { row.cache.poll(); s.mu.Lock(); row.polling = false; s.mu.Unlock() }(row)
	}
}
func (s *hlsSessions) scheduleLocked() {
	if s.timer == nil {
		delay := 30 * time.Second
		if len(s.rows) > 0 {
			delay = time.Second
		}
		s.timer = time.AfterFunc(delay, s.maintain)
	}
}
func (s *hlsSessions) serveCache(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" && !(r.Method == "PUT" && strings.HasSuffix(r.URL.Path, "/thumbnail.jpg")) {
		w.WriteHeader(405)
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/hls-cache/"), "/")
	if len(parts) != 2 {
		w.WriteHeader(404)
		return
	}
	s.mu.Lock()
	s.expireLocked()
	var c *hlsCache
	for _, row := range s.rows {
		if row.cache.prefix == "/api/hls-cache/"+parts[0]+"/" {
			c = row.cache
			// Only actual viewer GETs renew the shared lease. The recorder's
			// upstream polls never call this HTTP handler.
			c.mu.Lock()
			valid := c.resources[parts[1]] != nil
			c.mu.Unlock()
			if r.Method == "GET" && valid {
				row.touched = s.now()
			}
			break
		}
	}
	s.mu.Unlock()
	if c == nil {
		w.WriteHeader(410)
		return
	}
	if parts[1] == "thumbnail.jpg" {
		c.serveThumbnail(w, r)
		return
	}
	c.mu.Lock()
	resource := c.resources[parts[1]]
	c.mu.Unlock()
	if resource == nil {
		w.WriteHeader(404)
		return
	}
	var data []byte
	var err error
	if resource.manifest {
		data, err = c.manifest(resource.id, false)
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	} else {
		data, err = c.binary(resource.id)
		contentType := "application/octet-stream"
		switch strings.ToLower(filepath.Ext(resource.id)) {
		case ".ts":
			contentType = "video/mp2t"
		case ".m4s", ".mp4":
			contentType = "video/mp4"
		case ".aac":
			contentType = "audio/aac"
		case ".vtt", ".webvtt":
			contentType = "text/vtt"
		}
		w.Header().Set("Content-Type", contentType)
	}
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			w.WriteHeader(410)
		} else {
			http.Error(w, "HLS cache unavailable", 502)
		}
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	http.ServeContent(w, r, "resource", time.Time{}, bytes.NewReader(data))
}
