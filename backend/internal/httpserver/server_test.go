package httpserver

import (
	"io"
	"log/slog"
	"testing"
	"time"

	"muzio/backend/internal/config"
)

func TestServerBoundsIdleConnectionsWithoutWriteTimeout(t *testing.T) {
	server := New(
		config.Config{Host: "127.0.0.1", Port: 7777},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		&stubLister{},
		nil,
	)

	if server.IdleTimeout != 90*time.Second {
		t.Fatalf("IdleTimeout = %v, want 90s", server.IdleTimeout)
	}
	if server.WriteTimeout != 0 {
		t.Fatalf("WriteTimeout = %v, want disabled for streaming and SSE", server.WriteTimeout)
	}
}
