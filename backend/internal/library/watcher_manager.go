package library

import (
	"errors"
	"log/slog"
	"path/filepath"
	"sync"
)

type watcherManager struct {
	mu      sync.Mutex
	runtime *watchRuntime
	started bool

	stateMu sync.RWMutex
	state   WatcherStatus
}

func (m *watcherManager) status() WatcherStatus {
	m.stateMu.RLock()
	defer m.stateMu.RUnlock()
	return cloneWatcherStatus(m.state)
}

func (m *watcherManager) start(
	service *Service,
	logger *slog.Logger,
	paths []string,
) WatcherStatus {
	m.mu.Lock()
	m.started = true
	m.replaceLocked(service, logger, paths)
	m.mu.Unlock()
	return m.status()
}

func (m *watcherManager) restart(
	service *Service,
	logger *slog.Logger,
	paths []string,
) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.started {
		return
	}
	m.replaceLocked(service, logger, paths)
}

func (m *watcherManager) replaceLocked(
	service *Service,
	logger *slog.Logger,
	paths []string,
) {
	if m.runtime != nil {
		if err := m.runtime.Close(); err != nil {
			logger.Warn("filesystem watcher close failed", "error", err)
		}
		m.runtime = nil
	}
	backend, statuses, err := newPlatformWatcher(paths)
	state := WatcherStatus{
		Enabled: watcherEnabled(statuses),
		Backend: watcherBackendName(statuses),
		Roots:   statuses,
	}
	if err != nil {
		for index := range statuses {
			statuses[index].Enabled = false
			if statuses[index].Reason == "" {
				statuses[index].Reason = err.Error()
			}
		}
		state.Enabled = false
		state.LastError = err.Error()
		logger.Warn("filesystem watcher unavailable", "error", err)
	}
	m.stateMu.Lock()
	m.state = state
	m.stateMu.Unlock()
	if backend != nil {
		m.runtime = newWatchRuntime(service, logger, backend)
	}
}

func (m *watcherManager) stop() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.runtime == nil {
		return nil
	}
	err := m.runtime.Close()
	m.runtime = nil
	return err
}

func (m *watcherManager) setError(err error) {
	m.stateMu.Lock()
	defer m.stateMu.Unlock()
	if err == nil {
		m.state.LastError = ""
		return
	}
	var disabled *watchRootDisabledError
	if errors.As(err, &disabled) {
		for index := range m.state.Roots {
			if filepath.Clean(m.state.Roots[index].Path) != filepath.Clean(disabled.Path) {
				continue
			}
			m.state.Roots[index].Enabled = false
			m.state.Roots[index].Reason = disabled.Error()
		}
		m.state.Enabled = watcherEnabled(m.state.Roots)
		m.state.Backend = watcherBackendName(m.state.Roots)
	}
	m.state.LastError = err.Error()
}
