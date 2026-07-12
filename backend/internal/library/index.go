package library

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const (
	indexSchemaVersion  = 1
	indexFrameHeaderLen = 8
	indexMaxFrameSize   = 64 << 20

	defaultIndexCompactBatchLimit = 256
	defaultIndexCompactSizeLimit  = 32 << 20
)

var ErrIndexCorrupt = errors.New("library: persistent index corrupt")

type IndexState struct {
	Items          []Media
	Revision       uint64
	LastVerifiedAt time.Time
}

type indexHeader struct {
	Kind        string            `json:"kind"`
	Schema      int               `json:"schema"`
	Fingerprint string            `json:"fingerprint"`
	Settings    MediaRootSettings `json:"settings"`
}

type indexBatch struct {
	Kind           string    `json:"kind"`
	Revision       uint64    `json:"revision"`
	Upserts        []Media   `json:"upserts,omitempty"`
	DeletedIDs     []string  `json:"deletedIds,omitempty"`
	VerifiedAt     time.Time `json:"verifiedAt,omitempty"`
	FullCheckpoint bool      `json:"fullCheckpoint,omitempty"`
}

type PersistentIndex struct {
	mu             sync.Mutex
	path           string
	settings       MediaRootSettings
	fingerprint    string
	batchCount     int
	sizeBytes      int64
	checkpointSize int64
}

func OpenPersistentIndex(path string, settings MediaRootSettings) (*PersistentIndex, IndexState, error) {
	normalized := NormalizeMediaRootSettings(settings)
	path = filepath.Clean(path)
	fingerprint := mediaRootSettingsFingerprint(normalized)
	if err := recoverIndexBackup(path, fingerprint); err != nil {
		return nil, IndexState{}, err
	}
	index := &PersistentIndex{
		path:        path,
		settings:    normalized,
		fingerprint: fingerprint,
	}
	state, err := index.load()
	if err == nil {
		return index, state, nil
	}
	if !errors.Is(err, os.ErrNotExist) &&
		!errors.Is(err, ErrIndexCorrupt) &&
		!errors.Is(err, errIndexSettingsMismatch) {
		return nil, IndexState{}, err
	}
	if resetErr := index.Reset(normalized, nil, 0, time.Time{}); resetErr != nil {
		return nil, IndexState{}, resetErr
	}
	return index, IndexState{}, err
}

var errIndexSettingsMismatch = errors.New("library: persistent index settings mismatch")

func (i *PersistentIndex) load() (IndexState, error) {
	i.mu.Lock()
	defer i.mu.Unlock()

	file, err := os.OpenFile(i.path, os.O_RDWR, 0o600)
	if err != nil {
		return IndexState{}, err
	}
	defer file.Close()

	payload, complete, err := readIndexFrame(file)
	if err != nil {
		return IndexState{}, err
	}
	if !complete {
		return IndexState{}, fmt.Errorf("%w: missing header", ErrIndexCorrupt)
	}
	var header indexHeader
	if err := json.Unmarshal(payload, &header); err != nil {
		return IndexState{}, fmt.Errorf("%w: decode header: %v", ErrIndexCorrupt, err)
	}
	if header.Kind != "header" || header.Schema != indexSchemaVersion {
		return IndexState{}, fmt.Errorf("%w: unsupported schema", ErrIndexCorrupt)
	}
	if header.Fingerprint != i.fingerprint {
		return IndexState{}, errIndexSettingsMismatch
	}

	items := make(map[string]Media)
	var state IndexState
	lastValidOffset, err := file.Seek(0, io.SeekCurrent)
	if err != nil {
		return IndexState{}, fmt.Errorf("seek persistent index: %w", err)
	}
	batchCount := 0
	checkpointSize := lastValidOffset
	for {
		payload, complete, err = readIndexFrame(file)
		if err != nil {
			return IndexState{}, err
		}
		if !complete {
			currentOffset, seekErr := file.Seek(0, io.SeekCurrent)
			if seekErr != nil {
				return IndexState{}, fmt.Errorf("seek persistent index: %w", seekErr)
			}
			if currentOffset != lastValidOffset {
				if err := file.Truncate(lastValidOffset); err != nil {
					return IndexState{}, fmt.Errorf("truncate interrupted persistent index tail: %w", err)
				}
				if err := file.Sync(); err != nil {
					return IndexState{}, fmt.Errorf("sync repaired persistent index: %w", err)
				}
			}
			break
		}
		var batch indexBatch
		if err := json.Unmarshal(payload, &batch); err != nil {
			return IndexState{}, fmt.Errorf("%w: decode batch: %v", ErrIndexCorrupt, err)
		}
		if batch.Kind != "batch" || batch.Revision < state.Revision {
			return IndexState{}, fmt.Errorf("%w: invalid batch", ErrIndexCorrupt)
		}
		if batch.FullCheckpoint {
			clear(items)
		}
		for _, id := range batch.DeletedIDs {
			delete(items, id)
		}
		for _, item := range batch.Upserts {
			if item.ID != "" {
				items[item.ID] = cloneMedia(item)
			}
		}
		state.Revision = batch.Revision
		if !batch.VerifiedAt.IsZero() {
			state.LastVerifiedAt = batch.VerifiedAt
		}
		batchCount++
		lastValidOffset, err = file.Seek(0, io.SeekCurrent)
		if err != nil {
			return IndexState{}, fmt.Errorf("seek persistent index: %w", err)
		}
		if batch.FullCheckpoint {
			checkpointSize = lastValidOffset
			batchCount = 0
		}
	}
	state.Items = make([]Media, 0, len(items))
	for _, item := range items {
		state.Items = append(state.Items, item)
	}
	sortMedia(state.Items)
	i.batchCount = batchCount
	i.sizeBytes = lastValidOffset
	i.checkpointSize = checkpointSize
	return state, nil
}

