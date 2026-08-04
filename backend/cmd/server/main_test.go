package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"muzio/backend/internal/fallback"
	"muzio/backend/internal/httpserver"
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

type protocolTestLister struct{}

func (protocolTestLister) List(library.MediaType) []library.Media {
	return []library.Media{}
}

func (protocolTestLister) SubscribeLibraryEvents() (<-chan library.LibraryEvent, func()) {
	return make(chan library.LibraryEvent), func() {}
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

func TestConfigureServerTLSLoadsCertificateAndEnforcesTLS12(t *testing.T) {
	_, certPEM, keyPEM := generateTestCertificate(t)
	certPath := t.TempDir() + "/cert.pem"
	keyPath := t.TempDir() + "/key.pem"
	if err := os.WriteFile(certPath, certPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	server := &http.Server{TLSConfig: &tls.Config{MinVersion: tls.VersionTLS10}}

	if err := configureServerTLS(server, certPath, keyPath); err != nil {
		t.Fatal(err)
	}
	if server.TLSConfig.MinVersion != tls.VersionTLS12 {
		t.Fatalf("minimum TLS version = %d, want TLS 1.2", server.TLSConfig.MinVersion)
	}
	if len(server.TLSConfig.Certificates) != 1 {
		t.Fatalf("certificate count = %d, want 1", len(server.TLSConfig.Certificates))
	}
	if err := configureServerTLS(server, "", ""); err == nil {
		t.Fatal("empty TLS paths were accepted")
	}
}

func TestServeHTTPServerNegotiatesHTTP2AcrossAppEndpoints(t *testing.T) {
	certificate, _, _ := generateTestCertificate(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	slowRangeStarted := make(chan struct{})
	releaseSlowRange := make(chan struct{})
	mediaHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "" {
			w.Header().Set("Content-Range", "bytes 0-3/4")
			w.WriteHeader(http.StatusPartialContent)
		}
		if strings.HasSuffix(r.URL.Path, "/slow") {
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			close(slowRangeStarted)
			<-releaseSlowRange
		}
		_, _ = w.Write([]byte("data"))
	})
	server := &http.Server{
		Handler: httpserver.NewHandler(
			logger,
			protocolTestLister{},
			mediaHandler,
		),
		TLSConfig: &tls.Config{
			Certificates: []tls.Certificate{certificate},
			MinVersion:   tls.VersionTLS12,
		},
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	serveDone := make(chan error, 1)
	go func() {
		serveDone <- serveHTTPServer(server, listener, true)
	}()
	t.Cleanup(func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
		select {
		case serveErr := <-serveDone:
			if serveErr != nil && serveErr != http.ErrServerClosed {
				t.Errorf("ServeTLS returned %v", serveErr)
			}
		case <-time.After(time.Second):
			t.Error("ServeTLS did not stop")
		}
	})

	baseURL := "https://" + listener.Addr().String()
	http2Client := &http.Client{Transport: &http.Transport{
		TLSClientConfig:   &tls.Config{InsecureSkipVerify: true}, // test certificate
		ForceAttemptHTTP2: true,
	}}
	for _, test := range []struct {
		method     string
		path       string
		rangeValue string
		wantStatus int
	}{
		{method: http.MethodGet, path: "/healthz", wantStatus: http.StatusOK},
		{method: http.MethodGet, path: "/api/library?type=video", wantStatus: http.StatusOK},
		{method: http.MethodHead, path: "/api/media/video-id", wantStatus: http.StatusOK},
		{method: http.MethodGet, path: "/api/media/video-id", rangeValue: "bytes=0-3", wantStatus: http.StatusPartialContent},
	} {
		req, reqErr := http.NewRequest(test.method, baseURL+test.path, nil)
		if reqErr != nil {
			t.Fatal(reqErr)
		}
		if test.rangeValue != "" {
			req.Header.Set("Range", test.rangeValue)
		}
		resp, requestErr := http2Client.Do(req)
		if requestErr != nil {
			t.Fatalf("GET %s: %v", test.path, requestErr)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != test.wantStatus {
			t.Fatalf("%s %s status = %d, want %d", test.method, test.path, resp.StatusCode, test.wantStatus)
		}
		if resp.ProtoMajor != 2 {
			t.Fatalf("%s %s protocol = %s, want HTTP/2", test.method, test.path, resp.Proto)
		}
		negotiatedProtocol := ""
		if resp.TLS != nil {
			negotiatedProtocol = resp.TLS.NegotiatedProtocol
		}
		if negotiatedProtocol != "h2" {
			t.Fatalf("%s %s ALPN = %q, want h2", test.method, test.path, negotiatedProtocol)
		}
	}

	slowRequest, err := http.NewRequest(http.MethodGet, baseURL+"/api/media/slow", nil)
	if err != nil {
		t.Fatal(err)
	}
	slowRequest.Header.Set("Range", "bytes=0-3")
	slowResponse, err := http2Client.Do(slowRequest)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-slowRangeStarted:
	case <-time.After(time.Second):
		t.Fatal("large Range simulation did not start")
	}
	apiClient := *http2Client
	apiClient.Timeout = time.Second
	apiResponse, err := apiClient.Get(baseURL + "/healthz")
	if err != nil {
		t.Fatalf("small API request was starved by an open Range: %v", err)
	}
	_, _ = io.Copy(io.Discard, apiResponse.Body)
	_ = apiResponse.Body.Close()
	if apiResponse.ProtoMajor != 2 || apiResponse.StatusCode != http.StatusOK {
		t.Fatalf("concurrent API response = %s %d", apiResponse.Proto, apiResponse.StatusCode)
	}
	close(releaseSlowRange)
	_, _ = io.Copy(io.Discard, slowResponse.Body)
	_ = slowResponse.Body.Close()

	eventsCtx, cancelEvents := context.WithCancel(context.Background())
	eventsReq, err := http.NewRequestWithContext(
		eventsCtx,
		http.MethodGet,
		baseURL+"/api/library/events",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	eventsResp, err := http2Client.Do(eventsReq)
	if err != nil {
		t.Fatal(err)
	}
	if eventsResp.ProtoMajor != 2 {
		t.Fatalf("SSE protocol = %s, want HTTP/2", eventsResp.Proto)
	}
	cancelEvents()
	_ = eventsResp.Body.Close()

	http1Client := &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true, // test certificate
			NextProtos:         []string{"http/1.1"},
		},
	}}
	resp, err := http1Client.Get(baseURL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	if resp.ProtoMajor != 1 {
		t.Fatalf("fallback protocol = %s, want HTTP/1.1", resp.Proto)
	}
	negotiatedProtocol := ""
	if resp.TLS != nil {
		negotiatedProtocol = resp.TLS.NegotiatedProtocol
	}
	if negotiatedProtocol != "http/1.1" {
		t.Fatalf("fallback ALPN = %q, want http/1.1", negotiatedProtocol)
	}
}

