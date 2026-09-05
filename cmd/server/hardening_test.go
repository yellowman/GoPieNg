package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yellowman/GoPieNg/internal/auth"
	"github.com/yellowman/GoPieNg/internal/db"
)

func TestForwardingRequiresTrustedPeer(t *testing.T) {
	for _, tc := range []struct{ trusted, peer, forwarded, want string }{
		{"", "198.51.100.2:1000", "1.2.3.4", "198.51.100.2:1000"},
		{"127.0.0.1/32", "127.0.0.1:1000", "1.2.3.4, 198.51.100.2", "198.51.100.2"},
		{"127.0.0.1/32,10.0.0.0/8", "127.0.0.1:1000", "198.51.100.2, 10.0.0.1", "198.51.100.2"},
		{"127.0.0.1/32", "127.0.0.1:1000", "garbage", "127.0.0.1:1000"},
		{"::1/128", "[::1]:1000", "2001:db8::1", "2001:db8::1"},
	} {
		mw, err := trustedProxyMiddleware(tc.trusted)
		if err != nil {
			t.Fatal(err)
		}
		h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.RemoteAddr != tc.want {
				t.Errorf("got %s want %s", r.RemoteAddr, tc.want)
			}
		}))
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = tc.peer
		r.Header.Set("X-Forwarded-For", tc.forwarded)
		h.ServeHTTP(httptest.NewRecorder(), r)
	}
	if _, err := trustedProxyMiddleware("not-a-network"); err == nil {
		t.Fatal("invalid proxy configuration accepted")
	}
}

func TestRateLimitIgnoresSpoofedForwardedIP(t *testing.T) {
	h := rateLimiter(1, time.Minute)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	for i, forwarded := range []string{"198.51.100.1", "198.51.100.2"} {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = "192.0.2.1:1234"
		r.Header.Set("X-Forwarded-For", forwarded)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		want := 200
		if i == 1 {
			want = 429
		}
		if w.Code != want {
			t.Fatal(w.Code, want)
		}
	}
}

func TestEmbeddedAssetsAndAPINotFound(t *testing.T) {
	t.Setenv("PIENG_TRUSTED_PROXIES", "")
	t.Setenv("PIENG_CORS_ORIGINS", "")
	h, err := buildRouter(&db.DB{}, auth.NewManager([]byte(strings.Repeat("s", 32))), false, "", false)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/", "/js/app.js", "/js/refresh.js", "/css/styles.css"} {
		r := httptest.NewRequest("GET", path, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 || w.Body.Len() == 0 {
			t.Fatalf("%s %d", path, w.Code)
		}
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/unmatched", nil)
	r.Header.Set("Origin", "https://untrusted.example")
	h.ServeHTTP(w, r)
	notFound := httptest.NewRecorder()
	h.ServeHTTP(notFound, httptest.NewRequest("GET", "/api/missing", nil))
	if notFound.Code != 404 {
		t.Fatal("unknown API route returned SPA", notFound.Code)
	}
	if w.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("CORS enabled by default")
	}
}