func (i *PersistentIndex) Append(
	revision uint64,
	upserts []Media,
	deletedIDs []string,
	verifiedAt time.Time,
) error {
	if len(upserts) == 0 && len(deletedIDs) == 0 && verifiedAt.IsZero() {
		return nil
	}
	i.mu.Lock()
	defer i.mu.Unlock()

	file, err := os.OpenFile(i.path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("open persistent index: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("stat persistent index: %w", err)
	}
	rollback := func() {
		_ = file.Truncate(info.Size())
	}
	batch := indexBatch{
		Kind:       "batch",
		Revision:   revision,
		Upserts:    cloneMediaSlice(upserts),
		DeletedIDs: append([]string(nil), deletedIDs...),
		VerifiedAt: verifiedAt,
	}
	if err := writeIndexFrame(file, batch); err != nil {
		rollback()
		return err
	}
	if err := file.Sync(); err != nil {
		rollback()
		return fmt.Errorf("sync persistent index: %w", err)
	}
	info, err = file.Stat()
	if err != nil {
		return fmt.Errorf("stat appended persistent index: %w", err)
	}
	i.batchCount++
	i.sizeBytes = info.Size()
	return nil
}

func (i *PersistentIndex) Reset(
	settings MediaRootSettings,
	items []Media,
	revision uint64,
	verifiedAt time.Time,
) error {
	return i.reset(settings, items, revision, verifiedAt, false, false)
}

func (i *PersistentIndex) PrepareReset(
	settings MediaRootSettings,
	items []Media,
	revision uint64,
	verifiedAt time.Time,
) error {
	return i.reset(settings, items, revision, verifiedAt, true, false)
}

// resetOwned persists items without cloning them. The caller must own the
// complete slice and every nested mutable field until this call returns.
func (i *PersistentIndex) resetOwned(
	settings MediaRootSettings,
	items []Media,
	revision uint64,
	verifiedAt time.Time,
	keepBackup bool,
) error {
	return i.reset(settings, items, revision, verifiedAt, keepBackup, true)
}

func (i *PersistentIndex) reset(
	settings MediaRootSettings,
	items []Media,
	revision uint64,
	verifiedAt time.Time,
	keepBackup bool,
	itemsOwned bool,
) error {
	i.mu.Lock()
	defer i.mu.Unlock()

	normalized := NormalizeMediaRootSettings(settings)
	fingerprint := mediaRootSettingsFingerprint(normalized)
	if err := os.MkdirAll(filepath.Dir(i.path), 0o700); err != nil {
		return fmt.Errorf("create persistent index directory: %w", err)
	}
	temp, err := os.CreateTemp(filepath.Dir(i.path), ".library-index-*.tmp")
	if err != nil {
		return fmt.Errorf("create persistent index: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)

	header := indexHeader{
		Kind:        "header",
		Schema:      indexSchemaVersion,
		Fingerprint: fingerprint,
		Settings:    normalized,
	}
	if err := writeIndexFrame(temp, header); err != nil {
		temp.Close()
		return err
	}
	if len(items) > 0 || revision > 0 || !verifiedAt.IsZero() {
		checkpointItems := items
		if !itemsOwned {
			checkpointItems = cloneMediaSlice(items)
		}
		if err := writeIndexFrame(temp, indexBatch{
			Kind:           "batch",
			Revision:       revision,
			Upserts:        checkpointItems,
			VerifiedAt:     verifiedAt,
			FullCheckpoint: true,
		}); err != nil {
			temp.Close()
			return err
		}
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return fmt.Errorf("sync persistent index: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close persistent index: %w", err)
	}
	if err := os.Chmod(tempPath, 0o600); err != nil {
		return fmt.Errorf("chmod persistent index: %w", err)
	}
	backupPath := i.path + ".bak"
	_ = os.Remove(backupPath)
	hadCurrent := false
	if _, err := os.Stat(i.path); err == nil {
		if err := os.Rename(i.path, backupPath); err != nil {
			return fmt.Errorf("backup persistent index: %w", err)
		}
		hadCurrent = true
		if err := syncIndexDirectory(filepath.Dir(i.path)); err != nil {
			_ = os.Rename(backupPath, i.path)
			return fmt.Errorf("sync persistent index backup: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("stat persistent index: %w", err)
	}
	if err := os.Rename(tempPath, i.path); err != nil {
		if hadCurrent {
			_ = os.Rename(backupPath, i.path)
		}
		return fmt.Errorf("replace persistent index: %w", err)
	}
	if err := syncIndexDirectory(filepath.Dir(i.path)); err != nil {
		_ = os.Remove(i.path)
		if hadCurrent {
			_ = os.Rename(backupPath, i.path)
		}
		return fmt.Errorf("sync replaced persistent index: %w", err)
	}
	if !keepBackup {
		_ = os.Remove(backupPath)
		if err := syncIndexDirectory(filepath.Dir(i.path)); err != nil {
			return fmt.Errorf("sync persistent index cleanup: %w", err)
		}
	}
	i.settings = normalized
	i.fingerprint = fingerprint
	i.batchCount = 0
	if len(items) > 0 || revision > 0 || !verifiedAt.IsZero() {
		i.batchCount = 1
	}
	if info, err := os.Stat(i.path); err == nil {
		i.sizeBytes = info.Size()
		i.checkpointSize = info.Size()
	}
	return nil
}

func (i *PersistentIndex) CommitPreparedReset() error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if err := os.Remove(i.path + ".bak"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("commit persistent index reset: %w", err)
	}
	if err := syncIndexDirectory(filepath.Dir(i.path)); err != nil {
		return fmt.Errorf("sync persistent index commit: %w", err)
	}
	return nil
}

func (i *PersistentIndex) RollbackPreparedReset() error {
	i.mu.Lock()
	backupPath := i.path + ".bak"
	if _, err := os.Stat(backupPath); err != nil {
		i.mu.Unlock()
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("stat persistent index backup: %w", err)
	}
	if err := os.Remove(i.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		i.mu.Unlock()
		return fmt.Errorf("remove prepared persistent index: %w", err)
	}
	if err := os.Rename(backupPath, i.path); err != nil {
		i.mu.Unlock()
		return fmt.Errorf("rollback persistent index reset: %w", err)
	}
	if err := syncIndexDirectory(filepath.Dir(i.path)); err != nil {
		i.mu.Unlock()
		return fmt.Errorf("sync persistent index rollback: %w", err)
	}
	header, err := readIndexHeader(i.path)
	if err != nil {
		i.mu.Unlock()
		return err
	}
	i.settings = NormalizeMediaRootSettings(header.Settings)
	i.fingerprint = header.Fingerprint
	i.mu.Unlock()
	_, err = i.load()
	return err
}

func syncIndexDirectory(path string) error {
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

func (i *PersistentIndex) NeedsCompaction() bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	sizeLimit := int64(defaultIndexCompactSizeLimit)
	if doubled := i.checkpointSize * 2; doubled > sizeLimit {
		sizeLimit = doubled
	}
	return i.batchCount >= defaultIndexCompactBatchLimit || i.sizeBytes >= sizeLimit
}

func (i *PersistentIndex) Compact() error {
	state, err := i.load()
	if err != nil {
		return err
	}
	i.mu.Lock()
	settings := cloneSettings(i.settings)
	i.mu.Unlock()
	return i.Reset(
		settings,
		state.Items,
		state.Revision,
		state.LastVerifiedAt,
	)
}

func recoverIndexBackup(path, expectedFingerprint string) error {
	backupPath := path + ".bak"
	_, currentErr := os.Stat(path)
	_, backupErr := os.Stat(backupPath)
	if currentErr == nil && backupErr == nil {
		switch {
		case indexFileMatches(path, expectedFingerprint):
			_ = os.Remove(backupPath)
			return syncIndexDirectory(filepath.Dir(path))
		case indexFileMatches(backupPath, expectedFingerprint):
			if err := os.Remove(path); err != nil {
				return fmt.Errorf("remove uncommitted persistent index: %w", err)
			}
			if err := os.Rename(backupPath, path); err != nil {
				return fmt.Errorf("recover persistent index backup: %w", err)
			}
			return syncIndexDirectory(filepath.Dir(path))
		default:
			_ = os.Remove(backupPath)
			return nil
		}
	}
	if currentErr == nil {
		return nil
	}
	if !errors.Is(currentErr, os.ErrNotExist) {
		return fmt.Errorf("stat persistent index: %w", currentErr)
	}
	if backupErr == nil {
		if err := os.Rename(backupPath, path); err != nil {
			return fmt.Errorf("recover persistent index backup: %w", err)
		}
		if err := syncIndexDirectory(filepath.Dir(path)); err != nil {
			return fmt.Errorf("sync recovered persistent index: %w", err)
		}
	} else if !errors.Is(backupErr, os.ErrNotExist) {
		return fmt.Errorf("stat persistent index backup: %w", backupErr)
	}
	return nil
}

func readIndexHeader(path string) (indexHeader, error) {
	file, err := os.Open(path)
	if err != nil {
		return indexHeader{}, err
	}
	defer file.Close()
	payload, complete, err := readIndexFrame(file)
	if err != nil {
		return indexHeader{}, err
	}
	if !complete {
		return indexHeader{}, fmt.Errorf("%w: missing header", ErrIndexCorrupt)
	}
	var header indexHeader
	if err := json.Unmarshal(payload, &header); err != nil {
		return indexHeader{}, fmt.Errorf("%w: decode header: %v", ErrIndexCorrupt, err)
	}
	return header, nil
}

func indexFileMatches(path, expectedFingerprint string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	payload, complete, err := readIndexFrame(file)
	if err != nil || !complete {
		return false
	}
	var header indexHeader
	if json.Unmarshal(payload, &header) != nil ||
		header.Kind != "header" ||
		header.Schema != indexSchemaVersion ||
		header.Fingerprint != expectedFingerprint {
		return false
	}
	var revision uint64
	for {
		payload, complete, err = readIndexFrame(file)
		if err != nil {
			return false
		}
		if !complete {
			return true
		}
		var batch indexBatch
		if json.Unmarshal(payload, &batch) != nil ||
			batch.Kind != "batch" ||
			batch.Revision < revision {
			return false
		}
		revision = batch.Revision
	}
}

func mediaRootSettingsFingerprint(settings MediaRootSettings) string {
	normalized := NormalizeMediaRootSettings(settings)
	normalize := func(values []string) []string {
		out := make([]string, 0, len(values))
		seen := make(map[string]struct{}, len(values))
		for _, value := range values {
			path, err := normalizeRootPath(value)
			if err != nil {
				path = value
			}
			if _, exists := seen[path]; exists {
				continue
			}
			seen[path] = struct{}{}
			out = append(out, path)
		}
		sort.Strings(out)
		return out
	}
	normalized.AudioRoots = normalize(normalized.AudioRoots)
	normalized.VideoRoots = normalize(normalized.VideoRoots)
	normalized.ImageRoots = normalize(normalized.ImageRoots)
	encoded, _ := json.Marshal(normalized)
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func writeIndexFrame(writer io.Writer, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode persistent index frame: %w", err)
	}
	if len(payload) > indexMaxFrameSize {
		return fmt.Errorf("persistent index frame too large: %d", len(payload))
	}
	header := make([]byte, indexFrameHeaderLen)
	binary.BigEndian.PutUint32(header[:4], uint32(len(payload)))
	binary.BigEndian.PutUint32(header[4:], crc32.ChecksumIEEE(payload))
	if err := writeFull(writer, header); err != nil {
		return fmt.Errorf("write persistent index header: %w", err)
	}
	if err := writeFull(writer, payload); err != nil {
		return fmt.Errorf("write persistent index payload: %w", err)
	}
	return nil
}

func readIndexFrame(reader io.Reader) ([]byte, bool, error) {
	header := make([]byte, indexFrameHeaderLen)
	n, err := io.ReadFull(reader, header)
	if errors.Is(err, io.EOF) && n == 0 {
		return nil, false, nil
	}
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("read persistent index header: %w", err)
	}
	size := binary.BigEndian.Uint32(header[:4])
	if size == 0 || size > indexMaxFrameSize {
		return nil, false, fmt.Errorf("%w: invalid frame size %d", ErrIndexCorrupt, size)
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(reader, payload); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("read persistent index payload: %w", err)
	}
	if crc32.ChecksumIEEE(payload) != binary.BigEndian.Uint32(header[4:]) {
		return nil, false, fmt.Errorf("%w: checksum mismatch", ErrIndexCorrupt)
	}
	return payload, true, nil
}

func writeFull(writer io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := writer.Write(data)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}
