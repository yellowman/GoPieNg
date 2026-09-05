package middleware

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/yellowman/GoPieNg/internal/auth"
)

type ctxKey string

const ClaimsKey ctxKey = "claims"

func JWT(jwtm *auth.Manager, db *sql.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("Authorization")
			if len(header) > 8200 {
				http.Error(w, "invalid token", 401)
				return
			}
			parts := strings.Fields(header)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
				http.Error(w, "missing or invalid token", 401)
				return
			}
			claims, err := jwtm.Parse(parts[1])
			if err != nil {
				http.Error(w, "invalid token", 401)
				return
			}
			claims, err = auth.RefreshClaims(r.Context(), db, jwtm, claims)
			if errors.Is(err, auth.ErrUnauthenticated) {
				http.Error(w, "session expired or user disabled", 401)
				return
			}
			if err != nil {
				http.Error(w, "authorization service unavailable", 503)
				return
			}
			ctx := context.WithValue(r.Context(), ClaimsKey, claims)
			ctx = auth.SetClaimsContext(ctx, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func GetClaims(r *http.Request) *auth.Claims {
	c, _ := r.Context().Value(ClaimsKey).(*auth.Claims)
	return c
}
