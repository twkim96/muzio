package thumbnail

import (
	"container/heap"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"muzio/backend/internal/library"
)

const (
	defaultQueueSize    = 256
	defaultJobTimeout   = 45 * time.Second
	defaultIdleTimeout  = 45 * time.Second
	defaultMaxAttempts  = 3
	defaultRetryBase    = time.Second
	defaultRetryMaximum = 30 * time.Second
	offlineGrace        = 30 * 24 * time.Hour
	defaultWorkers      = 1
	imageWorkers        = 1
)

type Resolver interface {
	ResolveStrict(rootName, relativePath string) (string, error)
}

type IdleWaiter interface {
	WaitForMediaIdle(context.Context) error
}

type Extractor interface {
	Extract(context.Context, string, string) error
}

type ReadyHandler func(library.Media)
type FailureHandler func(library.Media)

type CleanupResult struct {
	RemovedImages  int
	RemovedMarkers int
}

type Manager struct {
	cacheDir  string
	resolver  Resolver
	idle      IdleWaiter
	extract   Extractor
	image     Extractor
	onReady   ReadyHandler
	onFailure FailureHandler
	logger    *slog.Logger
	timeout   time.Duration
	idleTime  time.Duration
	maxTries  int
	retryBase time.Duration
	retryMax  time.Duration

	ctx         context.Context
	cancel      context.CancelFunc
	queue       chan *scheduledJob
	imageQueue  chan *scheduledJob
	completions chan jobResult
	wake        chan struct{}
	wg          sync.WaitGroup

	mu             sync.Mutex
	states         map[string]*scheduledJob
	pending        jobHeap
	imagePending   jobHeap
	nextSequence   uint64
	desired        map[string]struct{}
	desiredManaged bool
}

type jobPhase uint8

const (
	jobPending jobPhase = iota + 1
	jobQueued
	jobRunning
	jobFailed
)

type scheduledJob struct {
	item         library.Media
	phase        jobPhase
	attempts     int
	retryOrdinal int
	notBefore    time.Time
	sequence     uint64
	index        int
}

type jobHeap []*scheduledJob

func (h jobHeap) Len() int { return len(h) }

func (h jobHeap) Less(i, j int) bool {
	if h[i].notBefore.Equal(h[j].notBefore) {
		return h[i].sequence < h[j].sequence
	}
	return h[i].notBefore.Before(h[j].notBefore)
}

func (h jobHeap) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].index = i
	h[j].index = j
}

func (h *jobHeap) Push(value any) {
	job := value.(*scheduledJob)
	job.index = len(*h)
	*h = append(*h, job)
}

func (h *jobHeap) Pop() any {
	old := *h
	last := len(old) - 1
	job := old[last]
	old[last] = nil
	job.index = -1
	*h = old[:last]
	return job
}

type jobResult struct {
	job      *scheduledJob
	err      error
	deferred bool
}

type Options struct {
	CacheDir     string
	Resolver     Resolver
	Idle         IdleWaiter
	Extract      Extractor
	ImageExtract Extractor
	OnReady      ReadyHandler
	OnFailure    FailureHandler
	Logger       *slog.Logger
	Timeout      time.Duration
	IdleTimeout  time.Duration
	QueueSize    int
	MaxAttempts  int
	RetryBase    time.Duration
	RetryMax     time.Duration
	// Workers bounds concurrent video extraction. Image extraction is served by
	// one dedicated worker so high-memory image decodes cannot occupy this pool.
	Workers int
}

