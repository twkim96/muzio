package httpserver

import (
	"log/slog"
	"net/http"
	"time"

	"muzio/backend/internal/config"
	"muzio/backend/internal/fallback"
)

func New(cfg config.Config, logger *slog.Logger, lister LibraryLister, streamHandler http.Handler, progressStores ...ProgressStore) *http.Server {
	return &http.Server{
		Addr:              cfg.Address(),
		Handler:           NewHandlerWithWeb(logger, lister, streamHandler, cfg.WebDist, progressStores...),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       90 * time.Second,
	}
}

func NewHandler(logger *slog.Logger, lister LibraryLister, streamHandler http.Handler, progressStores ...ProgressStore) http.Handler {
	return NewHandlerWithWeb(logger, lister, streamHandler, "", progressStores...)
}

func NewHandlerWithWeb(logger *slog.Logger, lister LibraryLister, streamHandler http.Handler, webDist string, progressStores ...ProgressStore) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	var progressStore ProgressStore
	if len(progressStores) > 0 {
		progressStore = progressStores[0]
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", healthHandler)
	mux.Handle("/api/library", libraryListHandler(lister))
	if reader, ok := lister.(LibraryRevisionReader); ok {
		mux.Handle("/api/library/changes", libraryChangesHandler(reader))
	}
	if subscriber, ok := lister.(LibraryEventSubscriber); ok {
		mux.Handle("/api/library/events", libraryEventsHandler(
			subscriber,
			func() uint64 { return libraryRevision(lister) },
			newHeartbeatBroker(90*time.Second),
		))
	}
	if mediaRoots, ok := lister.(MediaRootsManager); ok {
		mux.Handle("/api/settings/media-roots", mediaRootsHandler(mediaRoots))
	}
	if appearance, ok := lister.(AppearanceManager); ok {
		mux.Handle("/api/settings/appearance", appearanceHandler(appearance))
	}
	if getter, ok := lister.(LibraryGetter); ok {
		mux.Handle("/api/thumbnails/", thumbnailHandler(getter))
		mux.Handle("/api/fallback/", fallbackHandler(getter, fallback.Planner{
			Detector: &fallback.SystemFFmpegDetector{},
		}))
		if provider, ok := lister.(AudioResumeCacheProvider); ok {
			if cache := provider.AudioResumeCache(); cache != nil {
				mux.Handle("/api/audio-resume-cache", audioResumeCacheStatusHandler(cache))
				mux.Handle("/api/audio-resume-cache/media/", audioResumeCacheMediaHandler(getter, cache, streamHandler))
				mux.Handle("/api/audio-resume-cache/", audioResumeCacheRequestHandler(getter, cache))
			}
		}
		if provider, ok := lister.(VideoOptimizationProvider); ok {
			if optimization := provider.VideoOptimization(); optimization != nil {
				mux.Handle("/api/video-optimization/media/", videoOptimizationMediaHandler(getter, optimization, logger))
				mux.Handle("/api/video-optimization/", videoOptimizationHandler(getter, optimization))
			}
		}
	}
	if progressStore != nil {
		mux.Handle("/api/progress", progressCollectionHandler(progressStore))
		mux.Handle("/api/progress/", progressItemHandler(progressStore))
	}
	if streamHandler != nil {
		mux.Handle("/api/media/", streamHandler)
	}
	if webDist != "" {
		mux.Handle("/", webAppHandler(http.Dir(webDist)))
	}

	return loggingMiddleware(logger, gzipMiddleware(mux))
}
