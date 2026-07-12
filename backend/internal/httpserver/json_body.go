package httpserver

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

const maxJSONBodyBytes int64 = 64 << 10

func decodeJSONBody(w http.ResponseWriter, r *http.Request, destination any) bool {
	body := http.MaxBytesReader(w, r.Body, maxJSONBodyBytes)
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		writeJSONDecodeError(w, err)
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			http.Error(w, "request body must contain one JSON value", http.StatusBadRequest)
		} else {
			writeJSONDecodeError(w, err)
		}
		return false
	}
	return true
}

func writeJSONDecodeError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		http.Error(w, "JSON body too large", http.StatusRequestEntityTooLarge)
		return
	}
	http.Error(w, "invalid JSON body", http.StatusBadRequest)
}
