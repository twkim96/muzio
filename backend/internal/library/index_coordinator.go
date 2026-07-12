package library

import (
	"sync"
	"time"
)

type indexCoordinator struct {
	mu     sync.RWMutex
	writer *indexWriter
	status IndexStatus
}

func newIndexCoordinator(writer *indexWriter, status IndexStatus) indexCoordinator {
	return indexCoordinator{writer: writer, status: status}
}

func (c *indexCoordinator) enabled() bool {
	return c.writer != nil
}

func (c *indexCoordinator) currentStatus() IndexStatus {
	c.mu.RLock()
	status := c.status
	c.mu.RUnlock()
	if status.LastVerifiedAt != nil {
		status.LastVerifiedAt = timePointer(*status.LastVerifiedAt)
	}
	if c.writer != nil {
		if err := c.writer.LastError(); err != nil {
			status.LastError = err.Error()
		}
	}
	return status
}

func (c *indexCoordinator) updateSnapshotState(items int, verifiedAt time.Time) {
	c.mu.Lock()
	c.status.LoadedItems = items
	if !verifiedAt.IsZero() {
		c.status.LastVerifiedAt = timePointer(verifiedAt)
	}
	c.mu.Unlock()
}

func (c *indexCoordinator) reset(
	settings MediaRootSettings,
	items []Media,
	revision uint64,
	verifiedAt time.Time,
	prepared bool,
) error {
	if c.writer == nil {
		return nil
	}
	if prepared {
		return c.writer.PrepareReset(settings, items, revision, verifiedAt)
	}
	return c.writer.Reset(settings, items, revision, verifiedAt)
}

func (c *indexCoordinator) finishPreparedReset(rollback bool) error {
	if c.writer == nil {
		return nil
	}
	return c.writer.FinishPreparedReset(rollback)
}

func (c *indexCoordinator) persistChanges(
	snapshot *Snapshot,
	fromRevision uint64,
	settings MediaRootSettings,
	verifiedAt time.Time,
) error {
	if c.writer == nil {
		return nil
	}
	changes := snapshot.ChangesSince(fromRevision, "")
	if changes.ResetRequired {
		return c.writer.Reset(
			settings,
			snapshot.List(""),
			snapshot.Revision(),
			verifiedAt,
		)
	}
	c.writer.Enqueue(indexMutation{
		revision: changes.Revision,
		upserts:  changes.Upserts,
		deleted:  changes.DeletedIDs,
		verified: verifiedAt,
	})
	return nil
}

func (c *indexCoordinator) close() error {
	if c.writer == nil {
		return nil
	}
	return c.writer.Close()
}
