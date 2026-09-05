package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/lib/pq"
	"github.com/yellowman/GoPieNg/internal/httpx"
)

var ErrUnauthenticated = errors.New("invalid session")

type Manager struct{ secret []byte }

func NewManager(secret []byte) *Manager { return &Manager{secret: append([]byte(nil), secret...)} }

type Claims struct {
	UserID   int64    `json:"uid"`
	Roles    []string `json:"roles"`
	Session  string   `json:"session"`
	Username string   `json:"-"`
	jwt.RegisteredClaims
}

// Binding sessions to a keyed digest of the stored password hash revokes them
// after ANY password update, including SQL resets, without a schema migration.
// Neither the password nor its stored hash is exposed in the JWT.
func (m *Manager) sessionTag(userID int64, hash string) string {
	h := hmac.New(sha256.New, m.secret)
	h.Write([]byte("gopieng-session-v1\x00" + strconv.FormatInt(userID, 10) + "\x00" + hash))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

func (m *Manager) Sign(userID int64, roles []string, passwordHash string) (string, error) {
	if userID <= 0 || passwordHash == "" {
		return "", ErrUnauthenticated
	}
	now := time.Now()
	c := Claims{UserID: userID, Roles: roles, Session: m.sessionTag(userID, passwordHash), RegisteredClaims: jwt.RegisteredClaims{
		Issuer: "gopieng", ExpiresAt: jwt.NewNumericDate(now.Add(24 * time.Hour)), IssuedAt: jwt.NewNumericDate(now),
	}}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString(m.secret)
}

func (m *Manager) Parse(token string) (*Claims, error) {
	if len(token) == 0 || len(token) > 8192 {
		return nil, ErrUnauthenticated
	}
	tk, err := jwt.ParseWithClaims(token, &Claims{}, func(t *jwt.Token) (interface{}, error) { return m.secret, nil },
		jwt.WithValidMethods([]string{"HS256"}), jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithIssuer("gopieng"))
	if err != nil {
		return nil, ErrUnauthenticated
	}
	c, ok := tk.Claims.(*Claims)
	if !ok || !tk.Valid || c.UserID <= 0 || c.Session == "" || c.IssuedAt == nil {
		return nil, ErrUnauthenticated
	}
	return c, nil
}

type rowQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// RefreshClaims obtains identity, status, password binding and current roles
// in one statement snapshot, avoiding torn authorization reads and nested
// database-pool acquisitions. It works with both a DB and a transaction.
func RefreshClaims(ctx context.Context, q rowQuerier, m *Manager, claims *Claims) (*Claims, error) {
	if claims == nil {
		return nil, ErrUnauthenticated
	}
	var username, hash string
	var status int
	var roles pq.StringArray
	err := q.QueryRowContext(ctx, `SELECT username,password,status,ARRAY(SELECT r.name FROM roles r JOIN user_roles ur ON ur.role=r.id WHERE ur."user"=users.id ORDER BY r.name) FROM users WHERE id=$1`, claims.UserID).Scan(&username, &hash, &status, &roles)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnauthenticated
	}
	if err != nil {
		return nil, err
	}
	if status != 1 || !hmac.Equal([]byte(claims.Session), []byte(m.sessionTag(claims.UserID, hash))) {
		return nil, ErrUnauthenticated
	}
	fresh := *claims
	fresh.Username = username
	fresh.Roles = []string(roles)
	return &fresh, nil
}

type loginReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func MakeLoginHandler(db *sql.DB, jwtm *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		var req loginReq
		if !httpx.Decode(w, r, &req) {
			return
		}
		if len(req.Username) > 32 || len(req.Password) > 1024 {
			http.Error(w, "invalid credentials", 401)
			return
		}
		var id int64
		var username, hash string
		var status int
		err := db.QueryRowContext(r.Context(), `SELECT id,username,password,status FROM users WHERE username=$1`, req.Username).Scan(&id, &username, &hash, &status)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && status != 1) {
			http.Error(w, "invalid credentials", 401)
			return
		}
		if err != nil {
			http.Error(w, "authentication service unavailable", 503)
			return
		}
		ok, err := CheckPassword(hash, req.Password)
		if err != nil {
			http.Error(w, "password service busy", 503)
			return
		}
		if !ok {
			http.Error(w, "invalid credentials", 401)
			return
		}
		if !strings.HasPrefix(hash, "$argon2id$") {
			upgraded, err := HashPassword(req.Password)
			if err != nil {
				http.Error(w, "password service unavailable", 503)
				return
			}
			// Compare-and-swap: never overwrite a concurrent password reset.
			res, err := db.ExecContext(r.Context(), `UPDATE users SET password=$1 WHERE id=$2 AND password=$3 AND status=1`, upgraded, id, hash)
			if err != nil {
				http.Error(w, "authentication service unavailable", 503)
				return
			}
			count, err := res.RowsAffected()
			if err != nil || count != 1 {
				http.Error(w, "credentials changed; sign in again", 401)
				return
			}
			hash = upgraded
		}
		claims, err := RefreshClaims(r.Context(), db, jwtm, &Claims{UserID: id, Session: jwtm.sessionTag(id, hash)})
		if errors.Is(err, ErrUnauthenticated) {
			http.Error(w, "invalid credentials", 401)
			return
		}
		if err != nil {
			http.Error(w, "authorization lookup failed", 503)
			return
		}
		token, err := jwtm.Sign(id, claims.Roles, hash)
		if err != nil {
			http.Error(w, "token signing failed", 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"token": token, "user": map[string]any{"id": id, "username": username, "roles": claims.Roles}})
	}
}

func MeHandler(_ *sql.DB, _ *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims := ClaimsFromContext(r.Context())
		if claims == nil {
			http.Error(w, "no authenticated user", 401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(map[string]any{"id": claims.UserID, "username": claims.Username, "roles": claims.Roles})
	}
}

type claimsContextKey struct{}

func SetClaimsContext(ctx context.Context, claims *Claims) context.Context {
	return context.WithValue(ctx, claimsContextKey{}, claims)
}
func ClaimsFromContext(ctx context.Context) *Claims {
	c, _ := ctx.Value(claimsContextKey{}).(*Claims)
	return c
}