func TestAppRuntimeOptionalCachesDoNotExposeTypedNilInterfaces(t *testing.T) {
	runtime := appRuntime{}
	if runtime.VideoOptimization() != nil {
		t.Fatal("nil video optimization manager became a non-nil interface")
	}
	if runtime.AudioResumeCache() != nil {
		t.Fatal("nil audio resume manager became a non-nil interface")
	}
}

func TestConfigureVideoOptimizationStaysDisabledForMissingDependencies(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	available := fallback.FFmpegInfo{Available: true, Path: "ffmpeg"}
	tests := []struct {
		name       string
		configPath string
		ffmpeg     fallback.FFmpegInfo
		lookup     func(string) (string, error)
	}{
		{
			name:       "ffmpeg unavailable",
			configPath: "config.json",
			ffmpeg:     fallback.FFmpegInfo{Reason: "missing"},
			lookup:     func(string) (string, error) { t.Fatal("ffprobe lookup should not run"); return "", nil },
		},
		{
			name:       "ffprobe unavailable",
			configPath: "config.json",
			ffmpeg:     available,
			lookup:     func(string) (string, error) { return "", errors.New("missing") },
		},
		{
			name:       "cache initialization failure",
			configPath: "",
			ffmpeg:     available,
			lookup:     func(string) (string, error) { return "ffprobe", nil },
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if manager := configureVideoOptimizationWithProbeLookup(test.configPath, nil, test.ffmpeg, logger, test.lookup); manager != nil {
				manager.Close()
				t.Fatal("disabled video optimization returned a manager")
			}
		})
	}
}

