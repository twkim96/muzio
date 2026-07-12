package main

import (
	"context"
	"crypto/tls"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"muzio/backend/internal/config"
	"muzio/backend/internal/fallback"
	"muzio/backend/internal/httpserver"
	"muzio/backend/internal/library"
	"muzio/backend/internal/progress"
	"muzio/backend/internal/streaming"
	"muzio/backend/internal/thumbnail"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With(
		"service",
		"muzio-backend",
	)

	configPath, err := config.ResolvePath(os.Getenv("VMA_CONFIG"))
	if err != nil {
		logger.Error("failed to resolve config path", "error", err)
		os.Exit(1)
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		logger.Error("failed to load config", "error", err)
		os.Exit(1)
	}

	envMediaRootsOverride := mediaRootsEnvOverride()
	rootSettings := rootSettingsFromConfig(cfg, envMediaRootsOverride)
	var persist library.MediaRootPersister
	if configPath != "" && !envMediaRootsOverride {
		persist = func(settings library.MediaRootSettings) error {
			return config.UpdateMediaRoots(configPath, settings.AudioRoots, settings.VideoRoots, settings.ImageRoots)
		}
	}

	indexPath, err := config.ResolveLibraryIndexPath(configPath)
	if err != nil {
		logger.Error("failed to resolve library index path", "error", err)
		os.Exit(1)
	}
	libraryService, err := library.NewPersistentService(rootSettings, logger, persist, indexPath)
	if err != nil {
		logger.Error("library service failed", "error", err)
		os.Exit(1)
	}
	thumbnailManager, ffmpegInfo := configureThumbnailManager(
		configPath,
		libraryService,
		logger,
	)
	appService := appRuntime{
		Service:    libraryService,
		appearance: config.NewAppearanceStore(configPath),
		thumbnails: thumbnailManager,
	}
	for _, root := range rootSettings.EffectiveRoots() {
		logger.Info("media root configured", "path", root)
	}
	indexStatus := libraryService.IndexStatus()
	logger.Info(
		"library cache loaded",
		"items", libraryService.Len(),
		"cachedItems", indexStatus.LoadedItems,
		"lastVerifiedAt", indexStatus.LastVerifiedAt,
		"path", indexPath,
	)

	progressPath, err := config.ResolveProgressPath(configPath)
	if err != nil {
		logger.Error("failed to resolve progress path", "error", err)
		_ = libraryService.Close()
		os.Exit(1)
	}
	progressStore, progressLoadErr := progress.OpenPersistentStore(progressPath)
	if progressStore == nil {
		logger.Error("progress store failed", "error", progressLoadErr)
		_ = libraryService.Close()
		os.Exit(1)
	}
	if progressLoadErr != nil {
		logger.Warn("progress store recovery required", "path", progressPath, "error", progressLoadErr)
	}
	logger.Info("progress store loaded", "records", len(progressStore.List()), "path", progressPath)

	streamHandler := streaming.Handler(libraryService, libraryService, logger)
	server := httpserver.New(cfg, logger, appService, streamHandler, progressStore)
	cancelServerRequests := attachServerContext(server)
	defer cancelServerRequests()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if thumbnailManager != nil {
		go scheduleVideoThumbnails(
			ctx,
			libraryService,
			thumbnailManager,
			ffmpegInfo.Available,
			logger,
		)
	}

	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		logger.Error("server listener failed", "addr", server.Addr, "error", err)
		_ = progressStore.Close()
		_ = libraryService.Close()
		os.Exit(1)
	}
	if tlsEnabled() {
		certFile := os.Getenv("VMA_TLS_CERT")
		keyFile := os.Getenv("VMA_TLS_KEY")
		if certFile == "" || keyFile == "" {
			listener.Close()
			_ = progressStore.Close()
			_ = libraryService.Close()
			logger.Error("server TLS configuration failed", "error", "VMA_HTTPS is enabled but VMA_TLS_CERT or VMA_TLS_KEY is empty")
			os.Exit(1)
		}
		certificate, err := tls.LoadX509KeyPair(certFile, keyFile)
		if err != nil {
			listener.Close()
			_ = progressStore.Close()
			_ = libraryService.Close()
			logger.Error("server TLS certificate failed", "error", err)
			os.Exit(1)
		}
		listener = tls.NewListener(listener, &tls.Config{
			Certificates: []tls.Certificate{certificate},
			MinVersion:   tls.VersionTLS12,
		})
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("server starting", "addr", cfg.Address())
		errCh <- server.Serve(listener)
	}()
	watcherStatus := libraryService.StartWatcher()
	logger.Info(
		"filesystem watcher started",
		"enabled", watcherStatus.Enabled,
		"backend", watcherStatus.Backend,
		"roots", len(watcherStatus.Roots),
		"error", watcherStatus.LastError,
	)
	go func() {
		result, err := libraryService.RescanMediaRoots()
		if err != nil {
			logger.Warn("startup library verification failed", "error", err)
			return
		}
		logger.Info(
			"startup library verification complete",
			"items", result.ItemCount,
			"revision", result.Reconciliation.Revision,
			"degradedRoots", len(result.DegradedRoots),
		)
	}()

	select {
	case <-ctx.Done():
		cancelServerRequests()
		if thumbnailManager != nil {
			thumbnailManager.Close()
		}
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		shutdownErr := server.Shutdown(shutdownCtx)
		if shutdownErr != nil {
			logger.Error("server shutdown failed", "error", shutdownErr)
		}
		progressCtx, cancelProgress := context.WithTimeout(context.Background(), 2*time.Second)
		progressErr := progressStore.CloseContext(progressCtx)
		cancelProgress()
		if progressErr != nil {
			logger.Error("progress store flush failed", "error", progressErr)
		}
		indexCtx, cancelIndex := context.WithTimeout(context.Background(), 2*time.Second)
		indexErr := libraryService.CloseContext(indexCtx)
		cancelIndex()
		if indexErr != nil {
			// CloseContext still cancels scans and attempts a final index flush
			// when the HTTP shutdown deadline has already expired.
			logger.Error("library index flush failed", "error", indexErr)
		}
		if shutdownErr != nil || progressErr != nil || indexErr != nil {
			os.Exit(1)
		}
		logger.Info("server stopped")
	case err := <-errCh:
		cancelServerRequests()
		if thumbnailManager != nil {
			thumbnailManager.Close()
		}
		progressCtx, cancelProgress := context.WithTimeout(context.Background(), 2*time.Second)
		progressErr := progressStore.CloseContext(progressCtx)
		cancelProgress()
		if progressErr != nil {
			logger.Error("progress store flush failed", "error", progressErr)
		}
		indexCtx, cancelIndex := context.WithTimeout(context.Background(), 2*time.Second)
		closeErr := libraryService.CloseContext(indexCtx)
		cancelIndex()
		if closeErr != nil {
			logger.Error("library index flush failed", "error", closeErr)
		}
		if progressErr != nil || closeErr != nil {
			os.Exit(1)
		}
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "error", err)
			os.Exit(1)
		}
	}
}

