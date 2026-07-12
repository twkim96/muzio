package library

import (
	"errors"
	"sort"
	"sync"
	"time"
)

const (
	defaultIndexQuietWindow = 250 * time.Millisecond
	indexRetryMinDelay      = time.Second
	indexRetryMaxDelay      = time.Minute
)

type indexMutation struct {
	revision uint64
	upserts  []Media
	deleted  []string
	verified time.Time
}

type indexResetRequest struct {
	settings   MediaRootSettings
	items      []Media
	revision   uint64
	verifiedAt time.Time
	prepared   bool
	done       chan error
}

type indexPreparedResetAction struct {
	rollback bool
	done     chan error
}

type indexCloseRequest struct {
	done chan error
}

type indexCheckpoint struct {
	settings   MediaRootSettings
	items      []Media
	revision   uint64
	verifiedAt time.Time
}

type indexCheckpointProvider func(revision uint64) (indexCheckpoint, bool)

type indexWriter struct {
	index      *PersistentIndex
	checkpoint indexCheckpointProvider
	quiet      time.Duration
	events     chan any
	done       chan struct{}
	once       sync.Once
	closeErr   error
	sendMu     sync.RWMutex
	closed     bool
	errMu      sync.RWMutex
	lastErr    error
}

func newIndexWriter(
	index *PersistentIndex,
	quiet time.Duration,
	checkpoint ...indexCheckpointProvider,
) *indexWriter {
	if quiet <= 0 {
		quiet = defaultIndexQuietWindow
	}
	writer := &indexWriter{
		index:  index,
		quiet:  quiet,
		events: make(chan any, 128),
		done:   make(chan struct{}),
	}
	if len(checkpoint) > 0 {
		writer.checkpoint = checkpoint[0]
	}
	go writer.run()
	return writer
}

func (w *indexWriter) Enqueue(mutation indexMutation) {
	if mutation.revision == 0 &&
		len(mutation.upserts) == 0 &&
		len(mutation.deleted) == 0 &&
		mutation.verified.IsZero() {
		return
	}
	w.sendMu.RLock()
	defer w.sendMu.RUnlock()
	if w.closed {
		return
	}
	w.events <- mutation
}

func (w *indexWriter) Reset(
	settings MediaRootSettings,
	items []Media,
	revision uint64,
	verifiedAt time.Time,
) error {
	w.sendMu.RLock()
	defer w.sendMu.RUnlock()
	if w.closed {
		return errors.New("library: persistent index writer closed")
	}
	done := make(chan error, 1)
	w.events <- indexResetRequest{
		settings:   cloneSettings(settings),
		items:      cloneMediaSlice(items),
		revision:   revision,
		verifiedAt: verifiedAt,
		done:       done,
	}
	return <-done
}

func (w *indexWriter) PrepareReset(
	settings MediaRootSettings,
	items []Media,
	revision uint64,
	verifiedAt time.Time,
) error {
	w.sendMu.RLock()
	defer w.sendMu.RUnlock()
	if w.closed {
		return errors.New("library: persistent index writer closed")
	}
	done := make(chan error, 1)
	w.events <- indexResetRequest{
		settings:   cloneSettings(settings),
		items:      cloneMediaSlice(items),
		revision:   revision,
		verifiedAt: verifiedAt,
		prepared:   true,
		done:       done,
	}
	return <-done
}

func (w *indexWriter) FinishPreparedReset(rollback bool) error {
	w.sendMu.RLock()
	defer w.sendMu.RUnlock()
	if w.closed {
		return errors.New("library: persistent index writer closed")
	}
	done := make(chan error, 1)
	w.events <- indexPreparedResetAction{rollback: rollback, done: done}
	return <-done
}

func (w *indexWriter) Close() error {
	w.once.Do(func() {
		w.sendMu.Lock()
		w.closed = true
		done := make(chan error, 1)
		w.events <- indexCloseRequest{done: done}
		w.sendMu.Unlock()
		w.closeErr = <-done
		<-w.done
	})
	return w.closeErr
}

func (w *indexWriter) LastError() error {
	w.errMu.RLock()
	defer w.errMu.RUnlock()
	return w.lastErr
}

