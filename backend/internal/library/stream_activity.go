package library

import (
	"context"
	"runtime"
	"sync"
	"time"
)

type streamActivity struct {
	mu      sync.Mutex
	active  int
	idle    chan struct{}
	started chan struct{}
}

func newStreamActivity() streamActivity {
	idle := make(chan struct{})
	close(idle)
	return streamActivity{idle: idle, started: make(chan struct{})}
}

func (a *streamActivity) begin() func() {
	a.mu.Lock()
	if a.active == 0 {
		a.idle = make(chan struct{})
		close(a.started)
	}
	a.active++
	a.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			a.mu.Lock()
			a.active--
			if a.active == 0 {
				close(a.idle)
				a.started = make(chan struct{})
			}
			a.mu.Unlock()
		})
	}
}

func (a *streamActivity) waitUntilQuiet(
	ctx context.Context,
	quietWindow time.Duration,
) error {
	for {
		if err := a.waitUntilIdle(ctx, true); err != nil {
			return err
		}
		if quietWindow <= 0 {
			return nil
		}
		a.mu.Lock()
		if a.active != 0 {
			a.mu.Unlock()
			continue
		}
		started := a.started
		a.mu.Unlock()

		timer := time.NewTimer(quietWindow)
		select {
		case <-timer.C:
			return ctx.Err()
		case <-started:
			if !timer.Stop() {
				<-timer.C
			}
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return ctx.Err()
		}
	}
}

func (a *streamActivity) backgroundWorkContext(
	parent context.Context,
) (context.Context, context.CancelFunc) {
	a.mu.Lock()
	started := a.started
	active := a.active
	a.mu.Unlock()

	ctx, cancel := context.WithCancel(parent)
	if active != 0 {
		cancel()
		return ctx, cancel
	}
	go func() {
		select {
		case <-started:
			cancel()
		case <-ctx.Done():
		}
	}()
	return ctx, cancel
}

func (a *streamActivity) waitUntilIdle(ctx context.Context, first bool) error {
	if !first {
		runtime.Gosched()
	}
	for {
		a.mu.Lock()
		idle := a.idle
		active := a.active
		a.mu.Unlock()
		if active == 0 {
			return ctx.Err()
		}
		select {
		case <-idle:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
