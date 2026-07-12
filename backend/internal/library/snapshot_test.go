package library

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

func sampleItems() []Media {
	now := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	return []Media{
		{ID: "v1", Type: MediaTypeVideo, RootName: "movies", RelativePath: "b.mp4", Name: "b.mp4", SizeBytes: 1, ModifiedAt: now},
		{ID: "v2", Type: MediaTypeVideo, RootName: "movies", RelativePath: "a.mp4", Name: "a.mp4", SizeBytes: 1, ModifiedAt: now},
		{ID: "a1", Type: MediaTypeAudio, RootName: "music", RelativePath: "song.mp3", Name: "song.mp3", SizeBytes: 1, ModifiedAt: now},
	}
}

func TestSnapshotListReturnsAllSorted(t *testing.T) {
	s := NewSnapshot(sampleItems())
	all := s.List("")
	if len(all) != 3 {
		t.Fatalf("len = %d, want 3", len(all))
	}
	if all[0].RootName != "movies" || all[0].RelativePath != "a.mp4" {
		t.Fatalf("unexpected first item: %#v", all[0])
	}
	if all[2].RootName != "music" {
		t.Fatalf("unexpected last item: %#v", all[2])
	}
}

func TestSnapshotListFiltersByType(t *testing.T) {
	s := NewSnapshot(sampleItems())

	videos := s.List(MediaTypeVideo)
	if len(videos) != 2 {
		t.Fatalf("len(videos) = %d, want 2", len(videos))
	}
	for _, v := range videos {
		if v.Type != MediaTypeVideo {
			t.Errorf("unexpected type in video list: %q", v.Type)
		}
	}

	audios := s.List(MediaTypeAudio)
	if len(audios) != 1 || audios[0].Type != MediaTypeAudio {
		t.Fatalf("unexpected audio list: %#v", audios)
	}
}

func TestSnapshotGet(t *testing.T) {
	s := NewSnapshot(sampleItems())
	got, err := s.Get("v1")
	if err != nil {
		t.Fatalf("Get(v1) error: %v", err)
	}
	if got.RelativePath != "b.mp4" {
		t.Fatalf("Get(v1) RelativePath = %q", got.RelativePath)
	}

	if _, err := s.Get("missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get(missing) err = %v, want ErrNotFound", err)
	}
}

func TestSnapshotReplaceIsAtomic(t *testing.T) {
	s := NewSnapshot(sampleItems())
	result := s.Replace(nil)
	if result.Revision != 2 || result.Removed != 3 || !result.Full {
		t.Fatalf("Replace result = %#v", result)
	}
	if got := s.List(""); len(got) != 0 {
		t.Fatalf("List after empty Replace = %#v, want empty", got)
	}
	if _, err := s.Get("v1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after Replace err = %v, want ErrNotFound", err)
	}

	result = s.Replace(sampleItems())
	if result.Revision != 3 || result.Added != 3 {
		t.Fatalf("refill result = %#v", result)
	}
	if got := s.List(""); len(got) != 3 {
		t.Fatalf("List after refill = %d, want 3", len(got))
	}
}

func TestSnapshotReconciledLeavesCurrentSnapshotReadable(t *testing.T) {
	current := NewSnapshot(sampleItems())
	base := current.Revision()
	nextItems := sampleItems()
	nextItems[0].Name = "updated.mp4"

	next, result := current.Reconciled(nextItems)
	if result.Updated != 1 || result.Revision != base+1 {
		t.Fatalf("result = %#v", result)
	}
	if got, _ := current.Get("v1"); got.Name != "b.mp4" {
		t.Fatalf("current snapshot changed: %#v", got)
	}
	if got, _ := next.Get("v1"); got.Name != "updated.mp4" {
		t.Fatalf("next snapshot = %#v", got)
	}
	if changes := next.ChangesSince(base, MediaTypeVideo); len(changes.Upserts) != 1 {
		t.Fatalf("changes = %#v", changes)
	}
}

func TestSnapshotReconciledUnchangedReturnsCurrentSnapshot(t *testing.T) {
	current := NewSnapshot(sampleItems())
	revision := current.Revision()
	audioRevision := current.RevisionFor(MediaTypeAudio)
	videoRevision := current.RevisionFor(MediaTypeVideo)

	next, result := current.Reconciled(sampleItems())

	if next != current {
		t.Fatal("unchanged reconciliation returned a replacement snapshot")
	}
	if result.Revision != revision || result.Added != 0 ||
		result.Updated != 0 || result.Removed != 0 || !result.Full {
		t.Fatalf("result = %#v", result)
	}
	if next.RevisionFor(MediaTypeAudio) != audioRevision ||
		next.RevisionFor(MediaTypeVideo) != videoRevision {
		t.Fatal("unchanged reconciliation changed type revisions")
	}
}