func (w *indexWriter) setLastError(err error) {
	w.errMu.Lock()
	w.lastErr = err
	w.errMu.Unlock()
}

type pendingIndexMutation struct {
	revision uint64
	upserts  map[string]Media
	deleted  map[string]struct{}
	verified time.Time
}

func (p *pendingIndexMutation) empty() bool {
	return p.revision == 0 && len(p.upserts) == 0 &&
		len(p.deleted) == 0 && p.verified.IsZero()
}

func (p *pendingIndexMutation) merge(mutation indexMutation) {
	if p.upserts == nil {
		p.upserts = make(map[string]Media)
	}
	if p.deleted == nil {
		p.deleted = make(map[string]struct{})
	}
	for _, id := range mutation.deleted {
		p.deleted[id] = struct{}{}
		delete(p.upserts, id)
	}
	for _, item := range mutation.upserts {
		p.upserts[item.ID] = cloneMedia(item)
		delete(p.deleted, item.ID)
	}
	if mutation.revision > p.revision {
		p.revision = mutation.revision
	}
	if mutation.verified.After(p.verified) {
		p.verified = mutation.verified
	}
}

func (p *pendingIndexMutation) slices() ([]Media, []string) {
	upserts := make([]Media, 0, len(p.upserts))
	for _, item := range p.upserts {
		upserts = append(upserts, item)
	}
	sortMedia(upserts)
	deleted := make([]string, 0, len(p.deleted))
	for id := range p.deleted {
		deleted = append(deleted, id)
	}
	sort.Strings(deleted)
	return upserts, deleted
}

func (w *indexWriter) run() {
	defer close(w.done)

	pending := pendingIndexMutation{}
	var timer *time.Timer
	var timerC <-chan time.Time
	retryDelay := indexRetryMinDelay

	stopTimer := func() {
		if timer == nil {
			return
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timerC = nil
	}
	flush := func() error {
		stopTimer()
		if pending.empty() {
			return nil
		}
		upserts, deleted := pending.slices()
		err := w.index.Append(pending.revision, upserts, deleted, pending.verified)
		if err == nil && w.index.NeedsCompaction() {
			if w.checkpoint == nil {
				err = w.index.Compact()
			} else if checkpoint, ok := w.checkpoint(pending.revision); ok {
				err = w.index.resetOwned(
					checkpoint.settings,
					checkpoint.items,
					checkpoint.revision,
					checkpoint.verifiedAt,
					false,
				)
			}
		}
		if err == nil {
			pending = pendingIndexMutation{}
			retryDelay = indexRetryMinDelay
		}
		w.setLastError(err)
		return err
	}

	for {
		select {
		case event := <-w.events:
			switch value := event.(type) {
			case indexMutation:
				pending.merge(value)
				if timer == nil {
					timer = time.NewTimer(w.quiet)
				} else {
					stopTimer()
					timer.Reset(w.quiet)
				}
				timerC = timer.C
			case indexResetRequest:
				stopTimer()
				if err := flush(); err != nil {
					value.done <- err
					continue
				}
				var err error
				err = w.index.resetOwned(
					value.settings,
					value.items,
					value.revision,
					value.verifiedAt,
					value.prepared,
				)
				if err == nil {
					retryDelay = indexRetryMinDelay
				}
				w.setLastError(err)
				value.done <- err
			case indexPreparedResetAction:
				var err error
				if value.rollback {
					err = w.index.RollbackPreparedReset()
				} else {
					err = w.index.CommitPreparedReset()
				}
				w.setLastError(err)
				value.done <- err
			case chan error:
				value <- flush()
			case indexCloseRequest:
				value.done <- flush()
				return
			}
		case <-timerC:
			if err := flush(); err != nil {
				if timer == nil {
					timer = time.NewTimer(retryDelay)
				} else {
					timer.Reset(retryDelay)
				}
				timerC = timer.C
				retryDelay *= 2
				if retryDelay > indexRetryMaxDelay {
					retryDelay = indexRetryMaxDelay
				}
			}
		}
	}
}
