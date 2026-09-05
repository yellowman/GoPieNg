package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/yellowman/GoPieNg/internal/auth"
	"github.com/yellowman/GoPieNg/internal/ipam"
	"github.com/yellowman/GoPieNg/internal/middleware"
)

type Network struct {
	ID             int64
	Parent         sql.NullInt64
	AddressRange   string
	Description    sql.NullString
	Subdivide      bool
	ValidMasks     []int16
	Owner, Account sql.NullString
	Service        sql.NullInt64
}

type Host struct {
	Address     string
	NetworkID   int64
	Description string
}

type Change struct {
	Time   string
	Prefix string
	Change string
}

// Helper to write JSON response with proper Content-Type
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

// Check if user has admin role
func isAdmin(r *http.Request) bool {
	claims := middleware.GetClaims(r)
	if claims == nil {
		return false
	}
	for _, role := range claims.Roles {
		if role == "administrator" {
			return true
		}
	}
	return false
}

// Check if user can create/delete networks (administrator or creator)
func isCreator(r *http.Request) bool {
	claims := middleware.GetClaims(r)
	if claims == nil {
		return false
	}
	for _, role := range claims.Roles {
		if role == "administrator" || role == "creator" {
			return true
		}
	}
	return false
}

// Check if user can edit (administrator, creator, or editor)
func isEditor(r *http.Request) bool {
	claims := middleware.GetClaims(r)
	if claims == nil {
		return false
	}
	for _, role := range claims.Roles {
		if role == "administrator" || role == "creator" || role == "editor" {
			return true
		}
	}
	return false
}

// Format change log entry - parse JSON and make human-readable
func formatChangeLog(change, user string) string {
	// If it doesn't look like JSON, return as-is
	if !strings.HasPrefix(change, "{") {
		return change
	}

	var data map[string]any
	if err := json.Unmarshal([]byte(change), &data); err != nil {
		return change
	}

	if action, ok := data["action"].(string); ok {
		if actor, ok := data["actor"].(string); ok && actor != "" {
			user = actor
		}
		if action == "historical event" {
			if original, ok := data["details"].(string); ok {
				return formatChangeLog(original, user)
			}
		}
		if details := data["details"]; details != nil {
			text, _ := json.Marshal(details)
			action += " " + string(text)
		}
		if user != "" {
			action += " by " + user
		}
		return action
	}
	var parts []string

	// Handle common patterns
	if _, ok := data["created"]; ok {
		parts = append(parts, "created")
		if created, ok := data["created"].(map[string]any); ok {
			if desc, ok := created["description"].(string); ok && desc != "" {
				parts = append(parts, fmt.Sprintf("'%s'", desc))
			}
			if addr, ok := created["address_range"].(string); ok {
				parts = append(parts, addr)
			}
		}
	}

	if _, ok := data["updated"]; ok {
		parts = append(parts, "updated")
		if updated, ok := data["updated"].(map[string]any); ok {
			for k, v := range updated {
				if k == "id" || k == "parent" || k == "valid_masks" {
					continue
				}
				parts = append(parts, fmt.Sprintf("%s=%v", k, v))
			}
		}
	}

	if _, ok := data["deleted"]; ok {
		parts = append(parts, "deleted")
		if deleted, ok := data["deleted"].(map[string]any); ok {
			if desc, ok := deleted["description"].(string); ok && desc != "" {
				parts = append(parts, fmt.Sprintf("'%s'", desc))
			}
		}
	}

	if _, ok := data["service"]; ok {
		parts = append(parts, "service change")
	}

	if len(parts) == 0 {
		// Fallback: just list keys that changed
		for k := range data {
			parts = append(parts, k)
		}
	}

	result := strings.Join(parts, " ")
	if user != "" && !strings.Contains(result, user) {
		result += " by " + user
	}

	return result
}

