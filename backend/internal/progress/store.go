package progress

import (
	"errors"
	"math"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	ErrNotFound = errors.New("progress record not found")
	ErrInvalid  = errors.New("invalid progress record")
)

type Source struct {
	MediaType    string `json:"mediaType"`
	Name         string `json:"name"`
	RootName     string `json:"rootName"`
	RelativePath string `json:"relativePath"`
}

type Record struct {
	MediaID      string    `json:"mediaId"`
	PositionSec  float64   `json:"positionSec"`
	DurationSec  float64   `json:"durationSec"`
	LastPlayedAt time.Time `json:"lastPlayedAt"`
	Completed    bool      `json:"completed"`
	Source       *Source   `json:"source,omitempty"`
}

type Store struct {
	mu      sync.RWMutex
	records map[string]Record
	now     func() time.Time
}

func NewStore() *Store {
	return NewStoreWithClock(time.Now)
}

func NewStoreWithClock(now func() time.Time) *Store {
	if now == nil {
		now = time.Now
	}
	return &Store{
		records: make(map[string]Record),
		now:     now,
	}
}

func (s *Store) List() []Record {
	s.mu.RLock()
	defer s.mu.RUnlock()

	records := make([]Record, 0, len(s.records))
	for _, record := range s.records {
		records = append(records, cloneRecord(record))
	}
	sort.Slice(records, func(i, j int) bool {
		left := records[i]
		right := records[j]
		if left.LastPlayedAt.Equal(right.LastPlayedAt) {
			return left.MediaID < right.MediaID
		}
		return left.LastPlayedAt.After(right.LastPlayedAt)
	})
	return records
}

func (s *Store) Get(mediaID string) (Record, error) {
	mediaID = strings.TrimSpace(mediaID)
	if mediaID == "" {
		return Record{}, ErrNotFound
	}

	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.records[mediaID]
	if !ok {
		return Record{}, ErrNotFound
	}
	return cloneRecord(record), nil
}

func (s *Store) Put(record Record) (Record, error) {
	normalized, err := s.normalize(record)
	if err != nil {
		return Record{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.records[normalized.MediaID]
	if ok && current.LastPlayedAt.After(normalized.LastPlayedAt) {
		return cloneRecord(current), nil
	}
	s.records[normalized.MediaID] = normalized
	return cloneRecord(normalized), nil
}

func (s *Store) Delete(mediaID string) {
	mediaID = strings.TrimSpace(mediaID)
	if mediaID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.records, mediaID)
}

func (s *Store) normalize(record Record) (Record, error) {
	record.MediaID = strings.TrimSpace(record.MediaID)
	if record.MediaID == "" {
		return Record{}, ErrInvalid
	}
	if !validSeconds(record.PositionSec) || !validSeconds(record.DurationSec) {
		return Record{}, ErrInvalid
	}
	if record.DurationSec > 0 && record.PositionSec > record.DurationSec {
		record.PositionSec = record.DurationSec
	}
	if record.LastPlayedAt.IsZero() {
		record.LastPlayedAt = s.now()
	}
	record.LastPlayedAt = record.LastPlayedAt.UTC()
	if record.Source != nil {
		source := *record.Source
		source.MediaType = strings.TrimSpace(source.MediaType)
		source.Name = strings.TrimSpace(source.Name)
		source.RootName = strings.TrimSpace(source.RootName)
		source.RelativePath = strings.TrimSpace(source.RelativePath)
		if source.MediaType != "audio" && source.MediaType != "video" {
			return Record{}, ErrInvalid
		}
		if source.Name == "" || source.RootName == "" || source.RelativePath == "" {
			return Record{}, ErrInvalid
		}
		record.Source = &source
	}
	return record, nil
}

func validSeconds(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0
}

func cloneRecord(record Record) Record {
	if record.Source != nil {
		source := *record.Source
		record.Source = &source
	}
	return record
}
