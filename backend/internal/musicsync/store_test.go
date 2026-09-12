package musicsync

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"sync"
	"testing"
)

func op(id, kind, playlist, key string, value any, revision int64) Operation {
	raw, _ := json.Marshal(value)
	return Operation{ID: id, Kind: kind, PlaylistID: playlist, Key: key, Value: raw, BaseRevision: revision}
}
func opened(t *testing.T) *Store {
	t.Helper()
	s, e := Open(filepath.Join(t.TempDir(), "sync.json"))
	if e != nil {
		t.Fatal(e)
	}
	return s
}
func applyOK(t *testing.T, s *Store, ops ...Operation) Response {
	t.Helper()
	r, e := s.Apply(ops)
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func TestDuplicateAndStaleLike(t *testing.T) {
	s := opened(t)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, e := s.Apply([]Operation{op("like", "like", "", "song", true, 0)}); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	if s.Snapshot().Revision != 1 {
		t.Fatal("duplicate mutations advanced revision")
	}
	applyOK(t, s, op("remove", "like", "", "song", false, 1))
	r := applyOK(t, s, op("late-like", "like", "", "song", true, 0))
	if r.Results[0].Status != "conflict" || r.Snapshot.Likes["song"].Value {
		t.Fatal("stale device resurrected removed like")
	}
	r = applyOK(t, s, op("repeat-remove", "like", "", "song", false, 1))
	if r.Results[0].Status != "noop" || r.Snapshot.Revision != 2 {
		t.Fatal(r)
	}
	restored, e := Open(s.path)
	if e != nil {
		t.Fatal(e)
	}
	if restored.Snapshot().Likes["song"].Revision != 2 {
		t.Fatal("lost tombstone")
	}
}
func TestMissingRemovalPreventsLegacyResurrection(t *testing.T) {
	s := opened(t)
	applyOK(t, s, op("remove", "like", "", "song", false, 0))
	r := applyOK(t, s, op("legacy", "like", "", "song", true, 0))
	if r.Results[0].Status != "conflict" {
		t.Fatal(r)
	}
	applyOK(t, s, op("delete", "delete", "gone", "", true, 0))
	r = applyOK(t, s, op("legacy-list", "create", "gone", "", "Old", 0))
	if r.Results[0].Status != "conflict" {
		t.Fatal(r)
	}
	if _, e := Open(s.path); e != nil {
		t.Fatal(e)
	}
}
func TestPlaylistIdentityMembershipAndOrder(t *testing.T) {
	s := opened(t)
	applyOK(t, s, op("a", "create", "a", "", "Mix", 0), op("song", "item", "a", "song", true, 0))
	r := applyOK(t, s, op("b", "create", "b", "", " Mix ", 0), op("dup-song", "item", "b", "song", true, 0))
	if len(r.Snapshot.Playlists) != 1 || r.Results[0].CanonicalID != "a" || r.Results[1].Status != "noop" {
		t.Fatal(r)
	}
	member := r.Snapshot.Playlists["a"].Items["song"]
	applyOK(t, s, op("remove", "item", "a", "song", false, member.Revision))
	r = applyOK(t, s, op("late", "item", "a", "song", true, 0))
	if r.Results[0].Status != "conflict" {
		t.Fatal(r)
	}
	applyOK(t, s, op("second", "item", "a", "second", true, 0), op("order", "order", "a", "", []string{"second"}, 0))
	before := s.Snapshot()
	r = applyOK(t, s, op("repeat-order", "order", "a", "", []string{"second"}, 0))
	if r.Snapshot.Revision != before.Revision {
		t.Fatal("duplicate reorder")
	}
	applyOK(t, s, op("delete", "delete", "a", "", true, 0))
	r = applyOK(t, s, op("repeat-delete", "delete", "a", "", true, 0), op("late-member", "item", "a", "new", true, 0))
	if r.Results[0].Status != "noop" || r.Results[1].Status != "conflict" {
		t.Fatal(r)
	}
}
func TestDiskFailureAndInvalidBatchAreAtomic(t *testing.T) {
	s := opened(t)
	applyOK(t, s, op("first", "like", "", "a", true, 0))
	before := s.Snapshot().Revision
	s.persist = func(string, Snapshot) error { return errors.New("disk full") }
	if _, e := s.Apply([]Operation{op("new", "like", "", "b", true, 0)}); e == nil {
		t.Fatal("acknowledged failed persistence")
	}
	if s.Snapshot().Revision != before || s.Snapshot().Likes["b"].Value {
		t.Fatal("published failed write")
	}
	if _, e := s.Apply([]Operation{op("valid", "like", "", "c", true, 0), op("bad", "toggle", "", "d", true, 0)}); e == nil {
		t.Fatal("accepted invalid batch")
	}
	if s.Snapshot().Revision != before {
		t.Fatal("partial batch")
	}
}