func attachServerContext(server *http.Server) context.CancelFunc {
	ctx, cancel := context.WithCancel(context.Background())
	server.BaseContext = func(net.Listener) context.Context {
		return ctx
	}
	return cancel
}

func tlsEnabled() bool {
	value := os.Getenv("VMA_HTTPS")
	return value == "1" || value == "true" || value == "TRUE"
}

func mediaRootsEnvOverride() bool {
	if os.Getenv("VMA_MEDIA_ROOTS") == "" {
		return false
	}
	value := os.Getenv("VMA_MEDIA_ROOTS_OVERRIDE")
	return value == "1" || value == "true" || value == "TRUE"
}

func rootSettingsFromConfig(cfg config.Config, envMediaRootsOverride bool) library.MediaRootSettings {
	settings := library.MediaRootSettings{
		AudioRoots: cfg.AudioRoots,
		VideoRoots: cfg.VideoRoots,
		ImageRoots: cfg.ImageRoots,
	}
	if !hasSplitMediaRoots(settings) || envMediaRootsOverride {
		return library.SettingsFromRoots(cfg.MediaRoots)
	}
	return settings
}

func hasSplitMediaRoots(settings library.MediaRootSettings) bool {
	return len(settings.AudioRoots)+len(settings.VideoRoots)+len(settings.ImageRoots) > 0
}

type appRuntime struct {
	*library.Service
	appearance config.AppearanceStore
	thumbnails *thumbnail.Manager
}

func (a appRuntime) ThumbnailPath(item library.Media) (string, bool) {
	if a.thumbnails == nil || !a.thumbnails.Ready(item) {
		return "", false
	}
	return a.thumbnails.Path(item), true
}

func (a appRuntime) GetAppearance() (config.AppearanceSettings, bool, error) {
	return a.appearance.GetAppearance()
}

func (a appRuntime) UpdateAppearance(settings config.AppearanceSettings) (config.AppearanceSettings, error) {
	return a.appearance.UpdateAppearance(settings)
}

func (a appRuntime) ResetAppearance() (config.AppearanceSettings, error) {
	return a.appearance.ResetAppearance()
}

