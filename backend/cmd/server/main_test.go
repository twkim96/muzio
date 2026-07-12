package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"muzio/backend/internal/library"
	"muzio/backend/internal/thumbnail"
)

type canceledIdleWaiter struct{}

func (canceledIdleWaiter) WaitForMediaIdle(ctx context.Context) error {
	<-ctx.Done()
	return ctx.Err()
}

type unusedExtractor struct{}

func (unusedExtractor) Extract(context.Context, string, string) error {
	return nil
}

func TestAttachServerContextCancelsLongLivedRequests(t *testing.T) {
	server := &http.Server{}
	cancelRequests := attachServerContext(server)
	requestContext := server.BaseContext(nil)
	cancelRequests()
	select {
	case <-requestContext.Done():
	case <-time.After(time.Second):
		t.Fatal("server request context was not canceled")
	}
}

func TestSetThumbnailStatusPublishesReadyVideoUpsert(t *testing.T) {
	service, err := library.NewService(
		library.MediaRootSettings{},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	item := library.Media{
		ID:           "video-id",
		Type:         library.MediaTypeVideo,
		RootName:     "videos",
		RelativePath: "clip.mp4",
		Thumbnail: library.Thumbnail{
			URL:      "/api/thumbnails/video-id?v=key",
			Kind:     library.ThumbnailKindFallback,
			Status:   library.ThumbnailStatusReady,
			CacheKey: "key",
		},
	}
	service.ApplyChanges([]library.Media{item}, nil)
	events, unsubscribe := service.SubscribeLibraryEvents()
	defer unsubscribe()

	setThumbnailStatus(service, item, library.ThumbnailStatusReady)

	updated, err := service.Get(item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Thumbnail.Kind != library.ThumbnailKindVideo ||
		updated.Thumbnail.Status != library.ThumbnailStatusReady ||
		!strings.Contains(updated.Thumbnail.URL, "state=ready") {
		t.Fatalf("thumbnail = %#v", updated.Thumbnail)
	}
	select {
	case event := <-events:
		if !containsMediaType(event.AffectedTypes, library.MediaTypeVideo) {
			t.Fatalf("event = %#v", event)
		}
		if event.Reason != "thumbnail" {
			t.Fatalf("event reason = %q, want thumbnail", event.Reason)
		}
	case <-time.After(time.Second):
		t.Fatal("ready update event not published")
	}
}

func TestThumbnailEventsDoNotTriggerFullReconciliation(t *testing.T) {
	if shouldReconcileVideoThumbnails(library.LibraryEvent{
		AffectedTypes: []library.MediaType{library.MediaTypeVideo},
		Reason:        "thumbnail",
	}) {
		t.Fatal("thumbnail-only event requested full reconciliation")
	}
	if !shouldReconcileVideoThumbnails(library.LibraryEvent{
		AffectedTypes: []library.MediaType{library.MediaTypeVideo},
		Reason:        "multiple",
	}) {
		t.Fatal("coalesced video event did not request reconciliation")
	}
}

func TestThumbnailCompletionBurstDoesNotRepeatFullReconciliation(t *testing.T) {
	events := make(chan library.LibraryEvent, 501)
	for index := 0; index < 500; index++ {
		events <- library.LibraryEvent{
			Revision:      uint64(index + 1),
			AffectedTypes: []library.MediaType{library.MediaTypeVideo},
			Reason:        "thumbnail",
		}
	}
	events <- library.LibraryEvent{
		Revision:      501,
		AffectedTypes: []library.MediaType{library.MediaTypeVideo},
		Reason:        "multiple",
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	hourly := make(chan time.Time)
	var reconciliations atomic.Int32
	done := make(chan struct{})
	go func() {
		runVideoThumbnailScheduler(ctx, events, hourly, func() {
			reconciliations.Add(1)
		})
		close(done)
	}()

	deadline := time.Now().Add(time.Second)
	for reconciliations.Load() != 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("thumbnail scheduler did not stop")
	}
	if got := reconciliations.Load(); got != 2 {
		t.Fatalf("reconciliations = %d, want initial + mixed event", got)
	}
}

func TestSetThumbnailStatusRejectsStaleCacheKey(t *testing.T) {
	service, err := library.NewService(
		library.MediaRootSettings{},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	item := library.Media{
		ID:           "video-id",
		Type:         library.MediaTypeVideo,
		RootName:     "videos",
		RelativePath: "clip.mp4",
		Thumbnail: library.Thumbnail{
			URL:      "/api/thumbnails/video-id?v=new&state=pending",
			Kind:     library.ThumbnailKindVideo,
			Status:   library.ThumbnailStatusPending,
			CacheKey: "new",
		},
	}
	service.ApplyChanges([]library.Media{item}, nil)
	revision := service.Revision()
	stale := item
	stale.Thumbnail.CacheKey = "old"

	setThumbnailStatus(service, stale, library.ThumbnailStatusReady)

	if got := service.Revision(); got != revision {
		t.Fatalf("revision = %d, want %d", got, revision)
	}
	updated, err := service.Get(item.ID)
	if err != nil || updated.Thumbnail.Status != library.ThumbnailStatusPending {
		t.Fatalf("item = %#v, error = %v", updated, err)
	}
}

func TestReconcileMarksReadyVideoPendingWhenCacheIsMissing(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	service, err := library.NewService(library.MediaRootSettings{}, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	item := library.Media{
		ID:           "video-id",
		Type:         library.MediaTypeVideo,
		RootName:     "videos",
		RelativePath: "clip.mp4",
		Thumbnail: library.Thumbnail{
			URL:      "/api/thumbnails/video-id?v=key&state=ready",
			Kind:     library.ThumbnailKindVideo,
			Status:   library.ThumbnailStatusReady,
			CacheKey: "key",
		},
	}
	service.ApplyChanges([]library.Media{item}, nil)
	manager, err := thumbnail.NewManager(thumbnail.Options{
		CacheDir: t.TempDir(),
		Resolver: service,
		Idle:     canceledIdleWaiter{},
		Extract:  unusedExtractor{},
		Logger:   logger,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()

	reconcileVideoThumbnails(service, manager, true, logger)

	updated, err := service.Get(item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Thumbnail.Status != library.ThumbnailStatusPending ||
		!strings.Contains(updated.Thumbnail.URL, "state=pending") {
		t.Fatalf("thumbnail = %#v", updated.Thumbnail)
	}
}
