package httpx

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeBoundary(t *testing.T) {
	for _, tc := range []struct {
		body   string
		status int
	}{
		{`{"name":"ok"}`, 200}, {`{}`, 200}, {"", 400}, {`null`, 400}, {`[]`, 400}, {`{`, 400},
		{`{"extra":true}`, 400}, {`{"name":1}`, 400}, {`{} {}`, 400},
		{`{"name":"` + strings.Repeat("x", MaxJSONBody) + `"}`, 413},
	} {
		var dst struct {
			Name string `json:"name"`
		}
		w := httptest.NewRecorder()
		r := httptest.NewRequest("POST", "/", strings.NewReader(tc.body))
		ok := Decode(w, r, &dst)
		if w.Code != tc.status || ok != (tc.status == 200) {
			t.Fatalf("%.40q: status=%d ok=%v", tc.body, w.Code, ok)
		}
	}
}
