package httpserver

import (
	"bytes"
	"encoding/json"
	"image"
	"image/jpeg"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHLSThumbnailSharedBoundedAndDoesNotRenewViewing(t *testing.T) {
	s, now := testHLSRegistry(t)
	row := registerHLS(t, s, "https://example.com/live")
	row.polling = true
	var jpegBytes bytes.Buffer
	if err := jpeg.Encode(&jpegBytes, image.NewRGBA(image.Rect(0, 0, 192, 108)), nil); err != nil {
		t.Fatal(err)
	}
	endpoint := "http://muzio.test" + row.cache.prefix + "thumbnail.jpg"
	touched := row.touched
	*now = now.Add(10 * time.Minute)
	for _, method := range []string{"PUT", "GET"} {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest(method, endpoint, bytes.NewReader(jpegBytes.Bytes())))
		if (method == "PUT" && w.Code != 204) || (method == "GET" && (w.Code != 200 || !bytes.Equal(w.Body.Bytes(), jpegBytes.Bytes()))) {
			t.Fatal(method, w.Code)
		}
	}
	if !row.touched.Equal(touched) {
		t.Fatal("thumbnail operations extended recording lifetime")
	}
	list := hlsRequest(s, "GET", "")
	var data struct{ Items []hlsSession }
	if json.Unmarshal(list.Body.Bytes(), &data) != nil || len(data.Items) != 1 || !strings.Contains(data.Items[0].ThumbnailURL, "thumbnail.jpg?v=") {
		t.Fatal(list.Body.String())
	}
	for _, body := range [][]byte{[]byte("not a JPEG"), bytes.Repeat([]byte{1}, 65<<10)} {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest("PUT", endpoint, bytes.NewReader(body)))
		if w.Code != 400 && w.Code != 413 {
			t.Fatal("invalid upload accepted", w.Code)
		}
	}
	*now = now.Add(20 * time.Minute)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", endpoint, nil))
	if w.Code != 410 {
		t.Fatal("thumbnail outlived HLS session", w.Code)
	}
}
