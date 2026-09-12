// Package musicsync persists explicit, revision-checked music metadata mutations.
package musicsync

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const MaxOperations = 128
const maxEntries = 100000
const maxPlaylists = 1000
const maxRevision int64 = 9007199254740991

var ErrInvalid = errors.New("invalid music sync operation")
var ErrLimit = errors.New("music sync storage limit reached")

type Cell[T any] struct {
	Value    T     `json:"value"`
	Revision int64 `json:"revision"`
}
type Playlist struct {
	ID        string                `json:"id"`
	Name      Cell[string]          `json:"name"`
	Deleted   Cell[bool]            `json:"deleted"`
	Items     map[string]Cell[bool] `json:"items"`
	Order     Cell[[]string]        `json:"order"`
	CreatedAt string                `json:"createdAt"`
}
type Snapshot struct {
	Revision  int64                 `json:"revision"`
	Likes     map[string]Cell[bool] `json:"likes"`
	Playlists map[string]Playlist   `json:"playlists"`
}
type Operation struct {
	ID           string          `json:"id"`
	Kind         string          `json:"kind"`
	PlaylistID   string          `json:"playlistId,omitempty"`
	Key          string          `json:"key,omitempty"`
	Value        json.RawMessage `json:"value"`
	BaseRevision int64           `json:"baseRevision"`
}

// Require the concurrency precondition explicitly; omission must not imply zero.
func (o *Operation) UnmarshalJSON(data []byte) error {
	type plain Operation
	var wire struct {
		*plain
		BaseRevision *int64 `json:"baseRevision"`
	}
	wire.plain = (*plain)(o)
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(&wire); err != nil {
		return err
	}
	if wire.BaseRevision == nil {
		return fmt.Errorf("%w: baseRevision required", ErrInvalid)
	}
	o.BaseRevision = *wire.BaseRevision
	return nil
}

type Result struct {
	ID          string `json:"id"`
	Status      string `json:"status"`
	Revision    int64  `json:"revision"`
	CanonicalID string `json:"canonicalId,omitempty"`
}
type Response struct {
	Snapshot Snapshot `json:"snapshot"`
	Results  []Result `json:"results"`
}
type Store struct {
	mu       sync.Mutex
	snapshot Snapshot
	path     string
	persist  func(string, Snapshot) error
}

