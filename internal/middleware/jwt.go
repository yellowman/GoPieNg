package middleware

import (
	"context"
	"net/http"
	"strings"
	"github.com/yellowman/GoPieNg/internal/auth"
)

type ctxKey string
const ClaimsKey ctxKey = "claims"

func JWT(jwtm *auth.Manager) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request){
			authz := r.Header.Get("Authorization")
			if authz == "" { http.Error(w, "missing token", 401); return }
			parts := strings.SplitN(authz, " ", 2)
			if len(parts) != 2 { http.Error(w, "bad token", 401); return }
			claims, err := jwtm.Parse(parts[1])
			if err != nil { http.Error(w, "invalid token", 401); return }
			ctx := context.WithValue(r.Context(), ClaimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func GetClaims(r *http.Request) *auth.Claims {
	if c, ok := r.Context().Value(ClaimsKey).(*auth.Claims); ok {
		return c
	}
	return nil
}
