package httpserver

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const hlsCacheBudget int64 = 1536 << 20
const maxHLSResource int64 = 32 << 20

var hlsURI = regexp.MustCompile(`URI="([^"]+)"`)
var hlsMapRange = regexp.MustCompile(`,?BYTERANGE="([0-9]+)@([0-9]+)"`)

type cachedHLSResource struct {
	id, url    string
	manifest   bool
	dependency bool
	start, end int64
	size       int64
	at         time.Time
}
type cachedHLSSegment struct {
	sn, cc    int64
	duration  float64
	lines     []string
	resources []string
}
type cachedHLSPlaylist struct {
	segments         []cachedHLSSegment
	sequence         int64
	target           float64
	ended            bool
	vod              bool
	updated          time.Time
	touched          time.Time
	epoch            int
	offset, ccOffset int64
}
type hlsCache struct {
	mu                 sync.Mutex
	manifestMu         sync.Mutex
	ioMu               sync.Mutex
	dir, prefix, root  string
	resources          map[string]*cachedHLSResource
	playlists          map[string]*cachedHLSPlaylist
	masters            map[string]string
	masterDependencies map[string]bool
	bytes              int64
	budget             int64
	client             *http.Client
	ctx                context.Context
	cancel             context.CancelFunc
	closed             bool
	stopped            bool
	confirmed          time.Time
	state              string
	thumbnail          []byte
	thumbnailAt        time.Time
}

func newHLSCache(dir, prefix, raw string, client *http.Client) (*hlsCache, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &hlsCache{dir: dir, prefix: prefix, resources: map[string]*cachedHLSResource{}, playlists: map[string]*cachedHLSPlaylist{}, masters: map[string]string{}, masterDependencies: map[string]bool{}, budget: hlsCacheBudget, client: client, ctx: ctx, cancel: cancel, confirmed: time.Now(), state: "unknown"}
	c.root = c.register(raw, true, 0, 0, "").id
	return c, nil
}
func (c *hlsCache) register(raw string, manifest bool, start, end int64, identity string) *cachedHLSResource {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s\n%t/%d/%d/%s", raw, manifest, start, end, identity)))
	id := hex.EncodeToString(sum[:16])
	if manifest {
		id += ".m3u8"
	} else if parsed, err := url.Parse(raw); err == nil {
		// Preserve common media suffixes for native HLS demuxers while keeping the
		// origin path and signed query private behind the opaque resource id.
		switch ext := strings.ToLower(path.Ext(parsed.Path)); ext {
		case ".ts", ".m4s", ".mp4", ".aac", ".vtt", ".key", ".webvtt":
			id += ext
		}
	}
	if old := c.resources[id]; old != nil {
		return old
	}
	r := &cachedHLSResource{id: id, url: raw, manifest: manifest, start: start, end: end}
	c.resources[id] = r
	return r
}
func resolveHLS(raw, base string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	b, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	u = b.ResolveReference(u)
	if u.User != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return "", errors.New("unsupported HLS URL")
	}
	u.Fragment = ""
	return u.String(), nil
}
func (c *hlsCache) remote(r *cachedHLSResource, limit int64) ([]byte, string, error) {
	ctx, cancel := context.WithTimeout(c.ctx, 12*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.url, nil)
	if err != nil {
		return nil, "", err
	}
	if r.end > r.start {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", r.start, r.end-1))
	}
	response, err := c.client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 && response.StatusCode != 206 {
		return nil, "", errors.New("HLS origin unavailable")
	}
	if r.end > r.start && response.StatusCode != 206 {
		return nil, "", errors.New("HLS origin ignored byte range")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, "", errors.New("HLS resource exceeds cache limit")
	}
	return data, response.Request.URL.String(), nil
}

