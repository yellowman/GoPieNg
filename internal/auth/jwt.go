package auth

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	time "time"

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
	claims := Claims{ UserID: userID, Roles: roles, RegisteredClaims: jwt.RegisteredClaims{ ExpiresAt: jwt.NewNumericDate(time.Now().Add(24*time.Hour)), IssuedAt: jwt.NewNumericDate(time.Now()) } }
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return t.SignedString(m.secret)
}

func (m *Manager) Parse(token string) (*Claims, error) {
	tk, err := jwt.ParseWithClaims(token, &Claims{}, func(t *jwt.Token)(interface{}, error){ return m.secret, nil })
	if err != nil { return nil, err }
	c, ok := tk.Claims.(*Claims)
	if !ok || !tk.Valid { return nil, errors.New("invalid token") }
	return c, nil
}

type loginReq struct{ Username, Password string }
type loginResp struct{ Token string `json:"token"`; User struct{ ID int64 `json:"id"`; Username string `json:"username"`; Roles []string `json:"roles"` } `json:"user"` }

func MakeLoginHandler(db *sql.DB, jwtm *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request){
		var req loginReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil { http.Error(w, "bad json", 400); return }
		var id int64; var username, passhash string; var status int
		if err := db.QueryRowContext(r.Context(), `SELECT id, username, password, status FROM users WHERE username=$1`, req.Username).Scan(&id,&username,&passhash,&status); err != nil { http.Error(w, "invalid credentials", 401); return }
		if status == 0 { http.Error(w, "user disabled", 403); return }
		if !CheckRFC2307SSHA(passhash, req.Password) { http.Error(w, "invalid credentials", 401); return }
		rows, _ := db.QueryContext(r.Context(), `SELECT r.name FROM roles r JOIN user_roles ur ON ur.role=r.id WHERE ur."user"=$1`, id)
		defer rows.Close()
		var roles []string
		for rows.Next(){ var rn string; rows.Scan(&rn); roles = append(roles, rn) }
		token, _ := jwtm.Sign(id, roles)
		var out loginResp; out.Token = token; out.User.ID = id; out.User.Username = username; out.User.Roles = roles
		w.Header().Set("Content-Type","application/json")
		json.NewEncoder(w).Encode(out)
	}
}

func MeHandler(db *sql.DB, jwtm *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request){
		authz := r.Header.Get("Authorization")
		parts := strings.SplitN(authz, " ", 2)
		if len(parts) != 2 { http.Error(w, "no token", 401); return }
		claims, err := jwtm.Parse(parts[1]); if err != nil { http.Error(w, "invalid token", 401); return }
		var username string
		if err := db.QueryRowContext(context.Background(), `SELECT username FROM users WHERE id=$1`, claims.UserID).Scan(&username); err != nil { http.Error(w, "user missing", 401); return }
		w.Header().Set("Content-Type","application/json")
		json.NewEncoder(w).Encode(map[string]any{"id": claims.UserID, "username": username, "roles": claims.Roles})
	}
}