func API(db *sql.DB, jwt *auth.Manager) http.Handler {
	r := chi.NewRouter()
	m := mutations{db: db, jwt: jwt}

	// Ping check endpoint - checks if IP responds
	// Uses TCP connect since ICMP requires setuid which pledge disables
	r.Get("/check-ip/{ip}", newIPProbe(db).serveHTTP)

	// Search endpoint - searches networks or hosts based on mode
	r.Get("/search", searchHandler(db))

	r.Get("/networks", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("q")
		parent := r.URL.Query().Get("parent_id")
		where := ""
		args := []any{}
		if parent != "" {
			where = "WHERE parent=$1"
			pid, err := strconv.ParseInt(parent, 10, 64)
			if err != nil || pid <= 0 {
				respondError(w, problem(400, "invalid parent id"))
				return
			}
			args = append(args, pid)
		} else {
			where = "WHERE parent IS NULL"
		}
		if q != "" {
			where += " AND "
			where += "(address_range::text ILIKE '%'||$" + fmt.Sprint(len(args)+1) + "||'%' OR coalesce(description,'') ILIKE '%'||$" + fmt.Sprint(len(args)+1) + "||'%' OR coalesce(owner,'') ILIKE '%'||$" + fmt.Sprint(len(args)+1) + "||'%')"
			args = append(args, q)
		}
		rows, err := db.QueryContext(r.Context(), "SELECT id, parent, address_range::text, description, subdivide, valid_masks, owner, account, service FROM networks "+where+" ORDER BY address_range", args...)
		if err != nil {
			respondError(w, err)
			return
		}
		defer rows.Close()

		out := []map[string]any{}
		for rows.Next() {
			var n Network
			var vm sql.NullString
			if err := rows.Scan(&n.ID, &n.Parent, &n.AddressRange, &n.Description, &n.Subdivide, &vm, &n.Owner, &n.Account, &n.Service); err != nil {
				respondError(w, err)
				return
			}
			if vm.Valid {
				n.ValidMasks = ipam.ParseSmallIntArray(vm.String)
			}
			out = append(out, map[string]any{
				"id": n.ID, "parent": n.Parent.Int64, "address_range": n.AddressRange,
				"description": n.Description.String, "subdivide": n.Subdivide, "valid_masks": n.ValidMasks,
				"owner": n.Owner.String, "account": n.Account.String, "service": n.Service.Int64,
			})
		}
		if err := rows.Err(); err != nil {
			respondError(w, err)
			return
		}
		writeJSON(w, out)
	})

	r.Get("/networks/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			respondError(w, err)
			return
		}
		var n Network
		var vm sql.NullString
		err = db.QueryRowContext(r.Context(), `SELECT id,parent,address_range::text,description,subdivide,valid_masks,owner,account,service FROM networks WHERE id=$1`, id).Scan(&n.ID, &n.Parent, &n.AddressRange, &n.Description, &n.Subdivide, &vm, &n.Owner, &n.Account, &n.Service)
		if err != nil {
			respondError(w, err)
			return
		}
		if vm.Valid {
			n.ValidMasks = ipam.ParseSmallIntArray(vm.String)
		}
		writeJSON(w, map[string]any{"network": map[string]any{
			"id": n.ID, "parent": n.Parent.Int64, "address_range": n.AddressRange,
			"description": n.Description.String, "subdivide": n.Subdivide, "valid_masks": n.ValidMasks,
			"owner": n.Owner.String, "account": n.Account.String, "service": n.Service.Int64,
		}})
	})

	r.Patch("/networks/{id}", m.updateNetwork)

	r.Delete("/networks/{id}", m.deleteNetwork)

	r.Get("/networks/{id}/hosts", func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			respondError(w, err)
			return
		}
		rows, err := db.QueryContext(r.Context(), `SELECT host(address), network, description FROM hosts WHERE network=$1 ORDER BY address`, id)
		if err != nil {
			respondError(w, err)
			return
		}
		defer rows.Close()

		out := []map[string]any{}
		for rows.Next() {
			var a string
			var nid int64
			var d string
			if err := rows.Scan(&a, &nid, &d); err != nil {
				respondError(w, err)
				return
			}
			out = append(out, map[string]any{"address": a, "network": nid, "description": d})
		}
		if err := rows.Err(); err != nil {
			respondError(w, err)
			return
		}
		writeJSON(w, out)
	})

	// Get all possible hosts in a network (for edit mode)
	r.Get("/networks/{id}/hosts/all", func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			respondError(w, err)
			return
		}
		var cidr string
		if err := db.QueryRowContext(r.Context(), `SELECT address_range::text FROM networks WHERE id=$1`, id).Scan(&cidr); err != nil {
			respondError(w, err)
			return
		}
		// Get existing hosts
		rows, err := db.QueryContext(r.Context(), `SELECT host(address), description FROM hosts WHERE network=$1`, id)
		if err != nil {
			respondError(w, err)
			return
		}
		defer rows.Close()
		existing := map[string]string{}
		for rows.Next() {
			var a, d string
			if err := rows.Scan(&a, &d); err != nil {
				respondError(w, err)
				return
			}
			existing[a] = d
		}
		rows.Close()

		// Generate all hosts
		allHosts := ipam.AllHostsStr(cidr)
		out := []map[string]any{}
		for _, addr := range allHosts {
			desc, used := existing[addr]
			out = append(out, map[string]any{"address": addr, "description": desc, "used": used})
		}
		if err := rows.Err(); err != nil {
			respondError(w, err)
			return
		}
		writeJSON(w, out)
	})

	r.Post("/networks/{id}/hosts", m.host)

	r.Delete("/hosts/{ip}", m.deleteHost)

	r.Post("/networks/{id}/allocate-host", m.allocateHost)

	r.Post("/networks/{id}/allocate-subnet", m.allocateSubnet)

	// Get available subnets for a network (for edit mode)
	r.Get("/networks/{id}/available-subnets", m.availableSubnets)

	r.Get("/logs", func(w http.ResponseWriter, r *http.Request) {
		limit := 50
		if s := r.URL.Query().Get("limit"); s != "" {
			v, err := strconv.Atoi(s)
			if err != nil || v < 1 || v > 1000 {
				respondError(w, problem(400, "limit must be 1-1000"))
				return
			}
			limit = v
		}
		rows, err := db.QueryContext(r.Context(), `
			SELECT c.change_time::text, c.prefix::text, c.change, COALESCE(u.username,'deleted user')
			FROM changelog c
			LEFT JOIN users u ON c."user" = u.id
			ORDER BY c.id DESC LIMIT $1`, limit)
		if err != nil {
			respondError(w, err)
			return
		}
		defer rows.Close()

		out := []map[string]any{}
		for rows.Next() {
			var ctime, prefix, change, changedBy string
			if err := rows.Scan(&ctime, &prefix, &change, &changedBy); err != nil {
				respondError(w, err)
				return
			}
			var event struct {
				Actor string `json:"actor"`
			}
			if json.Unmarshal([]byte(change), &event) == nil && event.Actor != "" {
				changedBy = event.Actor
			}
			action := formatChangeLog(change, changedBy)
			out = append(out, map[string]any{"created_at": ctime, "prefix": prefix, "action": action, "user": changedBy})
		}
		if err := rows.Err(); err != nil {
			respondError(w, err)
			return
		}
		writeJSON(w, out)
	})

	// User management endpoints (admin only)
	r.Get("/users", func(w http.ResponseWriter, r *http.Request) {
		if !isAdmin(r) {
			http.Error(w, "admin required", 403)
			return
		}
		rows, err := db.QueryContext(r.Context(), `SELECT u.id, u.username, u.status, COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') as roles FROM users u LEFT JOIN user_roles ur ON ur."user"=u.id LEFT JOIN roles r ON r.id=ur.role GROUP BY u.id ORDER BY u.username`)
		if err != nil {
			respondError(w, err)
			return
		}
		defer rows.Close()

		out := []map[string]any{}
		for rows.Next() {
			var id int64
			var username string
			var status int
			var roles string
			if err := rows.Scan(&id, &username, &status, &roles); err != nil {
				respondError(w, err)
				return
			}
			roleList := []string{}
			if roles != "{}" && roles != "" {
				roles = strings.Trim(roles, "{}")
				if roles != "" {
					roleList = strings.Split(roles, ",")
				}
			}
			out = append(out, map[string]any{"id": id, "username": username, "status": status, "roles": roleList})
		}
		if err := rows.Err(); err != nil {
			respondError(w, err)
			return
		}
		writeJSON(w, out)
	})

	r.Post("/users", m.createUser)

	r.Patch("/users/{id}", m.updateUser)

	r.Delete("/users/{id}", m.deleteUser)

	r.Get("/roles", func(w http.ResponseWriter, r *http.Request) {
		rows, err := db.QueryContext(r.Context(), `SELECT id, name FROM roles ORDER BY name`)
		if err != nil {
			respondError(w, err)
			return
		}
		defer rows.Close()

		out := []map[string]any{}
		for rows.Next() {
			var id int64
			var name string
			if err := rows.Scan(&id, &name); err != nil {
				respondError(w, err)
				return
			}
			out = append(out, map[string]any{"id": id, "name": name})
		}
		if err := rows.Err(); err != nil {
			respondError(w, err)
			return
		}
		writeJSON(w, out)
	})

	return r
}
