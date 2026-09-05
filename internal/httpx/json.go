// Package httpx contains shared HTTP boundary validation.
package httpx

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

const MaxJSONBody = 64 << 10

// Decode accepts exactly one JSON object, rejects unknown fields, and limits
// memory use even for FastCGI requests (which have no http.Server body limit).
func Decode(w http.ResponseWriter, r *http.Request, out any) bool {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxJSONBody))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "cannot read request", http.StatusBadRequest)
		}
		return false
	}
	body = bytes.TrimSpace(body)
	if len(body) == 0 || body[0] != '{' {
		http.Error(w, "expected a JSON object", http.StatusBadRequest)
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		http.Error(w, "invalid JSON request", http.StatusBadRequest)
		return false
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		http.Error(w, "expected one JSON object", http.StatusBadRequest)
		return false
	}
	return true
}