func NewManager(options Options) (*Manager, error) {
	if options.CacheDir == "" {
		return nil, errors.New("thumbnail: cache directory is required")
	}
	if options.Resolver == nil {
		return nil, errors.New("thumbnail: resolver is required")
	}
	if options.Extract == nil {
		return nil, errors.New("thumbnail: extractor is required")
	}
	if err := os.MkdirAll(options.CacheDir, 0o755); err != nil {
		return nil, fmt.Errorf("thumbnail: create cache directory: %w", err)
	}
	if err := removeTemporaryFiles(options.CacheDir); err != nil {
		return nil, fmt.Errorf("thumbnail: remove temporary files: %w", err)
	}
	queueSize := options.QueueSize
	if queueSize <= 0 {
		queueSize = defaultQueueSize
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = defaultJobTimeout
	}
	idleTimeout := options.IdleTimeout
	if idleTimeout <= 0 {
		idleTimeout = defaultIdleTimeout
	}
	maxAttempts := options.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = defaultMaxAttempts
	}
	retryBase := options.RetryBase
	if retryBase <= 0 {
		retryBase = defaultRetryBase
	}
	retryMax := options.RetryMax
	if retryMax <= 0 {
		retryMax = defaultRetryMaximum
	}
	if retryMax < retryBase {
		retryMax = retryBase
	}
	workers := options.Workers
	if workers <= 0 {
		workers = defaultWorkers
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	ctx, cancel := context.WithCancel(context.Background())
	manager := &Manager{
		cacheDir:    options.CacheDir,
		resolver:    options.Resolver,
		idle:        options.Idle,
		extract:     options.Extract,
		image:       options.ImageExtract,
		onReady:     options.OnReady,
		onFailure:   options.OnFailure,
		logger:      logger,
		timeout:     timeout,
		idleTime:    idleTimeout,
		maxTries:    maxAttempts,
		retryBase:   retryBase,
		retryMax:    retryMax,
		ctx:         ctx,
		cancel:      cancel,
		queue:       make(chan *scheduledJob, queueSize),
		imageQueue:  make(chan *scheduledJob, imageWorkers),
		completions: make(chan jobResult, queueSize+1),
		wake:        make(chan struct{}, 1),
		states:      make(map[string]*scheduledJob),
		desired:     make(map[string]struct{}),
	}
	heap.Init(&manager.pending)
	heap.Init(&manager.imagePending)
	workerCount := workers
	if manager.image != nil {
		workerCount += imageWorkers
	}
	manager.wg.Add(1 + workerCount)
	go manager.runScheduler()
	for i := 0; i < workers; i++ {
		go manager.runWorker(manager.queue)
	}
	if manager.image != nil {
		go manager.runWorker(manager.imageQueue)
	}
	return manager, nil
}

func (m *Manager) Enqueue(item library.Media) bool {
	if !m.supports(item) || item.Thumbnail.CacheKey == "" {
		return false
	}
	if m.ctx.Err() != nil {
		return false
	}
	if m.Ready(item) {
		m.clearState(item.Thumbnail.CacheKey)
		m.notifyReady(item)
		return false
	}
	key := item.Thumbnail.CacheKey
	m.mu.Lock()
	if _, exists := m.states[key]; exists {
		m.mu.Unlock()
		return false
	}
	m.nextSequence++
	job := &scheduledJob{
		item:      item,
		phase:     jobPending,
		notBefore: time.Now(),
		sequence:  m.nextSequence,
		index:     -1,
	}
	m.states[key] = job
	heap.Push(m.pendingFor(job), job)
	m.mu.Unlock()
	m.signalWake()
	return true
}

func (m *Manager) Sync(items []library.Media) {
	desired := make(map[string]struct{}, len(items))
	for _, item := range items {
		if m.supports(item) && item.Thumbnail.CacheKey != "" {
			desired[item.Thumbnail.CacheKey] = struct{}{}
		}
	}

	m.mu.Lock()
	m.desiredManaged = true
	m.desired = desired
	for key, job := range m.states {
		if _, current := desired[key]; current {
			continue
		}
		m.removeJobLocked(job)
	}
	m.mu.Unlock()

	for _, item := range items {
		m.Enqueue(item)
	}
	m.signalWake()
}

func (m *Manager) Ready(item library.Media) bool {
	if item.Thumbnail.CacheKey == "" {
		return false
	}
	info, err := os.Stat(m.Path(item))
	return err == nil && info.Mode().IsRegular() && info.Size() > 0
}

func (m *Manager) Path(item library.Media) string {
	return filepath.Join(m.cacheDir, item.Thumbnail.CacheKey+".jpg")
}

func (m *Manager) Reconcile(items []library.Media, now time.Time) (CleanupResult, error) {
	keys := make(map[string]bool)
	for _, item := range items {
		if !m.supports(item) || item.Thumbnail.CacheKey == "" {
			continue
		}
		keys[item.Thumbnail.CacheKey] = item.Offline
		marker := m.offlineMarker(item.Thumbnail.CacheKey)
		if item.Offline {
			file, err := os.OpenFile(marker, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
			if err == nil {
				_ = file.Close()
			} else if !errors.Is(err, fs.ErrExist) {
				return CleanupResult{}, err
			}
			continue
		}
		if err := os.Remove(marker); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return CleanupResult{}, err
		}
	}
	m.mu.Lock()
	for key, job := range m.states {
		if _, current := keys[key]; !current && job.phase == jobFailed {
			m.removeJobLocked(job)
		}
	}
	m.mu.Unlock()

	entries, err := os.ReadDir(m.cacheDir)
	if err != nil {
		return CleanupResult{}, err
	}
	var result CleanupResult
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if temporaryThumbnailName(name) {
			continue
		}
		path := filepath.Join(m.cacheDir, name)
		switch filepath.Ext(name) {
		case ".jpg":
			key := strings.TrimSuffix(name, ".jpg")
			isOffline, current := keys[key]
			if !current {
				if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
					return result, err
				}
				result.RemovedImages++
				continue
			}
			if !isOffline {
				continue
			}
			info, err := os.Stat(m.offlineMarker(key))
			if err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					continue
				}
				return result, err
			}
			if now.Sub(info.ModTime()) < offlineGrace {
				continue
			}
			if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return result, err
			}
			result.RemovedImages++
		case ".offline":
			key := strings.TrimSuffix(name, ".offline")
			isOffline, current := keys[key]
			if current && isOffline {
				continue
			}
			if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return result, err
			}
			result.RemovedMarkers++
		}
	}
	return result, nil
}