func Open(path string) (*Store, error) {
	s := &Store{snapshot: Snapshot{Likes: map[string]Cell[bool]{}, Playlists: map[string]Playlist{}}, path: path, persist: writeAtomic}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(&s.snapshot); err != nil {
		return nil, fmt.Errorf("read music sync: %w", err)
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return nil, errors.New("invalid trailing music sync data")
	}
	if err := validateSnapshot(s.snapshot); err != nil {
		return nil, err
	}
	return s, nil
}
func (s *Store) Revision() int64    { s.mu.Lock(); defer s.mu.Unlock(); return s.snapshot.Revision }
func (s *Store) Snapshot() Snapshot { s.mu.Lock(); defer s.mu.Unlock(); return clone(s.snapshot) }
func clone(in Snapshot) Snapshot {
	out := Snapshot{Revision: in.Revision, Likes: make(map[string]Cell[bool], len(in.Likes)), Playlists: make(map[string]Playlist, len(in.Playlists))}
	for k, v := range in.Likes {
		out.Likes[k] = v
	}
	for k, p := range in.Playlists {
		p.Items = cloneBools(p.Items)
		p.Order.Value = append([]string{}, p.Order.Value...)
		out.Playlists[k] = p
	}
	return out
}
func cloneBools(in map[string]Cell[bool]) map[string]Cell[bool] {
	out := make(map[string]Cell[bool], len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
func validText(v string, max int) bool {
	return v != "" && len(v) <= max && utf8.ValidString(v) && !strings.ContainsAny(v, "\x00\r\n")
}
func orderValue(raw json.RawMessage) ([]string, error) {
	var v []string
	err := json.Unmarshal(raw, &v)
	if err != nil || v == nil {
		return nil, ErrInvalid
	}
	seen := map[string]bool{}
	for _, key := range v {
		if !validText(key, 4096) || seen[key] {
			return nil, ErrInvalid
		}
		seen[key] = true
	}
	if len(v) > maxEntries {
		return nil, ErrLimit
	}
	return v, nil
}
func Validate(ops []Operation) error {
	if len(ops) == 0 || len(ops) > MaxOperations {
		return fmt.Errorf("%w: operations must contain 1 to %d entries", ErrInvalid, MaxOperations)
	}
	ids := map[string]bool{}
	for _, o := range ops {
		if !validText(o.ID, 256) || ids[o.ID] || o.BaseRevision < 0 || o.BaseRevision > maxRevision || len(o.Value) == 0 || bytes.Equal(bytes.TrimSpace(o.Value), []byte("null")) {
			return ErrInvalid
		}
		ids[o.ID] = true
		if o.Kind == "like" {
			if o.PlaylistID != "" || !validText(o.Key, 4096) {
				return ErrInvalid
			}
		} else if !validText(o.PlaylistID, 256) {
			return ErrInvalid
		}
		switch o.Kind {
		case "like", "item", "delete":
			var v bool
			if json.Unmarshal(o.Value, &v) != nil {
				return ErrInvalid
			}
			if o.Kind == "item" && !validText(o.Key, 4096) {
				return ErrInvalid
			}
			if o.Kind == "delete" && (!v || o.Key != "") {
				return ErrInvalid
			}
		case "create", "name":
			var v string
			if json.Unmarshal(o.Value, &v) != nil || !validText(strings.TrimSpace(v), 512) || o.Key != "" {
				return ErrInvalid
			}
			if o.Kind == "create" && o.BaseRevision != 0 {
				return ErrInvalid
			}
		case "order":
			if o.Key != "" {
				return ErrInvalid
			}
			if _, err := orderValue(o.Value); err != nil {
				return err
			}
		default:
			return ErrInvalid
		}
	}
	return nil
}
func (s *Store) Apply(ops []Operation) (Response, error) {
	if err := Validate(ops); err != nil {
		return Response{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := clone(s.snapshot)
	results := make([]Result, 0, len(ops))
	aliases := map[string]string{}
	for _, o := range ops {
		if canonical, ok := aliases[o.PlaylistID]; ok {
			o.PlaylistID = canonical
		}
		r := apply(&next, o)
		if r.CanonicalID != "" {
			aliases[o.PlaylistID] = r.CanonicalID
		}
		results = append(results, r)
	}
	if next.Revision != s.snapshot.Revision {
		if err := validateSnapshot(next); err != nil {
			return Response{}, err
		}
		if err := s.persist(s.path, next); err != nil {
			return Response{}, fmt.Errorf("persist music sync: %w", err)
		}
		s.snapshot = next
	}
	return Response{Snapshot: clone(s.snapshot), Results: results}, nil
}
func apply(s *Snapshot, o Operation) Result {
	r := Result{ID: o.ID, Status: "conflict"}
	bump := func() int64 { s.Revision++; r.Status = "applied"; r.Revision = s.Revision; return s.Revision }
	boolean := func(c Cell[bool]) Cell[bool] {
		var desired bool
		_ = json.Unmarshal(o.Value, &desired)
		r.Revision = c.Revision
		if desired == c.Value {
			r.Status = "noop"
			return c
		}
		if c.Revision != o.BaseRevision {
			return c
		}
		return Cell[bool]{desired, bump()}
	}
	if o.Kind == "like" {
		old, exists := s.Likes[o.Key]
		c := boolean(old)
		if !exists && r.Status == "noop" && o.BaseRevision == 0 {
			c.Revision = bump()
		}
		if r.Status == "applied" {
			s.Likes[o.Key] = c
		}
		return r
	}
	p, exists := s.Playlists[o.PlaylistID]
	if exists && p.Deleted.Value {
		r.Revision = p.Deleted.Revision
		if o.Kind == "delete" {
			r.Status = "noop"
		}
		return r
	}
	if o.Kind == "create" {
		var name string
		_ = json.Unmarshal(o.Value, &name)
		name = strings.TrimSpace(name)
		if exists {
			r.Revision = p.Name.Revision
			if p.Name.Value == name {
				r.Status = "noop"
			}
			return r
		}
		for id, other := range s.Playlists {
			if !other.Deleted.Value && other.Name.Value == name {
				r.Status = "noop"
				r.Revision = other.Name.Revision
				r.CanonicalID = id
				return r
			}
		}
		rev := bump()
		s.Playlists[o.PlaylistID] = Playlist{ID: o.PlaylistID, Name: Cell[string]{name, rev}, Items: map[string]Cell[bool]{}, Order: Cell[[]string]{Value: []string{}}, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
		return r
	}
	if !exists {
		if o.Kind == "delete" && o.BaseRevision == 0 {
			rev := bump()
			s.Playlists[o.PlaylistID] = Playlist{ID: o.PlaylistID, Deleted: Cell[bool]{true, rev}, Items: map[string]Cell[bool]{}, Order: Cell[[]string]{Value: []string{}}, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
		}
		return r
	}
	switch o.Kind {
	case "name":
		var name string
		_ = json.Unmarshal(o.Value, &name)
		name = strings.TrimSpace(name)
		r.Revision = p.Name.Revision
		if name == p.Name.Value {
			r.Status = "noop"
			return r
		}
		if p.Name.Revision != o.BaseRevision {
			return r
		}
		for id, other := range s.Playlists {
			if id != p.ID && !other.Deleted.Value && other.Name.Value == name {
				return r
			}
		}
		p.Name = Cell[string]{name, bump()}
	case "delete":
		p.Deleted = boolean(p.Deleted)
	case "item":
		old, exists := p.Items[o.Key]
		c := boolean(old)
		if !exists && r.Status == "noop" && o.BaseRevision == 0 {
			c.Revision = bump()
		}
		if r.Status == "applied" {
			p.Items[o.Key] = c
		}
	case "order":
		desired, _ := orderValue(o.Value)
		r.Revision = p.Order.Revision
		if reflect.DeepEqual(desired, p.Order.Value) {
			r.Status = "noop"
			return r
		}
		if p.Order.Revision != o.BaseRevision {
			return r
		}
		p.Order = Cell[[]string]{desired, bump()}
	}
	if r.Status == "applied" {
		s.Playlists[p.ID] = p
	}
	return r
}
func validateSnapshot(s Snapshot) error {
	if s.Revision < 0 || s.Revision > maxRevision || s.Likes == nil || s.Playlists == nil {
		return errors.New("invalid music sync snapshot")
	}
	if len(s.Likes) > maxEntries || len(s.Playlists) > maxPlaylists {
		return ErrLimit
	}
	validRev := func(r int64) bool { return r >= 0 && r <= s.Revision }
	for key, c := range s.Likes {
		if !validText(key, 4096) || !validRev(c.Revision) {
			return errors.New("invalid music sync like")
		}
	}
	memberships := 0
	names := map[string]bool{}
	for id, p := range s.Playlists {
		if p.ID != id || !validText(id, 256) || (!p.Deleted.Value && !validText(p.Name.Value, 512)) || p.Items == nil || p.Order.Value == nil || !validRev(p.Name.Revision) || !validRev(p.Deleted.Revision) || !validRev(p.Order.Revision) {
			return errors.New("invalid music sync playlist")
		}
		if !p.Deleted.Value {
			if names[p.Name.Value] {
				return errors.New("duplicate music sync playlist name")
			}
			names[p.Name.Value] = true
		}
		memberships += len(p.Items)
		if memberships > maxEntries {
			return ErrLimit
		}
		for key, c := range p.Items {
			if !validText(key, 4096) || !validRev(c.Revision) {
				return errors.New("invalid music sync item")
			}
		}
		raw, _ := json.Marshal(p.Order.Value)
		if _, err := orderValue(raw); err != nil {
			return err
		}
	}
	return nil
}
func writeAtomic(path string, s Snapshot) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".music-sync-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	defer f.Close()
	if err = json.NewEncoder(f).Encode(s); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