// Serialize disk writers within one session; cancellation still interrupts origin I/O.
func (c *hlsCache) binary(id string) ([]byte, error) {
	c.ioMu.Lock()
	defer c.ioMu.Unlock()
	c.mu.Lock()
	r := c.resources[id]
	closed := c.closed
	c.mu.Unlock()
	if closed || r == nil {
		return nil, errors.New("cache closed")
	}
	if data, err := os.ReadFile(filepath.Join(c.dir, id)); err == nil {
		return data, nil
	}
	c.mu.Lock()
	blocked := c.stopped
	c.mu.Unlock()
	if blocked {
		return nil, errors.New("capture stopped; resource not retained")
	}
	data, _, err := c.remote(r, maxHLSResource)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.resources[id] != r {
		return nil, errors.New("cache closed")
	}
	if int64(len(data)) > c.budget {
		return nil, errors.New("cache budget exceeded")
	}
	for c.bytes+int64(len(data)) > c.budget {
		var oldest *cachedHLSResource
		for _, entry := range c.resources {
			if entry.size > 0 && (oldest == nil || (oldest.dependency && !entry.dependency) || (oldest.dependency == entry.dependency && entry.at.Before(oldest.at))) {
				oldest = entry
			}
		}
		if oldest == nil {
			break
		}
		if err := c.removeBytes(oldest); err != nil {
			return nil, err
		}
	}
	if err := os.WriteFile(filepath.Join(c.dir, id), data, 0600); err != nil {
		return nil, err
	}
	r.size = int64(len(data))
	r.at = time.Now()
	c.bytes += r.size
	return data, nil
}
func (c *hlsCache) removeBytes(r *cachedHLSResource) error {
	err := os.Remove(filepath.Join(c.dir, r.id))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	c.bytes -= r.size
	r.size = 0
	return nil
}
func (c *hlsCache) media(text, base string, old *cachedHLSPlaylist) (*cachedHLSPlaylist, error) {
	lines := strings.Split(text, "\n")
	p := &cachedHLSPlaylist{target: 6, updated: time.Now(), touched: time.Now()}
	cc := int64(0)
	for _, l := range lines {
		l = strings.TrimSpace(l)
		switch {
		case strings.HasPrefix(l, "#EXT-X-MEDIA-SEQUENCE:"):
			p.sequence, _ = strconv.ParseInt(strings.TrimPrefix(l, "#EXT-X-MEDIA-SEQUENCE:"), 10, 64)
		case strings.HasPrefix(l, "#EXT-X-DISCONTINUITY-SEQUENCE:"):
			cc, _ = strconv.ParseInt(strings.TrimPrefix(l, "#EXT-X-DISCONTINUITY-SEQUENCE:"), 10, 64)
		case strings.HasPrefix(l, "#EXT-X-TARGETDURATION:"):
			p.target, _ = strconv.ParseFloat(strings.TrimPrefix(l, "#EXT-X-TARGETDURATION:"), 64)
		case l == "#EXT-X-ENDLIST":
			p.ended = true
		case strings.HasPrefix(l, "#EXT-X-SKIP:") || strings.HasPrefix(l, "#EXT-X-DEFINE:"):
			return nil, errors.New("delta HLS playlist not supported")
		}
	}
	if old != nil {
		p.epoch = old.epoch
		p.offset, p.ccOffset = old.offset, old.ccOffset
		last := old.segments[len(old.segments)-1]
		if p.sequence < old.sequence || p.sequence > last.sn-old.offset+1 {
			// Keep earlier saved content across sequence resets or missed origin windows.
			// Use a continuous local sequence and a discontinuity at the new material.
			p.epoch++
			p.offset = last.sn + 1 - p.sequence
			p.ccOffset = last.cc + 1 - cc
		}
	}
	key, mapTag := "#EXT-X-KEY:METHOD=NONE", ""
	keyID, mapID := "", ""
	duration := 0.0
	var tags []string
	var start, end, previousEnd int64
	previousURL := ""
	implicit := false
	rewrite := func(l string) (string, string, error) {
		match := hlsURI.FindStringSubmatch(l)
		if len(match) < 2 {
			return l, "", nil
		}
		raw, err := resolveHLS(match[1], base)
		if err != nil {
			return "", "", err
		}
		a, b := int64(0), int64(0)
		if strings.Contains(l, "BYTERANGE=") {
			m := hlsMapRange.FindStringSubmatch(l)
			if len(m) < 3 {
				return "", "", errors.New("explicit init range required")
			}
			n, _ := strconv.ParseInt(m[1], 10, 64)
			a, _ = strconv.ParseInt(m[2], 10, 64)
			b = a + n
			if n <= 0 || a < 0 || b <= a {
				return "", "", errors.New("invalid init range")
			}
			l = hlsMapRange.ReplaceAllString(l, "")
		}
		r := c.register(raw, false, a, b, fmt.Sprintf("%s/%d", base, p.epoch))
		r.dependency = true
		return strings.Replace(l, match[0], `URI="`+c.prefix+r.id+`"`, 1), r.id, nil
	}
	for _, line := range lines {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "#EXT-X-KEY:"):
			if !strings.Contains(line, "METHOD=NONE") && !strings.Contains(line, "METHOD=AES-128") {
				return nil, errors.New("encrypted HLS method not supported")
			}
			var err error
			key, keyID, err = rewrite(line)
			if err != nil {
				return nil, err
			}
		case strings.HasPrefix(line, "#EXT-X-MAP:"):
			var err error
			mapTag, mapID, err = rewrite(line)
			if err != nil {
				return nil, err
			}
		case line == "#EXT-X-DISCONTINUITY":
			cc++
		case strings.HasPrefix(line, "#EXTINF:"):
			duration, _ = strconv.ParseFloat(strings.Split(strings.TrimPrefix(line, "#EXTINF:"), ",")[0], 64)
			tags = append(tags, line)
		case strings.HasPrefix(line, "#EXT-X-BYTERANGE:"):
			parts := strings.Split(strings.TrimPrefix(line, "#EXT-X-BYTERANGE:"), "@")
			n, err := strconv.ParseInt(parts[0], 10, 64)
			if err != nil || n <= 0 {
				return nil, errors.New("invalid byte range")
			}
			start = previousEnd
			implicit = len(parts) == 1
			if !implicit {
				start, err = strconv.ParseInt(parts[1], 10, 64)
				if err != nil {
					return nil, err
				}
			}
			end = start + n
			if start < 0 || end <= start {
				return nil, errors.New("invalid byte range")
			}
		case strings.HasPrefix(line, "#EXT-X-PROGRAM-DATE-TIME:") || line == "#EXT-X-GAP":
			tags = append(tags, line)
		case line != "" && !strings.HasPrefix(line, "#"):
			if duration <= 0 || math.IsNaN(duration) || math.IsInf(duration, 0) {
				return nil, errors.New("invalid HLS duration")
			}
			raw, err := resolveHLS(line, base)
			if err != nil {
				return nil, err
			}
			if implicit && raw != previousURL {
				return nil, errors.New("invalid implicit byte range")
			}
			sn := p.sequence + int64(len(p.segments))
			r := c.register(raw, false, start, end, fmt.Sprintf("%s/%d/%d/%d", base, p.epoch, cc, sn))
			resources := []string{r.id}
			k := key
			if keyID != "" {
				resources = append(resources, keyID)
				if !strings.Contains(k, "IV=") {
					k += fmt.Sprintf(",IV=0x%032x", sn)
				}
			}
			out := []string{k}
			if mapTag != "" {
				out = append(out, mapTag)
				resources = append(resources, mapID)
			}
			out = append(out, tags...)
			out = append(out, c.prefix+r.id)
			p.segments = append(p.segments, cachedHLSSegment{sn: sn + p.offset, cc: cc + p.ccOffset, duration: duration, lines: out, resources: resources})
			previousEnd = end
			previousURL = raw
			duration = 0
			tags = nil
			start = 0
			end = 0
			implicit = false
		}
	}
	if len(p.segments) == 0 || len(p.segments) > 20000 || p.target <= 0 || math.IsInf(p.target, 0) || math.IsNaN(p.target) {
		return nil, errors.New("empty HLS playlist")
	}
	return p, nil
}

