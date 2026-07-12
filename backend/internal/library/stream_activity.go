package library

import (
	"context"
	"runtime"
	"sync"
)

type streamActivity struct {
	mu     sync.Mutex
	active int
	idle   chan struct{}
}

func newStreamActivity() streamActivity {
	idle := make(chan struct{})
	close(idle)
	return streamActivity{idle: idle}
}

func (a *streamActivity) begin() func() {
	a.mu.Lock()
	if a.active == 0 {
		a.idle = make(chan struct{})
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
			}
			a.mu.Unlock()
		})
	}
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
