package httpserver

import (
	"io"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAcceptsGzipHonorsQValue(t *testing.T) {
	if !acceptsGzip("br, gzip") {
		t.Fatal("gzip should be accepted when present")
	}
	if acceptsGzip("br, gzip;q=0") {
		t.Fatal("gzip should not be accepted with q=0")
	}
}

func TestStatusRecorderDelegatesReadFrom(t *testing.T) {
	underlying := &readFromResponseWriter{ResponseRecorder: httptest.NewRecorder()}
	recorder := &statusRecorder{ResponseWriter: underlying}

	n, err := recorder.ReadFrom(strings.NewReader("abcdef"))
	if err != nil {
		t.Fatalf("ReadFrom returned error: %v", err)
	}
	if !underlying.readFromCalled {
		t.Fatal("ReadFrom did not delegate to underlying writer")
	}
	if n != 6 {
		t.Fatalf("ReadFrom bytes = %d, want 6", n)
	}
}

type readFromResponseWriter struct {
	*httptest.ResponseRecorder
	readFromCalled bool
}

func (w *readFromResponseWriter) ReadFrom(reader io.Reader) (int64, error) {
	w.readFromCalled = true
	return io.Copy(w.ResponseRecorder, reader)
}
