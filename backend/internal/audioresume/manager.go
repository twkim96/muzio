package audioresume

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"muzio/backend/internal/library"
)

const (
	stateFileName       = "current.json"
	stateBackupFileName = "current.json.bak"
)

var ErrUnsupported = errors.New("audio resume cache only supports AAC audio")

type Resolver interface {
	ResolveStrict(rootName, relativePath string) (string, error)
}

type Remuxer interface {
	Remux(context.Context, string, string) error
}

type Status struct {
	State           string `json:"state"`
	MediaID         string `json:"mediaId,omitempty"`
	URL             string `json:"url,omitempty"`
	BuildingMediaID string `json:"buildingMediaId,omitempty"`
}

type cacheEntry struct {
	MediaID       string    `json:"mediaId"`
	SourceSize    int64     `json:"sourceSize"`
	SourceModTime time.Time `json:"sourceModifiedAt"`
	FileName      string    `json:"fileName"`
}

type candidate struct {
	item       library.Media
	sourcePath string
	size       int64
	modTime    time.Time
	fileName   string
}

type Manager struct {
	cacheDir string
	resolver Resolver
	remuxer  Remuxer
	logger   *slog.Logger
	timeout  time.Duration

	mu         sync.Mutex
	current    *cacheEntry
	buildingID string
	generation uint64
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

type Options struct {
	CacheDir string
	Resolver Resolver
	Remuxer  Remuxer
	Logger   *slog.Logger
	Timeout  time.Duration
}

func NewManager(options Options) (*Manager, error) {
	if strings.TrimSpace(options.CacheDir) == "" {
		return nil, errors.New("audio resume cache: cache directory is required")
	}
	if options.Resolver == nil {
		return nil, errors.New("audio resume cache: resolver is required")
	}
	if options.Remuxer == nil {
		return nil, errors.New("audio resume cache: remuxer is required")
	}
	if err := os.MkdirAll(options.CacheDir, 0o755); err != nil {
		return nil, fmt.Errorf("audio resume cache: create directory: %w", err)
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	m := &Manager{
		cacheDir: options.CacheDir,
		resolver: options.Resolver,
		remuxer:  options.Remuxer,
		logger:   logger,
		timeout:  timeout,
	}
	m.current = loadEntry(options.CacheDir)
	m.cleanupStaleFiles()
	return m, nil
}

func (m *Manager) Request(item library.Media) (Status, error) {
	c, err := m.candidateFor(item)
	if err != nil {
		return m.Status(), err
	}

	m.mu.Lock()
	if entryMatches(m.current, c) && regularFile(filepath.Join(m.cacheDir, m.current.FileName)) {
		status := m.statusLocked()
		m.mu.Unlock()
		return status, nil
	}
	if m.buildingID == item.ID {
		status := m.statusLocked()
		m.mu.Unlock()
		return status, nil
	}
	if m.cancel != nil {
		m.cancel()
	}
	m.generation++
	generation := m.generation
	ctx, cancel := context.WithTimeout(context.Background(), m.timeout)
	m.cancel = cancel
	m.buildingID = item.ID
	status := m.statusLocked()
	m.wg.Add(1)
	m.mu.Unlock()

	go m.build(ctx, generation, c)
	return status, nil
}

func (m *Manager) Ready(item library.Media) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current == nil || m.current.MediaID != item.ID ||
		m.current.SourceSize != item.SizeBytes ||
		!m.current.SourceModTime.Equal(item.ModifiedAt) {
		return "", false
	}
	path := filepath.Join(m.cacheDir, m.current.FileName)
	return path, regularFile(path)
}

func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.statusLocked()
}

func (m *Manager) Close() {
	m.mu.Lock()
	if m.cancel != nil {
		m.cancel()
	}
	m.generation++
	m.mu.Unlock()
	m.wg.Wait()
}

func (m *Manager) build(ctx context.Context, generation uint64, c candidate) {
	defer m.wg.Done()
	temp, err := os.CreateTemp(m.cacheDir, ".remux-*.m4a.tmp")
	if err != nil {
		m.finishFailure(generation, c.item.ID, err)
		return
	}
	tempPath := temp.Name()
	_ = temp.Close()
	_ = os.Remove(tempPath)
	defer os.Remove(tempPath)

	err = m.remuxer.Remux(ctx, c.sourcePath, tempPath)
	if err == nil && !regularFile(tempPath) {
		err = errors.New("remux output is empty")
	}
	if err != nil {
		m.finishFailure(generation, c.item.ID, err)
		return
	}

	finalPath := filepath.Join(m.cacheDir, c.fileName)
	if err := os.Rename(tempPath, finalPath); err != nil {
		m.finishFailure(generation, c.item.ID, err)
		return
	}
	next := &cacheEntry{
		MediaID:       c.item.ID,
		SourceSize:    c.size,
		SourceModTime: c.modTime,
		FileName:      c.fileName,
	}

	m.mu.Lock()
	if generation != m.generation || m.buildingID != c.item.ID {
		m.mu.Unlock()
		_ = os.Remove(finalPath)
		return
	}
	if err := writeEntry(m.cacheDir, next); err != nil {
		m.buildingID = ""
		m.cancel = nil
		m.mu.Unlock()
		_ = os.Remove(finalPath)
		m.logger.Warn("audio resume cache metadata failed", "id", c.item.ID, "error", err)
		return
	}
	previous := m.current
	m.current = next
	m.buildingID = ""
	m.cancel = nil
	m.mu.Unlock()

	if previous != nil && previous.FileName != next.FileName {
		_ = os.Remove(filepath.Join(m.cacheDir, previous.FileName))
	}
	m.cleanupCacheFiles(next.FileName)
	m.logger.Info("audio resume cache ready", "id", c.item.ID, "bytes", fileSize(finalPath))
}

