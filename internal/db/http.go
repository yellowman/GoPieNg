package db

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net"
	"net/http"
	"net/netip"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/lib/pq"
	"github.com/yellowman/GoPieNg/internal/auth"
	"github.com/yellowman/GoPieNg/internal/httpx"
	"github.com/yellowman/GoPieNg/internal/middleware"
)

type apiError struct {
	status  int
	message string
}

func (e *apiError) Error() string              { return e.message }
func problem(status int, message string) error { return &apiError{status, message} }

func respondError(w http.ResponseWriter, err error) {
	var e *apiError
	var pg *pq.Error
	switch {
	case errors.As(err, &e):
		http.Error(w, e.message, e.status)
	case errors.Is(err, auth.ErrPasswordBusy):
		http.Error(w, "password service busy", 503)
	case errors.Is(err, auth.ErrUnauthenticated):
		http.Error(w, "authentication required", 401)
	case errors.Is(err, sql.ErrNoRows):
		http.Error(w, "not found", 404)
	case errors.Is(err, context.DeadlineExceeded):
		http.Error(w, "request timed out", 504)
	case errors.Is(err, context.Canceled):
		http.Error(w, "request canceled", 408)
	case errors.As(err, &pg) && (pg.Code == "23505" || pg.Code == "23P01"):
		http.Error(w, "allocation or record already exists", 409)
	case errors.As(err, &pg) && pg.Code == "23503":
		http.Error(w, "record is still referenced or its parent no longer exists", 409)
	case errors.As(err, &pg) && (pg.Code.Class() == "22" || pg.Code == "23514"):
		http.Error(w, "invalid field value", 400)
	default:
		log.Printf("API operation failed: %v", err)
		http.Error(w, "internal server error", 500)
	}
}

func decodeRequest(w http.ResponseWriter, r *http.Request, out any) bool {
	return httpx.Decode(w, r, out)
}

func parseHost(s string) (netip.Addr, error) {
	a, err := netip.ParseAddr(s)
	if err != nil || a.Zone() != "" {
		return netip.Addr{}, problem(400, "expected a literal IP address without a prefix or zone")
	}
	return a.Unmap(), nil
}

type ipProbe struct {
	db    *sql.DB
	dial  func(context.Context, string, string) (net.Conn, error)
	slots chan struct{}
}

func newIPProbe(db *sql.DB) *ipProbe {
	d := &net.Dialer{Timeout: time.Second}
	return &ipProbe{db: db, dial: d.DialContext, slots: make(chan struct{}, 8)}
}

func (p *ipProbe) serveHTTP(w http.ResponseWriter, r *http.Request) {
	if !hasRole(middleware.GetClaims(r), "editor") {
		respondError(w, problem(403, "editor required for active probes"))
		return
	}
	a, err := parseHost(chi.URLParam(r, "ip"))
	if err != nil {
		respondError(w, err)
		return
	}
	// Private addresses are legitimate WISP targets; special-use local and
	// multicast addresses are not. Never resolve client-supplied hostnames.
	if !a.IsGlobalUnicast() || a.IsLoopback() || a.IsLinkLocalUnicast() {
		respondError(w, problem(400, "address is not a routable probe target"))
		return
	}
	var managed bool
	err = p.db.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM networks WHERE NOT subdivide AND address_range >>= $1::inet)`, a.String()).Scan(&managed)
	if err != nil {
		respondError(w, err)
		return
	}
	if !managed {
		respondError(w, problem(403, "address is not in a managed leaf network"))
		return
	}
	select {
	case p.slots <- struct{}{}:
		defer func() { <-p.slots }()
	default:
		respondError(w, problem(429, "too many active probes"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	responds := false
	for _, port := range []string{"22", "80", "443", "23"} {
		if ctx.Err() != nil {
			break
		}
		conn, err := p.dial(ctx, "tcp", net.JoinHostPort(a.String(), port))
		if err == nil {
			conn.Close()
			responds = true
			break
		}
		if errors.Is(err, syscall.ECONNREFUSED) {
			responds = true
			break
		}
	}
	if r.Context().Err() != nil {
		respondError(w, r.Context().Err())
		return
	}
	writeJSON(w, map[string]any{"ip": a.String(), "responds": responds})
}