func TestVideoHLSPlanOptionsAreBoundedAndConfigurable(t *testing.T) {
	defaults, err := videoHLSPlanOptions(func(string) (string, bool) { return "", false })
	if err != nil || defaults.MinimumMovieIndexBytes != 16<<20 || defaults.MaximumGOPSeconds != 12 || defaults.TargetSegmentSeconds != 6 {
		t.Fatalf("defaults=%#v error=%v", defaults, err)
	}
	custom, err := videoHLSPlanOptions(func(key string) (string, bool) {
		values := map[string]string{"VMA_HLS_MIN_MOOV_MIB": "32", "VMA_HLS_MAX_GOP_SECONDS": "9.5"}
		value, found := values[key]
		return value, found
	})
	if err != nil || custom.MinimumMovieIndexBytes != 32<<20 || custom.MaximumGOPSeconds != 9.5 {
		t.Fatalf("custom=%#v error=%v", custom, err)
	}
	for _, test := range []struct{ key, value string }{
		{key: "VMA_HLS_MIN_MOOV_MIB", value: "0"},
		{key: "VMA_HLS_MAX_GOP_SECONDS", value: "121"},
	} {
		if _, err := videoHLSPlanOptions(func(key string) (string, bool) {
			return test.value, key == test.key
		}); err == nil {
			t.Fatalf("%s=%q accepted", test.key, test.value)
		}
	}
}

func TestServeHTTPServerKeepsPlainHTTP11(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})}
	serveDone := make(chan error, 1)
	go func() {
		serveDone <- serveHTTPServer(server, listener, false)
	}()
	t.Cleanup(func() {
		_ = server.Close()
		select {
		case serveErr := <-serveDone:
			if serveErr != nil && serveErr != http.ErrServerClosed {
				t.Errorf("Serve returned %v", serveErr)
			}
		case <-time.After(time.Second):
			t.Error("plain HTTP server did not stop")
		}
	})

	resp, err := http.Get("http://" + listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.ProtoMajor != 1 || resp.TLS != nil {
		t.Fatalf("plain response protocol = %s TLS=%v, want HTTP/1.1 without TLS", resp.Proto, resp.TLS != nil)
	}
}

func generateTestCertificate(t *testing.T) (tls.Certificate, []byte, []byte) {
	t.Helper()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "127.0.0.1"},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	derBytes, err := x509.CreateCertificate(rand.Reader, template, template, &privateKey.PublicKey, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	privateDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: derBytes})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateDER})
	certificate, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	return certificate, certPEM, keyPEM
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
	var fullReconciliations atomic.Int32
	var incrementalSyncs atomic.Int32
	done := make(chan struct{})
	go func() {
		runVideoThumbnailScheduler(
			ctx,
			events,
			hourly,
			time.Millisecond,
			func() thumbnailSchedulerState {
				fullReconciliations.Add(1)
				return thumbnailSchedulerState{}
			},
			func(*thumbnailSchedulerState) bool {
				incrementalSyncs.Add(1)
				return true
			},
		)
		close(done)
	}()

	deadline := time.Now().Add(time.Second)
	for incrementalSyncs.Load() != 1 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("thumbnail scheduler did not stop")
	}
	if got := fullReconciliations.Load(); got != 1 {
		t.Fatalf("full reconciliations = %d, want startup only", got)
	}
	if got := incrementalSyncs.Load(); got != 1 {
		t.Fatalf("incremental syncs = %d, want one coalesced sync", got)
	}
}

func TestThumbnailWorkerCountDefaultsToOneAndBoundsOverride(t *testing.T) {
	t.Setenv("VMA_THUMBNAIL_WORKERS", "")
	if got := thumbnailWorkerCount(); got != 1 {
		t.Fatalf("default workers = %d, want 1", got)
	}
	t.Setenv("VMA_THUMBNAIL_WORKERS", "3")
	if got := thumbnailWorkerCount(); got != 3 {
		t.Fatalf("override workers = %d, want 3", got)
	}
	t.Setenv("VMA_THUMBNAIL_WORKERS", "99")
	if got := thumbnailWorkerCount(); got != 4 {
		t.Fatalf("bounded workers = %d, want 4", got)
	}
	t.Setenv("VMA_THUMBNAIL_WORKERS", "invalid")
	if got := thumbnailWorkerCount(); got != 1 {
		t.Fatalf("invalid override workers = %d, want 1", got)
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
