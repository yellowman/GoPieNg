package auth

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type Manager struct{ secret []byte }

func NewManager(secret []byte) *Manager { return &Manager{secret: secret} }

type Claims struct {
	UserID int64    `json:"uid"`
	Roles  []string `json:"roles"`
	jwt.RegisteredClaims
}

func (m *Manager) Sign(userID int64, roles []string) (string, error) {
	claims := Claims{
		UserID: userID,
		Roles:  roles,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return t.SignedString(m.secret)
}

func (m *Manager) Parse(token string) (*Claims, error) {
	tk, err := jwt.ParseWithClaims(
		token,
		&Claims{},
		func(t *jwt.Token) (interface{}, error) {
			if t.Method != jwt.SigningMethodHS256 {
				return nil, errors.New("unexpected signing method")
			}
			return m.secret, nil
		},
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
	)
	if err != nil {
		return nil, err
	}
	c, ok := tk.Claims.(*Claims)
	if !ok || !tk.Valid {
		return nil, errors.New("invalid token")
	}
	return c, nil
}

type loginReq struct{ Username, Password string }
type loginResp struct {
	Token string `json:"token"`
	User  struct {
		ID       int64    `json:"id"`
		Username string   `json:"username"`
		Roles    []string `json:"roles"`
	} `json:"user"`
}

func MakeLoginHandler(db *sql.DB, jwtm *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req loginReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		var id int64
		var username, passhash string
		var status int
		if err := db.QueryRowContext(r.Context(), `SELECT id, username, password, status FROM users WHERE username=$1`, req.Username).Scan(&id, &username, &passhash, &status); err != nil {
			http.Error(w, "invalid credentials", http.StatusUnauthorized)
			return
		}
		if status == 0 {
			http.Error(w, "user disabled", http.StatusForbidden)
			return
		}
		if !CheckRFC2307SSHA(passhash, req.Password) {
			http.Error(w, "invalid credentials", http.StatusUnauthorized)
			return
		}
		rows, err := db.QueryContext(r.Context(), `SELECT r.name FROM roles r JOIN user_roles ur ON ur.role=r.id WHERE ur."user"=$1 ORDER BY r.name`, id)
		if err != nil {
			http.Error(w, "authorization lookup failed", http.StatusInternalServerError)
			return
		}
		defer rows.Close()
		var roles []string
		for rows.Next() {
			var rn string
			if err := rows.Scan(&rn); err != nil {
				http.Error(w, "authorization lookup failed", http.StatusInternalServerError)
				return
			}
			roles = append(roles, rn)
		}
		if err := rows.Err(); err != nil {
			http.Error(w, "authorization lookup failed", http.StatusInternalServerError)
			return
		}
		token, err := jwtm.Sign(id, roles)
		if err != nil {
			http.Error(w, "token signing failed", http.StatusInternalServerError)
			return
		}
		var out loginResp
		out.Token = token
		out.User.ID = id
		out.User.Username = username
		out.User.Roles = roles
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out)
	}
}

func MeHandler(db *sql.DB, jwtm *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := ClaimsFromContext(r.Context())
		if claims == nil {
			http.Error(w, "no authenticated user", http.StatusUnauthorized)
			return
		}
		var username string
		if err := db.QueryRowContext(r.Context(), `SELECT username FROM users WHERE id=$1 AND status<>0`, claims.UserID).Scan(&username); err != nil {
			http.Error(w, "user missing", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"id": claims.UserID, "username": username, "roles": claims.Roles})
	}
}

type claimsContextKey struct{}

func SetClaimsContext(ctx context.Context, claims *Claims) context.Context {
	return context.WithValue(ctx, claimsContextKey{}, claims)
}

func ClaimsFromContext(ctx context.Context) *Claims {
	if claims, ok := ctx.Value(claimsContextKey{}).(*Claims); ok {
		return claims
	}
	return nil
}