func TestSnapshotUnchangedReplaceKeepsRevision(t *testing.T) {
	s := NewSnapshot(sampleItems())
	before := s.Revision()
	result := s.Replace(sampleItems())

	if result.Revision != before || result.Added != 0 || result.Updated != 0 || result.Removed != 0 {
		t.Fatalf("unchanged result = %#v, before revision = %d", result, before)
	}
	if got := s.Revision(); got != before {
		t.Fatalf("Revision = %d, want %d", got, before)
	}
}

func TestSnapshotApplyAddsUpdatesAndDeletesAtomically(t *testing.T) {
	s := NewSnapshot(sampleItems())
	updated := sampleItems()[0]
	updated.Name = "updated.mp4"
	added := Media{
		ID:           "i1",
		Type:         MediaTypeImage,
		RootName:     "images",
		RelativePath: "cover.jpg",
		Name:         "cover.jpg",
		SizeBytes:    2,
		ModifiedAt:   time.Date(2025, 2, 1, 0, 0, 0, 0, time.UTC),
	}

	result := s.Apply([]Media{updated, added}, []string{"a1", "missing"})
	if result.Revision != 2 || result.Added != 1 || result.Updated != 1 || result.Removed != 1 {
		t.Fatalf("Apply result = %#v", result)
	}
	if result.Full {
		t.Fatal("Apply result marked as full")
	}
	if got := result.AffectedTypes; fmt.Sprint(got) != "[audio video image]" {
		t.Fatalf("AffectedTypes = %v", got)
	}
	if _, err := s.Get("a1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted Get err = %v", err)
	}
	if got, err := s.Get("v1"); err != nil || got.Name != "updated.mp4" {
		t.Fatalf("updated item = %#v, err = %v", got, err)
	}
	if got, err := s.GetByPath("images", "cover.jpg"); err != nil || got.ID != "i1" {
		t.Fatalf("GetByPath = %#v, err = %v", got, err)
	}
}

func TestSnapshotApplyKeepsEveryUpsertInSortedOrder(t *testing.T) {
	now := time.Now().UTC()
	snapshot := NewSnapshot([]Media{
		{
			ID:           "existing",
			Type:         MediaTypeAudio,
			RootName:     "music",
			RelativePath: "b.mp3",
			Name:         "b.mp3",
			ModifiedAt:   now,
		},
	})

	snapshot.Apply([]Media{
		{
			ID:           "first",
			Type:         MediaTypeAudio,
			RootName:     "music",
			RelativePath: "a.mp3",
			Name:         "a.mp3",
			ModifiedAt:   now,
		},
		{
			ID:           "third",
			Type:         MediaTypeAudio,
			RootName:     "music",
			RelativePath: "c.mp3",
			Name:         "c.mp3",
			ModifiedAt:   now,
		},
	}, nil)

	items := snapshot.List(MediaTypeAudio)
	if len(items) != 3 {
		t.Fatalf("items = %#v", items)
	}
	for index, want := range []string{"first", "existing", "third"} {
		if items[index].ID != want {
			t.Fatalf("items[%d].ID = %q, want %q", index, items[index].ID, want)
		}
	}
}

func TestSnapshotPathReplacementRemovesPreviousID(t *testing.T) {
	s := NewSnapshot([]Media{{
		ID:           "old",
		Type:         MediaTypeAudio,
		RootName:     "music",
		RelativePath: "song.mp3",
		Name:         "song.mp3",
	}})
	result := s.Apply([]Media{{
		ID:           "new",
		Type:         MediaTypeAudio,
		RootName:     "music",
		RelativePath: "song.mp3",
		Name:         "song.mp3",
	}}, nil)

	if result.Added != 1 || result.Removed != 1 {
		t.Fatalf("result = %#v", result)
	}
	if _, err := s.Get("old"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old item still present: %v", err)
	}
	if got, err := s.GetByPath("music", "song.mp3"); err != nil || got.ID != "new" {
		t.Fatalf("GetByPath = %#v, err = %v", got, err)
	}
}

func TestSnapshotRenameDeletesOldIDAndPublishesNewID(t *testing.T) {
	s := NewSnapshot([]Media{{
		ID:           "old",
		Type:         MediaTypeVideo,
		RootName:     "video",
		RelativePath: "old.mp4",
		Name:         "old.mp4",
	}})
	base := s.Revision()

	result := s.Apply([]Media{{
		ID:           "new",
		Type:         MediaTypeVideo,
		RootName:     "video",
		RelativePath: "new.mp4",
		Name:         "new.mp4",
	}}, []string{"old"})
	if result.Added != 1 || result.Removed != 1 {
		t.Fatalf("result = %#v", result)
	}
	changes := s.ChangesSince(base, MediaTypeVideo)
	if len(changes.Upserts) != 1 || changes.Upserts[0].ID != "new" ||
		fmt.Sprint(changes.DeletedIDs) != "[old]" {
		t.Fatalf("changes = %#v", changes)
	}
}

