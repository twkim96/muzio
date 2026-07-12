package httpserver

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"muzio/backend/internal/library"
)

type LibraryEventSubscriber interface {
	SubscribeLibraryEvents() (<-chan library.LibraryEvent, func())
}

type heartbeatBroker struct {
	interval time.Duration
	mu       sync.Mutex
	nextID   uint64
	clients  map[uint64]chan struct{}
	stop     chan struct{}
}

func newHeartbeatBroker(interval time.Duration) *heartbeatBroker {
	return &heartbeatBroker{interval: interval}
}

func (b *heartbeatBroker) subscribe() (<-chan struct{}, func()) {
	channel := make(chan struct{}, 1)
	b.mu.Lock()
	if b.clients == nil {
		b.clients = make(map[uint64]chan struct{})
	}
	b.nextID++
	id := b.nextID
	b.clients[id] = channel
	if len(b.clients) == 1 {
		b.stop = make(chan struct{})
		go b.run(b.stop)
	}
	b.mu.Unlock()

	var once sync.Once
	return channel, func() {
		once.Do(func() {
			b.mu.Lock()
			delete(b.clients, id)
			if len(b.clients) == 0 && b.stop != nil {
				close(b.stop)
				b.stop = nil
			}
			b.mu.Unlock()
		})
	}
}

func (b *heartbeatBroker) run(stop <-chan struct{}) {
	ticker := time.NewTicker(b.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			b.mu.Lock()
			for _, channel := range b.clients {
				select {
				case channel <- struct{}{}:
				default:
				}
			}
			b.mu.Unlock()
		case <-stop:
			return
		}
	}
}

func libraryEventsHandler(
	subscriber LibraryEventSubscriber,
	currentRevision func() uint64,
	heartbeats *heartbeatBroker,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}

		events, unsubscribe := subscriber.SubscribeLibraryEvents()
		defer unsubscribe()
		heartbeat, unsubscribeHeartbeat := heartbeats.subscribe()
		defer unsubscribeHeartbeat()

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprint(w, ": connected\n\n")

		lastRevision := parseLastEventID(r.Header.Get("Last-Event-ID"))
		revision := currentRevision()
		if r.Header.Get("Last-Event-ID") == "" || revision != lastRevision {
			if err := writeLibraryEvent(w, library.LibraryEvent{
				Revision: revision,
				AffectedTypes: []library.MediaType{
					library.MediaTypeAudio,
					library.MediaTypeVideo,
					library.MediaTypeImage,
				},
				Reason: "connected",
			}); err != nil {
				return
			}
			lastRevision = revision
		}
		flusher.Flush()

		for {
			select {
			case event, ok := <-events:
				if !ok {
					return
				}
				if event.Revision <= lastRevision {
					continue
				}
				if err := writeLibraryEvent(w, event); err != nil {
					return
				}
				lastRevision = event.Revision
				flusher.Flush()
			case <-heartbeat:
				if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
					return
				}
				flusher.Flush()
			case <-r.Context().Done():
				return
			}
		}
	}
}

func writeLibraryEvent(w http.ResponseWriter, event library.LibraryEvent) error {
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(
		w,
		"id: %d\nevent: library\ndata: %s\n\n",
		event.Revision,
		data,
	)
	return err
}

func parseLastEventID(value string) uint64 {
	revision, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return 0
	}
	return revision
}