func (m *Manager) offlineMarker(key string) string {
	return filepath.Join(m.cacheDir, key+".offline")
}

func (m *Manager) Close() {
	m.cancel()
	m.wg.Wait()
}

func (m *Manager) runScheduler() {
	defer m.wg.Done()
	var timer *time.Timer
	var timerC <-chan time.Time
	stopTimer := func() {
		if timer != nil && !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timerC = nil
	}
	resetTimer := func(delay time.Duration) {
		if delay < 0 {
			delay = 0
		}
		if timer == nil {
			timer = time.NewTimer(delay)
		} else {
			stopTimer()
			timer.Reset(delay)
		}
		timerC = timer.C
	}

	for {
		nextRetry, hasRetry := m.fillQueue()
		if hasRetry {
			resetTimer(time.Until(nextRetry))
		} else {
			stopTimer()
		}
		select {
		case <-m.ctx.Done():
			stopTimer()
			return
		case <-m.wake:
		case result := <-m.completions:
			m.complete(result)
		case <-timerC:
		}
	}
}

func (m *Manager) runWorker(queue <-chan *scheduledJob) {
	defer m.wg.Done()
	for {
		select {
		case <-m.ctx.Done():
			return
		case job := <-queue:
			if !m.start(job) {
				m.signalWake()
				continue
			}
			result := m.generate(job)
			select {
			case m.completions <- result:
			case <-m.ctx.Done():
				return
			}
		}
	}
}

func (m *Manager) fillQueue() (time.Time, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	var nextRetry time.Time
	m.fillQueueLocked(&m.pending, m.queue, now, &nextRetry)
	m.fillQueueLocked(&m.imagePending, m.imageQueue, now, &nextRetry)
	return nextRetry, !nextRetry.IsZero()
}

func (m *Manager) fillQueueLocked(
	pending *jobHeap,
	queue chan<- *scheduledJob,
	now time.Time,
	nextRetry *time.Time,
) {
	for pending.Len() > 0 {
		job := (*pending)[0]
		key := job.item.Thumbnail.CacheKey
		if m.states[key] != job {
			heap.Pop(pending)
			continue
		}
		if !m.desiredLocked(key) {
			heap.Pop(pending)
			delete(m.states, key)
			continue
		}
		if job.notBefore.After(now) {
			if nextRetry.IsZero() || job.notBefore.Before(*nextRetry) {
				*nextRetry = job.notBefore
			}
			return
		}
		select {
		case queue <- job:
			heap.Pop(pending)
			job.phase = jobQueued
		default:
			return
		}
	}
}

func (m *Manager) start(job *scheduledJob) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := job.item.Thumbnail.CacheKey
	if m.states[key] != job || !m.desiredLocked(key) {
		return false
	}
	job.phase = jobRunning
	return true
}

func (m *Manager) generate(job *scheduledJob) jobResult {
	item := job.item
	if m.Ready(item) {
		return jobResult{job: job}
	}
	if !m.current(job) {
		return jobResult{job: job, err: context.Canceled}
	}

	if m.idle != nil {
		idleCtx, cancelIdle := context.WithTimeout(m.ctx, m.idleTime)
		err := m.idle.WaitForMediaIdle(idleCtx)
		idleDeadline := errors.Is(err, context.DeadlineExceeded) &&
			errors.Is(idleCtx.Err(), context.DeadlineExceeded)
		cancelIdle()
		if err != nil {
			return jobResult{job: job, err: err, deferred: idleDeadline}
		}
	}
	if !m.current(job) {
		return jobResult{job: job, err: context.Canceled}
	}
	source, err := m.resolver.ResolveStrict(item.RootName, item.RelativePath)
	if err != nil {
		return jobResult{job: job, err: err}
	}
	ctx, cancel := context.WithTimeout(m.ctx, m.timeout)
	defer cancel()
	key := item.Thumbnail.CacheKey
	temp, err := os.CreateTemp(m.cacheDir, key+".*.tmp.jpg")
	if err != nil {
		return jobResult{job: job, err: err}
	}
	tempPath := temp.Name()
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempPath)
		return jobResult{job: job, err: err}
	}
	defer os.Remove(tempPath)

	extractor := m.extractorFor(item)
	if extractor == nil {
		return jobResult{job: job, err: errors.New("thumbnail extractor unavailable")}
	}
	if err := extractor.Extract(ctx, source, tempPath); err != nil {
		return jobResult{job: job, err: err}
	}
	info, err := os.Stat(tempPath)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		if err == nil {
			err = errors.New("extractor produced an empty thumbnail")
		}
		return jobResult{job: job, err: err}
	}
	if !m.current(job) {
		return jobResult{job: job, err: context.Canceled}
	}
	if err := os.Chmod(tempPath, 0o644); err != nil {
		return jobResult{job: job, err: err}
	}
	if err := os.Rename(tempPath, m.Path(item)); err != nil {
		return jobResult{job: job, err: err}
	}
	return jobResult{job: job}
}