// Missing new origin bytes must not discard already saved history. Exclude the
// unavailable new tail, then trim only the prefix lost through capacity eviction.
func (c *hlsCache) retained(segments []cachedHLSSegment) []cachedHLSSegment {
	available := func(seg cachedHLSSegment) bool {
		for _, id := range seg.resources {
			if r := c.resources[id]; r == nil || r.size == 0 {
				return false
			}
		}
		return true
	}
	end := len(segments)
	for end > 0 && !available(segments[end-1]) {
		end--
	}
	start := end
	for start > 0 && available(segments[start-1]) {
		start--
	}
	return segments[start:end]
}
func (c *hlsCache) render(p *cachedHLSPlaylist) string {
	if len(p.segments) == 0 {
		return ""
	}
	segments := p.segments
	if !p.vod {
		segments = c.retained(segments)
	}
	if len(segments) == 0 {
		return ""
	}
	s := segments[0]
	out := []string{"#EXTM3U", "#EXT-X-VERSION:7", fmt.Sprintf("#EXT-X-TARGETDURATION:%.0f", math.Ceil(p.target)), fmt.Sprintf("#EXT-X-MEDIA-SEQUENCE:%d", s.sn), fmt.Sprintf("#EXT-X-DISCONTINUITY-SEQUENCE:%d", s.cc)}
	cc := s.cc
	for _, s := range segments {
		if cc != s.cc {
			out = append(out, "#EXT-X-DISCONTINUITY")
			cc = s.cc
		}
		out = append(out, s.lines...)
	}
	if p.ended || c.stopped {
		out = append(out, "#EXT-X-ENDLIST")
	}
	return strings.Join(out, "\n") + "\n"
}
func (c *hlsCache) manifest(id string, force bool) ([]byte, error) {
	c.manifestMu.Lock()
	defer c.manifestMu.Unlock()
	c.mu.Lock()
	r := c.resources[id]
	old := c.playlists[id]
	master := c.masters[id]
	if c.closed || r == nil {
		c.mu.Unlock()
		return nil, errors.New("cache closed")
	}
	// Master variants are stable for this session. Retain their rewritten URLs
	// so an ended broadcast remains reopenable when its origin disappears.
	if master != "" {
		c.mu.Unlock()
		return []byte(master), nil
	}
	if old == nil && (c.stopped) {
		c.mu.Unlock()
		return nil, errors.New("capture stopped")
	}
	if old != nil && (old.ended || c.stopped || (!force && time.Since(old.updated) < time.Second)) {
		if !force {
			old.touched = time.Now()
		}
		text := c.render(old)
		c.mu.Unlock()
		return []byte(text), nil
	}
	c.mu.Unlock()
	data, base, err := c.remote(r, 1<<20)
	if err != nil {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.state = "unknown"
		if old != nil {
			return []byte(c.render(old)), nil
		}
		return nil, err
	}
	text := string(data)
	if !strings.HasPrefix(strings.TrimSpace(text), "#EXTM3U") {
		return nil, errors.New("not an HLS playlist")
	}
	c.mu.Lock()
	if !strings.Contains(text, "#EXTINF:") {
		var rewriteErr error
		lines := strings.Split(text, "\n")
		for i, l := range lines {
			l = strings.TrimSpace(l)
			if strings.HasPrefix(l, "#EXT-X-DEFINE:") {
				rewriteErr = errors.New("variable HLS playlist not supported")
				break
			}
			binary := strings.HasPrefix(l, "#EXT-X-SESSION-KEY:")
			lines[i] = hlsURI.ReplaceAllStringFunc(l, func(tag string) string {
				m := hlsURI.FindStringSubmatch(tag)
				raw, e := resolveHLS(m[1], base)
				if e != nil {
					rewriteErr = e
					return tag
				}
				resource := c.register(raw, !binary, 0, 0, "")
				if binary {
					resource.dependency = true
					c.masterDependencies[resource.id] = true
				}
				return `URI="` + c.prefix + resource.id + `"`
			})
			if l != "" && !strings.HasPrefix(l, "#") {
				raw, e := resolveHLS(l, base)
				if e != nil {
					rewriteErr = e
					break
				}
				lines[i] = c.prefix + c.register(raw, true, 0, 0, "").id
			}
		}
		if rewriteErr == nil {
			c.masters[id] = strings.Join(lines, "\n")
		}
		c.mu.Unlock()
		return []byte(strings.Join(lines, "\n")), rewriteErr
	}
	p, err := c.media(text, base, old)
	if err != nil {
		c.mu.Unlock()
		return nil, err
	}
	p.vod = p.ended && (old == nil || old.vod)
	if force && old != nil {
		p.touched = old.touched
	}
	if old != nil {
		var prefix []cachedHLSSegment
		for _, seg := range old.segments {
			if seg.sn < p.segments[0].sn {
				prefix = append(prefix, seg)
			}
		}
		p.segments = append(prefix, p.segments...)
	}
	// Capture every new complete segment, including while the player is paused.
	var capture []string
	for _, seg := range p.segments {
		for _, key := range seg.resources {
			if res := c.resources[key]; res != nil && res.size == 0 {
				capture = append(capture, key)
			}
		}
	}
	c.mu.Unlock()
	// Do not fetch an arbitrarily long initial VOD/live backlog in one request.
	if p.vod {
		capture = nil
	}
	if len(capture) > 24 {
		capture = capture[len(capture)-24:]
	}
	for _, key := range capture {
		if _, e := c.binary(key); e != nil {
			break
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, errors.New("cache closed")
	}
	if !p.vod {
		p.segments = c.retained(p.segments)
		if len(p.segments) == 0 {
			c.pruneLocked()
			return nil, errors.New("no HLS media retained")
		}
	}
	previousLast := int64(-1)
	if old != nil && len(old.segments) > 0 {
		previousLast = old.segments[len(old.segments)-1].sn
	}
	if p.segments[len(p.segments)-1].sn != previousLast {
		c.confirmed = time.Now()
		c.state = "live"
	}
	if p.ended {
		c.state = "ended"
	}
	c.playlists[id] = p
	c.pruneLocked()
	return []byte(c.render(p)), nil
}
func (c *hlsCache) pruneLocked() {
	used := map[string]bool{c.root: true}
	for id := range c.masterDependencies {
		used[id] = true
	}
	for _, p := range c.playlists {
		for _, seg := range p.segments {
			for _, id := range seg.resources {
				used[id] = true
			}
		}
	}
	for id, r := range c.resources {
		if !r.manifest && !used[id] {
			if c.removeBytes(r) == nil {
				delete(c.resources, id)
			}
		}
	}
}
func (c *hlsCache) poll() {
	c.mu.Lock()
	if c.closed || c.stopped {
		c.mu.Unlock()
		return
	}
	var ids []string
	for id, p := range c.playlists {
		if !p.ended && time.Since(p.updated) >= time.Duration(p.target*float64(time.Second)/2) {
			ids = append(ids, id)
		}
	}
	c.mu.Unlock()
	for _, id := range ids {
		_, _ = c.manifest(id, true)
	}
}
func (c *hlsCache) stop() { c.mu.Lock(); c.stopped = true; c.mu.Unlock() }
func (c *hlsCache) close() {
	c.mu.Lock()
	c.closed = true
	c.cancel()
	c.mu.Unlock()
	c.ioMu.Lock()
	defer c.ioMu.Unlock()
	_ = os.RemoveAll(c.dir)
	c.client.CloseIdleConnections()
}
