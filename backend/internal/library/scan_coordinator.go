package library

import (
	"context"
	"log/slog"
	"sync"

	"muzio/backend/internal/mediapath"
)

type scanCall struct {
	done    chan struct{}
	roots   *mediapath.Roots
	results []RootScanResult
	err     error
}

type rescanCall struct {
	done   chan struct{}
	result MediaRootUpdateResult
	err    error
}

type scanCoordinator struct {
	stateMu  sync.Mutex
	workerMu sync.Mutex
	calls    map[string]*scanCall

	rescanMu sync.Mutex
	rescan   *rescanCall

	lifecycleMu sync.Mutex
	wg          sync.WaitGroup
	ctx         context.Context
	cancel      context.CancelFunc
	closing     bool
}

func newScanCoordinator() scanCoordinator {
	ctx, cancel := context.WithCancel(context.Background())
	return scanCoordinator{
		calls:  make(map[string]*scanCall),
		ctx:    ctx,
		cancel: cancel,
	}
}

func (c *scanCoordinator) scan(
	settings MediaRootSettings,
	scanner mediaRootScanner,
	logger *slog.Logger,
) (*mediapath.Roots, []RootScanResult, error) {
	key := mediaRootSettingsKey(settings)

	c.stateMu.Lock()
	if call, ok := c.calls[key]; ok {
		c.stateMu.Unlock()
		<-call.done
		return call.roots, call.results, call.err
	}
	call := &scanCall{done: make(chan struct{})}
	c.calls[key] = call
	c.stateMu.Unlock()

	c.lifecycleMu.Lock()
	if c.closing {
		c.lifecycleMu.Unlock()
		call.err = context.Canceled
		c.finish(key, call)
		return nil, nil, call.err
	}
	c.wg.Add(1)
	c.lifecycleMu.Unlock()
	defer c.wg.Done()

	c.workerMu.Lock()
	call.roots, call.results, call.err = scanner(settings, logger)
	c.workerMu.Unlock()

	c.finish(key, call)
	return call.roots, call.results, call.err
}

func (c *scanCoordinator) rescanOnce(
	run func() (MediaRootUpdateResult, error),
) (MediaRootUpdateResult, error) {
	c.rescanMu.Lock()
	if call := c.rescan; call != nil {
		c.rescanMu.Unlock()
		<-call.done
		return call.result, call.err
	}
	call := &rescanCall{done: make(chan struct{})}
	c.rescan = call
	c.rescanMu.Unlock()

	call.result, call.err = run()

	c.rescanMu.Lock()
	c.rescan = nil
	close(call.done)
	c.rescanMu.Unlock()
	return call.result, call.err
}

func (c *scanCoordinator) finish(key string, call *scanCall) {
	c.stateMu.Lock()
	delete(c.calls, key)
	close(call.done)
	c.stateMu.Unlock()
}

func (c *scanCoordinator) stop() {
	c.lifecycleMu.Lock()
	if !c.closing {
		c.closing = true
		c.cancel()
	}
	c.lifecycleMu.Unlock()
}

func (c *scanCoordinator) wait(ctx context.Context) error {
	done := make(chan struct{})
	go func() {
		c.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
