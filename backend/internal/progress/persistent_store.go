package progress

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	progressSchemaVersion      = 1
	defaultProgressQuietWindow = 2 * time.Second
	maxProgressRetryDelay      = 30 * time.Second
)

var (
	ErrPersistenceCorrupt = errors.New("progress: persistent store corrupt")
	ErrStoreClosed        = errors.New("progress: store closed")
)

type progressDocument struct {
	Version int      `json:"version"`
	Records []Record `json:"records"`
}

type persistentStoreOptions struct {
	quietWindow time.Duration
	writeFile   func(string, []byte) error
}

type PersistentStore struct {
	store       *Store
	path        string
	quietWindow time.Duration
	writeFile   func(string, []byte) error

	lifecycleMu sync.RWMutex
	closing     bool
	generation  atomic.Uint64
	dirty       chan struct{}
	closeOnce   sync.Once
	closeSignal chan struct{}
	closeDone   chan struct{}

	errorMu   sync.RWMutex
	lastError error
	closeErr  error
}

func OpenPersistentStore(path string) (*PersistentStore, error) {
	return openPersistentStore(path, persistentStoreOptions{})
}

func openPersistentStore(path string, options persistentStoreOptions) (*PersistentStore, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("progress path is required")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve progress path: %w", err)
	}
	quietWindow := options.quietWindow
	if quietWindow <= 0 {
		quietWindow = defaultProgressQuietWindow
	}
	writeFile := options.writeFile
	if writeFile == nil {
		writeFile = atomicWriteProgressFile
	}

	memoryStore := NewStore()
	loadErr := loadProgressRecords(absolute, memoryStore)
	if loadErr != nil && !errors.Is(loadErr, ErrPersistenceCorrupt) {
		return nil, loadErr
	}
	persistent := &PersistentStore{
		store:       memoryStore,
		path:        absolute,
		quietWindow: quietWindow,
		writeFile:   writeFile,
		dirty:       make(chan struct{}, 1),
		closeSignal: make(chan struct{}),
		closeDone:   make(chan struct{}),
	}
	go persistent.runWriter()
	if errors.Is(loadErr, ErrPersistenceCorrupt) {
		persistent.markDirty()
	}
	return persistent, loadErr
}

func (s *PersistentStore) List() []Record {
	return s.store.List()
}

func (s *PersistentStore) Get(mediaID string) (Record, error) {
	return s.store.Get(mediaID)
}

func (s *PersistentStore) Put(record Record) (Record, error) {
	s.lifecycleMu.RLock()
	defer s.lifecycleMu.RUnlock()
	if s.closing {
		return Record{}, ErrStoreClosed
	}
	saved, err := s.store.Put(record)
	if err != nil {
		return Record{}, err
	}
	s.markDirty()
	return saved, nil
}

func (s *PersistentStore) Delete(mediaID string) {
	if strings.TrimSpace(mediaID) == "" {
		return
	}
	s.lifecycleMu.RLock()
	defer s.lifecycleMu.RUnlock()
	if s.closing {
		return
	}
	s.store.Delete(mediaID)
	s.markDirty()
}

func (s *PersistentStore) Close() error {
	return s.CloseContext(context.Background())
}

func (s *PersistentStore) CloseContext(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	s.closeOnce.Do(func() {
		s.lifecycleMu.Lock()
		s.closing = true
		close(s.closeSignal)
		s.lifecycleMu.Unlock()
	})
	select {
	case <-s.closeDone:
		s.errorMu.RLock()
		defer s.errorMu.RUnlock()
		return s.closeErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *PersistentStore) LastError() error {
	s.errorMu.RLock()
	defer s.errorMu.RUnlock()
	return s.lastError
}

func (s *PersistentStore) markDirty() {
	s.generation.Add(1)
	select {
	case s.dirty <- struct{}{}:
	default:
	}
}

func (s *PersistentStore) runWriter() {
	defer close(s.closeDone)

	var timer *time.Timer
	var timerC <-chan time.Time
	var persistedGeneration uint64
	retryDelay := s.quietWindow
	maxRetryDelay := maxProgressRetryDelay
	if retryDelay > maxRetryDelay {
		maxRetryDelay = retryDelay
	}
	resetTimer := func(delay time.Duration) {
		if timer == nil {
			timer = time.NewTimer(delay)
		} else {
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(delay)
		}
		timerC = timer.C
	}
	stopTimer := func() {
		if timer != nil && !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timerC = nil
	}

	for {
		select {
		case <-s.dirty:
			retryDelay = s.quietWindow
			resetTimer(s.quietWindow)
		case <-timerC:
			timerC = nil
			generation, err := s.flush()
			s.setLastError(err)
			if err == nil {
				persistedGeneration = generation
				retryDelay = s.quietWindow
				continue
			}
			resetTimer(retryDelay)
			retryDelay = min(retryDelay*2, maxRetryDelay)
		case <-s.closeSignal:
			stopTimer()
			var err error
			if s.generation.Load() != persistedGeneration {
				_, err = s.flush()
				s.setLastError(err)
			}
			s.errorMu.Lock()
			s.closeErr = err
			s.errorMu.Unlock()
			return
		}
	}
}

func (s *PersistentStore) flush() (uint64, error) {
	generation := s.generation.Load()
	document := progressDocument{
		Version: progressSchemaVersion,
		Records: s.store.List(),
	}
	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return generation, fmt.Errorf("encode progress store: %w", err)
	}
	data = append(data, '\n')
	if err := s.writeFile(s.path, data); err != nil {
		return generation, fmt.Errorf("write progress store: %w", err)
	}
	return generation, nil
}