func configureThumbnailManager(
	configPath string,
	service *library.Service,
	logger *slog.Logger,
) (*thumbnail.Manager, fallback.FFmpegInfo) {
	cachePath, err := config.ResolveThumbnailCachePath(configPath)
	if err != nil {
		logger.Warn("thumbnail cache path unavailable", "error", err)
		return nil, fallback.FFmpegInfo{Reason: err.Error()}
	}
	ffmpegInfo := (&fallback.SystemFFmpegDetector{}).Detect(context.Background())
	manager, err := thumbnail.NewManager(thumbnail.Options{
		CacheDir:     cachePath,
		Resolver:     service,
		Idle:         service,
		Extract:      thumbnail.FFmpegExtractor{Path: ffmpegInfo.Path},
		ImageExtract: thumbnail.ImageExtractor{},
		Logger:       logger,
		Workers:      thumbnailWorkerCount(),
		OnReady: func(generated library.Media) {
			setThumbnailStatus(
				service,
				generated,
				library.ThumbnailStatusReady,
			)
		},
		OnFailure: func(failed library.Media) {
			setThumbnailStatus(
				service,
				failed,
				library.ThumbnailStatusFallback,
			)
		},
	})
	if err != nil {
		logger.Warn("thumbnail cache unavailable", "path", cachePath, "error", err)
		return nil, ffmpegInfo
	}
	logger.Info(
		"media thumbnail runtime configured",
		"cache", cachePath,
		"ffmpegAvailable", ffmpegInfo.Available,
		"ffmpegVersion", ffmpegInfo.Version,
	)
	return manager, ffmpegInfo
}

// thumbnailWorkerCount picks how many thumbnails may be generated in parallel.
// Each worker waits for media-idle before extracting, so this only adds
// parallelism while nothing is playing. It is kept well below the core count
// so a burst of ffmpeg processes during a first large-library index does not
// saturate the machine.
func thumbnailWorkerCount() int {
	const maxWorkers = 4
	workers := runtime.NumCPU() / 2
	if workers < 1 {
		workers = 1
	}
	if workers > maxWorkers {
		workers = maxWorkers
	}
	return workers
}

func scheduleVideoThumbnails(
	ctx context.Context,
	service *library.Service,
	manager *thumbnail.Manager,
	generationEnabled bool,
	logger *slog.Logger,
) {
	events, unsubscribe := service.SubscribeLibraryEvents()
	defer unsubscribe()
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	runVideoThumbnailScheduler(ctx, events, ticker.C, func() {
		reconcileVideoThumbnails(service, manager, generationEnabled, logger)
	})
}

func runVideoThumbnailScheduler(
	ctx context.Context,
	events <-chan library.LibraryEvent,
	hourly <-chan time.Time,
	reconcile func(),
) {
	reconcile()
	for {
		select {
		case <-ctx.Done():
			return
		case <-hourly:
			reconcile()
		case event := <-events:
			if shouldReconcileVideoThumbnails(event) {
				reconcile()
			}
		}
	}
}

func shouldReconcileVideoThumbnails(event library.LibraryEvent) bool {
	return event.Reason != "thumbnail" &&
		(containsMediaType(event.AffectedTypes, library.MediaTypeVideo) ||
			containsMediaType(event.AffectedTypes, library.MediaTypeImage))
}

func reconcileVideoThumbnails(
	service *library.Service,
	manager *thumbnail.Manager,
	generationEnabled bool,
	logger *slog.Logger,
) {
	storedItems := service.ListStoredTypes(
		library.MediaTypeVideo,
		library.MediaTypeImage,
	)
	result, err := manager.Reconcile(storedItems, time.Now())
	if err != nil {
		logger.Warn("media thumbnail cache cleanup failed", "error", err)
	} else if result.RemovedImages+result.RemovedMarkers > 0 {
		logger.Info(
			"media thumbnail cache reconciled",
			"removedImages", result.RemovedImages,
			"removedMarkers", result.RemovedMarkers,
		)
	}
	items := storedItems[:0]
	for _, item := range storedItems {
		if !item.Offline {
			items = append(items, item)
		}
	}
	if !generationEnabled {
		generatable := items[:0]
		for _, item := range items {
			if item.Type == library.MediaTypeVideo && !manager.Ready(item) {
				setThumbnailStatus(service, item, library.ThumbnailStatusFallback)
			}
			if item.Type == library.MediaTypeImage {
				generatable = append(generatable, item)
			}
		}
		items = generatable
	}
	for _, item := range items {
		if item.Thumbnail.Status == library.ThumbnailStatusReady &&
			!manager.Ready(item) {
			setThumbnailStatus(service, item, library.ThumbnailStatusPending)
		}
	}
	manager.Sync(items)
}

func containsMediaType(values []library.MediaType, target library.MediaType) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func setThumbnailStatus(
	service *library.Service,
	generated library.Media,
	status string,
) {
	service.UpdateThumbnailStatus(
		generated.ID,
		generated.Thumbnail.CacheKey,
		status,
	)
}
