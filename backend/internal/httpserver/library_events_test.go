package httpserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"muzio/backend/internal/library"
)

type fakeLibraryEventSubscriber struct {
	events     chan library.LibraryEvent
	subscribed chan struct{}
	once       sync.Once
}

func (f *fakeLibraryEventSubscriber) SubscribeLibraryEvents() (<-chan library.LibraryEvent, func()) {
	f.once.Do(func() { close(f.subscribed) })
	return f.events, func() {}
}

type flushRecorder struct {
	*httptest.ResponseRecorder
	flushed chan struct{}
}

func (r *flushRecorder) Flush() {
	r.ResponseRecorder.Flush()
	select {
	case r.flushed <- struct{}{}:
	default:
	}
}

func TestLibraryEventsStreamsCurrentAndChangedRevision(t *testing.T) {
	subscriber := &fakeLibraryEventSubscriber{
		events:     make(chan library.LibraryEvent, 1),
		subscribed: make(chan struct{}),
	}
	handler := loggingMiddleware(
		testLogger(),
		libraryEventsHandler(
			subscriber,
			func() uint64 { return 3 },
			newHeartbeatBroker(time.Hour),
		),
	)
	ctx, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodGet, "/api/library/events", nil).WithContext(ctx)
	recorder := &flushRecorder{
		ResponseRecorder: httptest.NewRecorder(),
		flushed:          make(chan struct{}, 4),
	}
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(recorder, request)
		close(done)
	}()

	select {
	case <-recorder.flushed:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for initial event")
	}
	subscriber.events <- library.LibraryEvent{
		Revision:      4,
		AffectedTypes: []library.MediaType{library.MediaTypeAudio},
		Reason:        "watch",
	}
	select {
	case <-recorder.flushed:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for changed event")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("event handler did not stop")
	}

	text := recorder.Body.String()
	if !strings.Contains(text, "id: 3") ||
		!strings.Contains(text, `"reason":"connected"`) ||
		!strings.Contains(text, "id: 4") ||
		!strings.Contains(text, `"affectedTypes":["audio"]`) {
		t.Fatalf("stream = %q", text)
	}
}

func TestLibraryEventsReconnectSkipsAlreadySeenRevision(t *testing.T) {
	subscriber := &fakeLibraryEventSubscriber{
		events:     make(chan library.LibraryEvent, 1),
		subscribed: make(chan struct{}),
	}
	handler := libraryEventsHandler(
		subscriber,
		func() uint64 { return 7 },
		newHeartbeatBroker(time.Hour),
	)
	ctx, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodGet, "/api/library/events", nil).WithContext(ctx)
	request.Header.Set("Last-Event-ID", "7")
	recorder := &flushRecorder{
		ResponseRecorder: httptest.NewRecorder(),
		flushed:          make(chan struct{}, 2),
	}
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(recorder, request)
		close(done)
	}()
	select {
	case <-recorder.flushed:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for connection flush")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("event handler did not stop")
	}
	if strings.Contains(recorder.Body.String(), "data:") {
		t.Fatalf("unexpected replay: %q", recorder.Body.String())
	}
}

func TestLibraryEventsReconnectReportsLowerServerRevision(t *testing.T) {
	subscriber := &fakeLibraryEventSubscriber{
		events:     make(chan library.LibraryEvent, 1),
		subscribed: make(chan struct{}),
	}
	handler := libraryEventsHandler(
		subscriber,
		func() uint64 { return 2 },
		newHeartbeatBroker(time.Hour),
	)
	ctx, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodGet, "/api/library/events", nil).WithContext(ctx)
	request.Header.Set("Last-Event-ID", "9")
	recorder := &flushRecorder{
		ResponseRecorder: httptest.NewRecorder(),
		flushed:          make(chan struct{}, 2),
	}
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(recorder, request)
		close(done)
	}()
	select {
	case <-recorder.flushed:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for reset event")
	}
	cancel()
	<-done
	if !strings.Contains(recorder.Body.String(), "id: 2") {
		t.Fatalf("stream = %q", recorder.Body.String())
	}
}

func TestHeartbeatBrokerRunsOnlyWithSubscribers(t *testing.T) {
	broker := newHeartbeatBroker(time.Hour)
	if broker.stop != nil {
		t.Fatal("heartbeat started without subscribers")
	}
	_, unsubscribeFirst := broker.subscribe()
	stop := broker.stop
	if stop == nil {
		t.Fatal("heartbeat did not start for first subscriber")
	}
	_, unsubscribeSecond := broker.subscribe()
	if broker.stop != stop {
		t.Fatal("second subscriber started another heartbeat")
	}
	unsubscribeFirst()
	if broker.stop == nil {
		t.Fatal("heartbeat stopped while a subscriber remained")
	}
	unsubscribeSecond()
	if broker.stop != nil {
		t.Fatal("heartbeat remained after last subscriber")
	}
}
