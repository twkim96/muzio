package progress

import (
	"errors"
	"testing"
	"time"
)

func TestStoreRoundTrip(t *testing.T) {
	store := NewStoreWithClock(func() time.Time {
		return time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	})

	saved, err := store.Put(Record{
		MediaID:     "m1",
		PositionSec: 42,
		DurationSec: 600,
		Source: &Source{
			MediaType:    "video",
			Name:         "clip.mp4",
			RootName:     "video",
			RelativePath: "clip.mp4",
		},
	})
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if saved.LastPlayedAt.IsZero() {
		t.Fatal("LastPlayedAt was not filled")
	}

	got, err := store.Get("m1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.PositionSec != 42 {
		t.Fatalf("PositionSec = %v, want 42", got.PositionSec)
	}
	if got.Source == nil || got.Source.MediaType != "video" {
		t.Fatalf("Source = %#v", got.Source)
	}
}

func TestStoreKeepsNewerRecordOnConflict(t *testing.T) {
	store := NewStore()
	newer := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	older := newer.Add(-time.Hour)

	if _, err := store.Put(Record{
		MediaID:      "m1",
		PositionSec:  100,
		DurationSec:  600,
		LastPlayedAt: newer,
	}); err != nil {
		t.Fatalf("Put newer: %v", err)
	}
	saved, err := store.Put(Record{
		MediaID:      "m1",
		PositionSec:  10,
		DurationSec:  600,
		LastPlayedAt: older,
	})
	if err != nil {
		t.Fatalf("Put older: %v", err)
	}
	if saved.PositionSec != 100 {
		t.Fatalf("PositionSec = %v, want newer value 100", saved.PositionSec)
	}
}

func TestStoreListsNewestFirst(t *testing.T) {
	store := NewStore()
	base := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	_, _ = store.Put(Record{MediaID: "old", DurationSec: 1, LastPlayedAt: base})
	_, _ = store.Put(Record{MediaID: "new", DurationSec: 1, LastPlayedAt: base.Add(time.Minute)})

	records := store.List()
	if got := records[0].MediaID; got != "new" {
		t.Fatalf("first MediaID = %q, want new", got)
	}
}

func TestStoreRejectsInvalidRecords(t *testing.T) {
	store := NewStore()
	tests := []Record{
		{MediaID: "", PositionSec: 1, DurationSec: 2},
		{MediaID: "bad", PositionSec: -1, DurationSec: 2},
		{
			MediaID:     "bad-source",
			PositionSec: 1,
			DurationSec: 2,
			Source:      &Source{MediaType: "image", Name: "x", RootName: "r", RelativePath: "x"},
		},
	}
	for _, tt := range tests {
		if _, err := store.Put(tt); !errors.Is(err, ErrInvalid) {
			t.Fatalf("Put(%#v) err = %v, want ErrInvalid", tt, err)
		}
	}
}

func TestStoreReturnsSourceCopies(t *testing.T) {
	store := NewStore()
	saved, err := store.Put(Record{
		MediaID:     "m1",
		DurationSec: 1,
		Source: &Source{
			MediaType:    "audio",
			Name:         "song.mp3",
			RootName:     "music",
			RelativePath: "song.mp3",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	saved.Source.Name = "mutated.mp3"

	got, err := store.Get("m1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Source == nil || got.Source.Name != "song.mp3" {
		t.Fatalf("stored source = %#v", got.Source)
	}
}