func (m *Manager) finishFailure(generation uint64, mediaID string, err error) {
	m.mu.Lock()
	if generation != m.generation || m.buildingID != mediaID {
		m.mu.Unlock()
		return
	}
	m.buildingID = ""
	m.cancel = nil
	m.mu.Unlock()
	if !errors.Is(err, context.Canceled) {
		m.logger.Warn("audio resume cache build failed", "id", mediaID, "error", err)
	}
}

func (m *Manager) candidateFor(item library.Media) (candidate, error) {
	if item.Type != library.MediaTypeAudio || strings.ToLower(filepath.Ext(item.Name)) != ".aac" {
		return candidate{}, ErrUnsupported
	}
	path, err := m.resolver.ResolveStrict(item.RootName, item.RelativePath)
	if err != nil {
		return candidate{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return candidate{}, err
	}
	if !info.Mode().IsRegular() {
		return candidate{}, errors.New("audio resume cache source is not a regular file")
	}
	fingerprint := sha256.Sum256([]byte(fmt.Sprintf("%s|%d|%d", item.ID, info.Size(), info.ModTime().UnixNano())))
	return candidate{
		item:       item,
		sourcePath: path,
		size:       info.Size(),
		modTime:    info.ModTime(),
		fileName:   "audio-" + hex.EncodeToString(fingerprint[:8]) + ".m4a",
	}, nil
}

func (m *Manager) statusLocked() Status {
	status := Status{State: "empty", BuildingMediaID: m.buildingID}
	if m.current != nil && regularFile(filepath.Join(m.cacheDir, m.current.FileName)) {
		status.State = "ready"
		status.MediaID = m.current.MediaID
		status.URL = "/api/audio-resume-cache/media/" + m.current.MediaID
	}
	if status.State == "empty" && m.buildingID != "" {
		status.State = "building"
	}
	return status
}

func (m *Manager) cleanupStaleFiles() {
	keep := ""
	if m.current != nil {
		keep = m.current.FileName
	}
	m.cleanupCacheFiles(keep)
}

func (m *Manager) cleanupCacheFiles(keep string) {
	entries, _ := os.ReadDir(m.cacheDir)
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || name == stateFileName || name == stateBackupFileName || name == keep {
			continue
		}
		if strings.HasPrefix(name, ".remux-") || strings.HasSuffix(name, ".m4a") {
			_ = os.Remove(filepath.Join(m.cacheDir, name))
		}
	}
}

func entryMatches(entry *cacheEntry, c candidate) bool {
	return entry != nil && entry.MediaID == c.item.ID && entry.SourceSize == c.size && entry.SourceModTime.Equal(c.modTime)
}

func loadEntry(dir string) *cacheEntry {
	statePath := filepath.Join(dir, stateFileName)
	if entry := loadEntryFile(dir, statePath); entry != nil {
		_ = os.Remove(filepath.Join(dir, stateBackupFileName))
		return entry
	}
	backupPath := filepath.Join(dir, stateBackupFileName)
	entry := loadEntryFile(dir, backupPath)
	if entry == nil {
		return nil
	}
	_ = os.Remove(statePath)
	_ = os.Rename(backupPath, statePath)
	return entry
}

func loadEntryFile(dir, path string) *cacheEntry {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var entry cacheEntry
	if json.Unmarshal(data, &entry) != nil || entry.MediaID == "" || entry.FileName == "" {
		return nil
	}
	if !regularFile(filepath.Join(dir, entry.FileName)) {
		return nil
	}
	return &entry
}

func writeEntry(dir string, entry *cacheEntry) error {
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, ".current-*.json.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0o600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(append(data, '\n')); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	statePath := filepath.Join(dir, stateFileName)
	backupPath := filepath.Join(dir, stateBackupFileName)
	_ = os.Remove(backupPath)
	hadCurrent := false
	if _, err := os.Stat(statePath); err == nil {
		if err := os.Rename(statePath, backupPath); err != nil {
			return err
		}
		hadCurrent = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(tempPath, statePath); err != nil {
		if hadCurrent {
			_ = os.Rename(backupPath, statePath)
		}
		return err
	}
	_ = os.Remove(backupPath)
	return nil
}

func regularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}