func (s *PersistentStore) setLastError(err error) {
	s.errorMu.Lock()
	s.lastError = err
	s.errorMu.Unlock()
}

func loadProgressRecords(path string, store *Store) error {
	data, err := readProgressFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	records, err := decodeProgressDocument(data)
	if err != nil {
		return err
	}
	for _, record := range records {
		if _, err := store.Put(record); err != nil {
			return fmt.Errorf("%w: invalid record: %v", ErrPersistenceCorrupt, err)
		}
	}
	return nil
}

func readProgressFile(path string) ([]byte, error) {
	current, currentErr := os.ReadFile(path)
	if currentErr == nil && validProgressDocument(current) {
		if _, err := os.Stat(path + ".bak"); err == nil {
			_ = os.Remove(path + ".bak")
			_ = syncProgressDirectory(filepath.Dir(path))
		}
		return current, nil
	}

	backupPath := path + ".bak"
	backup, backupErr := os.ReadFile(backupPath)
	if backupErr == nil && validProgressDocument(backup) {
		_ = os.Remove(path)
		if err := os.Rename(backupPath, path); err != nil {
			return nil, fmt.Errorf("recover progress backup: %w", err)
		}
		if err := syncProgressDirectory(filepath.Dir(path)); err != nil {
			return nil, fmt.Errorf("sync recovered progress backup: %w", err)
		}
		return backup, nil
	}

	if currentErr == nil {
		return current, nil
	}
	if !errors.Is(currentErr, os.ErrNotExist) {
		return nil, fmt.Errorf("read progress store: %w", currentErr)
	}
	if backupErr != nil && !errors.Is(backupErr, os.ErrNotExist) {
		return nil, fmt.Errorf("read progress backup: %w", backupErr)
	}
	if backupErr == nil {
		return backup, fmt.Errorf("%w: invalid backup", ErrPersistenceCorrupt)
	}
	return nil, os.ErrNotExist
}

func validProgressDocument(data []byte) bool {
	_, err := decodeProgressDocument(data)
	return err == nil
}

func decodeProgressDocument(data []byte) ([]Record, error) {
	var document progressDocument
	if err := json.Unmarshal(data, &document); err != nil {
		return nil, fmt.Errorf("%w: decode document: %v", ErrPersistenceCorrupt, err)
	}
	if document.Version != progressSchemaVersion {
		return nil, fmt.Errorf("%w: unsupported version %d", ErrPersistenceCorrupt, document.Version)
	}
	validator := NewStore()
	for _, record := range document.Records {
		if _, err := validator.Put(record); err != nil {
			return nil, fmt.Errorf("%w: invalid record: %v", ErrPersistenceCorrupt, err)
		}
	}
	return validator.List(), nil
}

func atomicWriteProgressFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create progress directory: %w", err)
	}
	temp, err := os.CreateTemp(dir, ".progress-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}

	backupPath := path + ".bak"
	_ = os.Remove(backupPath)
	hadCurrent := false
	if _, err := os.Stat(path); err == nil {
		if err := os.Rename(path, backupPath); err != nil {
			return err
		}
		hadCurrent = true
		if err := syncProgressDirectory(dir); err != nil {
			_ = os.Rename(backupPath, path)
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		if hadCurrent {
			_ = os.Rename(backupPath, path)
		}
		return err
	}
	if err := syncProgressDirectory(dir); err != nil {
		_ = os.Remove(path)
		if hadCurrent {
			_ = os.Rename(backupPath, path)
		}
		return err
	}
	_ = os.Remove(backupPath)
	return syncProgressDirectory(dir)
}

func syncProgressDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	syncErr := dir.Sync()
	closeErr := dir.Close()
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}
