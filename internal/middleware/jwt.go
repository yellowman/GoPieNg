package middleware

import (
	"context"
	"database/sql"
	"net/http"
	"strings"

	"github.com/yellowman/GoPieNg/internal/auth"
)

type ctxKey string

const ClaimsKey ctxKey = "claims"

// JWT validates the signed token, then refreshes the user's status and roles
// from the database. This makes disable/delete/role changes effective on the
// next request instead of leaving the old JWT authoritative until expiration.
func JWT(jwtm *auth.Manager, db *sql.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authz := r.Header.Get("Authorization")
			parts := strings.Fields(authz)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
				http.Error(w, "missing or invalid token", http.StatusUnauthorized)
				return
			}

			claims, err := jwtm.Parse(parts[1])
			if err != nil {
				http.Error(w, "invalid token", http.StatusUnauthorized)
				return
			}

			var status int
			if err := db.QueryRowContext(r.Context(),
				`SELECT status FROM users WHERE id=$1`, claims.UserID).Scan(&status); err != nil || status == 0 {
				http.Error(w, "user disabled or missing", http.StatusUnauthorized)
				return
			}

			rows, err := db.QueryContext(r.Context(),
				`SELECT r.name FROM roles r JOIN user_roles ur ON ur.role=r.id WHERE ur."user"=$1 ORDER BY r.name`,
				claims.UserID)
			if err != nil {
				http.Error(w, "authorization lookup failed", http.StatusInternalServerError)
				return
			}
		defer rows.Close()

		roles := make([]string, 0, len(claims.Roles))
		for rows.Next() {
			var role string
			if err := rows.Scan(&role); err != nil {
				http.Error(w, "authorization lookup failed", http.StatusInternalServerError)
				return
			}
			roles = append(roles, role)
		}
		if err := rows.Err(); err != nil {
			http.Error(w, "authorization lookup failed", http.StatusInternalServerError)
			return
		}

		claims.Roles = roles
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