func (m *Manager) complete(result jobResult) {
	job := result.job
	key := job.item.Thumbnail.CacheKey
	var ready bool
	var failed bool

	m.mu.Lock()
	if m.states[key] != job || !m.desiredLocked(key) {
		m.mu.Unlock()
		return
	}
	switch {
	case result.err == nil:
		m.removeJobLocked(job)
		ready = true
	case errors.Is(result.err, context.Canceled) && m.ctx.Err() != nil:
		m.removeJobLocked(job)
	case result.deferred:
		m.scheduleRetryLocked(job)
	default:
		job.attempts++
		if job.attempts < m.maxTries {
			m.scheduleRetryLocked(job)
		} else {
			job.phase = jobFailed
			failed = true
		}
	}
	m.mu.Unlock()

	if ready {
		m.notifyReady(job.item)
		return
	}
	if failed {
		m.logger.Warn(
			"media thumbnail generation failed",
			"id", job.item.ID,
			"path", job.item.RelativePath,
			"attempts", job.attempts,
			"error", result.err,
		)
		if m.onFailure != nil {
			m.onFailure(job.item)
		}
		return
	}
	if result.err != nil && !errors.Is(result.err, context.Canceled) {
		m.logger.Debug(
			"media thumbnail generation deferred",
			"id", job.item.ID,
			"path", job.item.RelativePath,
			"attempts", job.attempts,
			"error", result.err,
		)
	}
	m.signalWake()
}

func (m *Manager) scheduleRetryLocked(job *scheduledJob) {
	job.phase = jobPending
	job.notBefore = time.Now().Add(m.retryDelay(job.retryOrdinal))
	job.retryOrdinal++
	m.nextSequence++
	job.sequence = m.nextSequence
	heap.Push(m.pendingFor(job), job)
}

func (m *Manager) retryDelay(ordinal int) time.Duration {
	delay := m.retryBase
	for index := 0; index < ordinal && delay < m.retryMax; index++ {
		if delay > m.retryMax/2 {
			return m.retryMax
		}
		delay *= 2
	}
	if delay > m.retryMax {
		return m.retryMax
	}
	return delay
}

func (m *Manager) notifyReady(item library.Media) {
	if m.onReady != nil {
		m.onReady(item)
	}
}

func (m *Manager) clearState(key string) {
	m.mu.Lock()
	if job := m.states[key]; job != nil {
		m.removeJobLocked(job)
	}
	m.mu.Unlock()
	m.signalWake()
}

func (m *Manager) removeJobLocked(job *scheduledJob) {
	key := job.item.Thumbnail.CacheKey
	if m.states[key] == job {
		delete(m.states, key)
	}
	if job.index >= 0 {
		heap.Remove(m.pendingFor(job), job.index)
	}
}

func (m *Manager) pendingFor(job *scheduledJob) *jobHeap {
	if job.item.Type == library.MediaTypeImage {
		return &m.imagePending
	}
	return &m.pending
}

func (m *Manager) desiredLocked(key string) bool {
	if !m.desiredManaged {
		return true
	}
	_, ok := m.desired[key]
	return ok
}

func (m *Manager) current(job *scheduledJob) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := job.item.Thumbnail.CacheKey
	return m.states[key] == job && m.desiredLocked(key)
}

func (m *Manager) signalWake() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

func (m *Manager) supports(item library.Media) bool {
	switch item.Type {
	case library.MediaTypeVideo:
		return m.extract != nil
	case library.MediaTypeImage:
		return m.image != nil
	default:
		return false
	}
}

func (m *Manager) extractorFor(item library.Media) Extractor {
	if item.Type == library.MediaTypeImage {
		return m.image
	}
	return m.extract
}

func removeTemporaryFiles(cacheDir string) error {
	entries, err := os.ReadDir(cacheDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() ||
			!temporaryThumbnailName(name) {
			continue
		}
		if err := os.Remove(filepath.Join(cacheDir, name)); err != nil &&
			!errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	return nil
}

func temporaryThumbnailName(name string) bool {
	return filepath.Ext(name) == ".tmp" || strings.Contains(name, ".tmp.")
}