func TestSnapshotTypeChangeDeletesFromOldFilterAndUpsertsToNewFilter(t *testing.T) {
	s := NewSnapshot([]Media{{
		ID:           "same",
		Type:         MediaTypeAudio,
		RootName:     "root",
		RelativePath: "media.bin",
		Name:         "media.bin",
	}})
	base := s.Revision()
	result := s.Apply([]Media{{
		ID:           "same",
		Type:         MediaTypeVideo,
		RootName:     "root",
		RelativePath: "media.bin",
		Name:         "media.bin",
	}}, nil)
	if result.Updated != 1 || result.Removed != 0 {
		t.Fatalf("result = %#v", result)
	}

	audio := s.ChangesSince(base, MediaTypeAudio)
	if fmt.Sprint(audio.DeletedIDs) != "[same]" || len(audio.Upserts) != 0 {
		t.Fatalf("audio changes = %#v", audio)
	}
	video := s.ChangesSince(base, MediaTypeVideo)
	if len(video.Upserts) != 1 || video.Upserts[0].Type != MediaTypeVideo ||
		len(video.DeletedIDs) != 0 {
		t.Fatalf("video changes = %#v", video)
	}
	all := s.ChangesSince(base, "")
	if len(all.Upserts) != 1 || len(all.DeletedIDs) != 0 {
		t.Fatalf("all changes = %#v", all)
	}
}

func TestSnapshotFilterRevisionOnlyChangesForAffectedTypes(t *testing.T) {
	s := NewSnapshot(sampleItems())
	audioRevision := s.RevisionFor(MediaTypeAudio)
	videoRevision := s.RevisionFor(MediaTypeVideo)

	video := sampleItems()[0]
	video.Name = "changed.mp4"
	s.Apply([]Media{video}, nil)

	if got := s.RevisionFor(MediaTypeAudio); got != audioRevision {
		t.Fatalf("audio revision = %d, want %d", got, audioRevision)
	}
	if got := s.RevisionFor(MediaTypeVideo); got <= videoRevision {
		t.Fatalf("video revision = %d, want > %d", got, videoRevision)
	}
	changes := s.ChangesSince(1, MediaTypeAudio)
	if changes.ETagRevision != audioRevision {
		t.Fatalf("audio ETag revision = %d, want %d", changes.ETagRevision, audioRevision)
	}
}

func TestSnapshotUpsertWinsOverDeleteWithoutSpuriousRevision(t *testing.T) {
	item := Media{
		ID:           "same",
		Type:         MediaTypeAudio,
		RootName:     "music",
		RelativePath: "song.mp3",
		Name:         "song.mp3",
	}
	s := NewSnapshot([]Media{item})
	base := s.Revision()

	result := s.Apply([]Media{item}, []string{item.ID})
	if result.Revision != base || result.Added != 0 || result.Updated != 0 || result.Removed != 0 {
		t.Fatalf("result = %#v, base revision = %d", result, base)
	}
	if changes := s.ChangesSince(base, ""); len(changes.Upserts) != 0 || len(changes.DeletedIDs) != 0 {
		t.Fatalf("changes = %#v", changes)
	}
}

func TestSnapshotKeepsLastUpsertForDuplicatePath(t *testing.T) {
	s := NewSnapshot(nil)
	first := Media{
		ID:           "first",
		Type:         MediaTypeAudio,
		RootName:     "music",
		RelativePath: "song.mp3",
		Name:         "first.mp3",
	}
	last := first
	last.ID = "last"
	last.Name = "last.mp3"

	result := s.Apply([]Media{first, last}, nil)
	if result.Added != 1 || result.Updated != 0 || result.Removed != 0 {
		t.Fatalf("result = %#v", result)
	}
	items := s.List("")
	if len(items) != 1 || items[0].ID != "last" {
		t.Fatalf("items = %#v", items)
	}
	if _, err := s.Get("first"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("first item still present: %v", err)
	}
}

func TestSnapshotMixedBatchDoesNotDuplicateMetadataOnlyUpdate(t *testing.T) {
	items := sampleItems()
	s := NewSnapshot(items)
	updated := items[0]
	updated.Name = "updated.mp4"
	added := Media{
		ID:           "new",
		Type:         MediaTypeImage,
		RootName:     "images",
		RelativePath: "new.jpg",
		Name:         "new.jpg",
	}

	s.Apply([]Media{updated, added}, []string{items[2].ID})
	got := s.List("")
	seen := make(map[string]int)
	for _, item := range got {
		seen[item.ID]++
	}
	if len(got) != 3 || seen[updated.ID] != 1 || seen[added.ID] != 1 {
		t.Fatalf("items = %#v, counts = %#v", got, seen)
	}
}

func TestSnapshotChangesSinceMergesRecentBatches(t *testing.T) {
	s := NewSnapshot(sampleItems())
	base := s.Revision()

	video := sampleItems()[0]
	video.Name = "changed.mp4"
	s.Apply([]Media{video}, []string{"a1"})
	s.Apply([]Media{{
		ID:           "a2",
		Type:         MediaTypeAudio,
		RootName:     "music",
		RelativePath: "next.mp3",
		Name:         "next.mp3",
	}}, []string{"v1"})

	changes := s.ChangesSince(base, "")
	if changes.ResetRequired || changes.Revision != 3 {
		t.Fatalf("changes = %#v", changes)
	}
	if len(changes.Upserts) != 1 || changes.Upserts[0].ID != "a2" {
		t.Fatalf("Upserts = %#v", changes.Upserts)
	}
	if fmt.Sprint(changes.DeletedIDs) != "[a1 v1]" {
		t.Fatalf("DeletedIDs = %v", changes.DeletedIDs)
	}

	audioChanges := s.ChangesSince(base, MediaTypeAudio)
	if len(audioChanges.Upserts) != 1 || fmt.Sprint(audioChanges.DeletedIDs) != "[a1]" {
		t.Fatalf("audio changes = %#v", audioChanges)
	}
}

func TestSnapshotChangesRequireResetOutsideJournal(t *testing.T) {
	s := newSnapshot(nil, 2, 2)
	s.Apply([]Media{{ID: "a1", Type: MediaTypeAudio, RootName: "r", RelativePath: "a1.mp3"}}, nil)
	s.Apply([]Media{{ID: "a2", Type: MediaTypeAudio, RootName: "r", RelativePath: "a2.mp3"}}, nil)
	s.Apply([]Media{{ID: "a3", Type: MediaTypeAudio, RootName: "r", RelativePath: "a3.mp3"}}, nil)

	if changes := s.ChangesSince(0, ""); !changes.ResetRequired {
		t.Fatalf("ChangesSince(0) = %#v, want reset", changes)
	}
	if changes := s.ChangesSince(1, ""); changes.ResetRequired || len(changes.Upserts) != 2 {
		t.Fatalf("ChangesSince(1) = %#v", changes)
	}
}

func TestSnapshotConcurrentReadersObserveWholeBatches(t *testing.T) {
	left := []Media{
		{ID: "a", Type: MediaTypeAudio, RootName: "root", RelativePath: "a.mp3", Name: "a.mp3"},
		{ID: "b", Type: MediaTypeAudio, RootName: "root", RelativePath: "b.mp3", Name: "b.mp3"},
	}
	right := []Media{
		{ID: "c", Type: MediaTypeVideo, RootName: "root", RelativePath: "c.mp4", Name: "c.mp4"},
		{ID: "d", Type: MediaTypeVideo, RootName: "root", RelativePath: "d.mp4", Name: "d.mp4"},
		{ID: "e", Type: MediaTypeVideo, RootName: "root", RelativePath: "e.mp4", Name: "e.mp4"},
	}
	s := NewSnapshot(left)

	var wg sync.WaitGroup
	errCh := make(chan error, 8)
	for reader := 0; reader < 8; reader++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 1000; i++ {
				items := s.List("")
				if !matchesIDs(items, "a", "b") && !matchesIDs(items, "c", "d", "e") {
					errCh <- fmt.Errorf("partial snapshot: %#v", items)
					return
				}
			}
		}()
	}
	for i := 0; i < 200; i++ {
		s.Replace(right)
		s.Replace(left)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatal(err)
	}
}

func TestSnapshotListReturnsCopy(t *testing.T) {
	s := NewSnapshot(sampleItems())
	first := s.List("")
	first[0].Name = "mutated"
	first[0].Subtitles = append(first[0].Subtitles, Subtitle{RelativePath: "mutated.srt"})

	second := s.List("")
	if second[0].Name == "mutated" {
		t.Fatal("List did not return a defensive copy")
	}
	if len(second[0].Subtitles) != 0 {
		t.Fatal("List did not deep-copy subtitles")
	}
}

func matchesIDs(items []Media, ids ...string) bool {
	if len(items) != len(ids) {
		return false
	}
	for i, id := range ids {
		if items[i].ID != id {
			return false
		}
	}
	return true
}
