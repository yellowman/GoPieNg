package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/lib/pq"
	"github.com/yellowman/GoPieNg/internal/auth"
	"github.com/yellowman/GoPieNg/internal/ipam"
	"github.com/yellowman/GoPieNg/internal/middleware"
)

// All API mutations take this transaction-scoped lock before reading state.
// IPAM writes are infrequent; serializing them avoids cross-operation races
// (host vs. subdivision, policy changes vs. allocation, and user demotion).
// This also coordinates multiple GoPieNg processes using the same database.
// Direct SQL writers must participate in the same locking protocol.
const mutationLockKey int64 = 0x475049454e47

type mutations struct {
	db  *sql.DB
	jwt *auth.Manager
}

type lockedNetwork struct {
	prefix    netip.Prefix
	subdivide bool
	masks     pq.Int64Array
}

func lockNetwork(ctx context.Context, tx *sql.Tx, id int64) (lockedNetwork, error) {
	var n lockedNetwork
	var cidr string
	if err := tx.QueryRowContext(ctx, `SELECT address_range::text, subdivide, valid_masks FROM networks WHERE id=$1 FOR UPDATE`, id).Scan(&cidr, &n.subdivide, &n.masks); err != nil {
		return n, err
	}
	var err error
	n.prefix, err = netip.ParsePrefix(cidr)
	if err != nil {
		return n, fmt.Errorf("stored network: %w", err)
	}
	n.prefix = n.prefix.Masked()
	return n, nil
}

func (m mutations) write(w http.ResponseWriter, r *http.Request, role string, fn func(*sql.Tx, *auth.Claims) (any, error)) {
	ctx := r.Context()
	tx, err := m.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		respondError(w, err)
		return
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock($1)`, mutationLockKey); err != nil {
		respondError(w, err)
		return
	}
	// Recheck after waiting for the lock: a request queued before a demotion
	// or password reset must not retain the old authorization.
	actor, err := auth.RefreshClaims(ctx, tx, m.jwt, middleware.GetClaims(r))
	if err != nil {
		respondError(w, err)
		return
	}
	if !hasRole(actor, role) {
		respondError(w, problem(403, "forbidden"))
		return
	}
	out, err := fn(tx, actor)
	if err != nil {
		respondError(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		respondError(w, err)
		return
	}
	writeJSON(w, out)
}

func hasRole(c *auth.Claims, required string) bool {
	if c == nil {
		return false
	}
	if required == "reader" {
		return true
	}
	for _, role := range c.Roles {
		if role == "administrator" || role == required || (required == "editor" && role == "creator") {
			return true
		}
	}
	return false
}

// Capture the actor in the event itself, preserving attribution after account
// deletion without changing the legacy PieNg schema. Non-IP user events use
// 0.0.0.0/0 because the existing changelog requires a non-null inet prefix.
func audit(ctx context.Context, tx *sql.Tx, actor *auth.Claims, prefix, action string, details any) error {
	event, err := json.Marshal(map[string]any{"actor": actor.Username, "action": action, "details": details})
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO changelog(prefix, change, "user") VALUES($1::inet,$2,$3)`, prefix, string(event), actor.UserID)
	return err
}

func (m mutations) host(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		respondError(w, err)
		return
	}
	var req struct {
		Address     string `json:"address"`
		Description string `json:"description"`
		Update      bool   `json:"update"`
	}
	if !decodeRequest(w, r, &req) {
		return
	}
	addr, err := parseHost(req.Address)
	if err != nil {
		respondError(w, err)
		return
	}
	m.write(w, r, "editor", func(tx *sql.Tx, actor *auth.Claims) (any, error) {
		n, err := lockNetwork(r.Context(), tx, id)
		if err != nil {
			return nil, err
		}
		if err = hostAllowed(n, addr); err != nil {
			return nil, err
		}
		action := "host added"
		if req.Update {
			result, err := tx.ExecContext(r.Context(), `UPDATE hosts SET description=$1 WHERE address=$2::inet AND network=$3`, req.Description, addr.String(), id)
			if err != nil {
				return nil, err
			}
			if err = affected(result); err != nil {
				return nil, err
			}
			action = "host updated"
		} else {
			if _, err := tx.ExecContext(r.Context(), `INSERT INTO hosts(address,network,description) VALUES($1::inet,$2,$3)`, addr.String(), id, req.Description); err != nil {
				return nil, err
			}
		}
		if err := audit(r.Context(), tx, actor, addr.String(), action, req.Description); err != nil {
			return nil, err
		}
		return map[string]any{"status": "ok"}, nil
	})
}

func hostAllowed(n lockedNetwork, addr netip.Addr) error {
	if n.subdivide {
		return problem(409, "allocate hosts only in a leaf network")
	}
	if n.prefix.Addr().BitLen() != addr.BitLen() || !n.prefix.Contains(addr) {
		return problem(400, "host is outside the network")
	}
	if addr.Is4() && n.prefix.Bits() < 31 {
		b := n.prefix.Addr().As4()
		base := uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
		last := base | (uint32(0xffffffff) >> n.prefix.Bits())
		a := addr.As4()
		v := uint32(a[0])<<24 | uint32(a[1])<<16 | uint32(a[2])<<8 | uint32(a[3])
		if v == base || v == last {
			return problem(400, "network and broadcast addresses cannot be allocated as hosts")
		}
	}
	return nil
}

func (m mutations) allocateHost(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		respondError(w, err)
		return
	}
	var req struct {
		Description string `json:"description"`
	}
	if !decodeRequest(w, r, &req) {
		return
	}
	if req.Description == "" {
		req.Description = "auto"
	}
	m.write(w, r, "editor", func(tx *sql.Tx, actor *auth.Claims) (any, error) {
		ctx := r.Context()
		n, err := lockNetwork(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		if n.subdivide {
			return nil, problem(409, "allocate hosts only in a leaf network")
		}
		// Include all addresses within the range, even misplaced legacy rows.
		rows, err := tx.QueryContext(ctx, `SELECT host(address) FROM hosts WHERE address <<= $1::cidr`, n.prefix.String())
		if err != nil {
			return nil, err
		}
		used := map[string]bool{}
		for rows.Next() {
			var a string
			if err := rows.Scan(&a); err != nil {
				rows.Close()
				return nil, err
			}
			used[a] = true
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		a := ipam.NextFreeHostStr(n.prefix.String(), used)
		if a == "" {
			return nil, problem(409, "no free host")
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO hosts(address,network,description) VALUES($1::inet,$2,$3)`, a, id, req.Description); err != nil {
			return nil, err
		}
		if err := audit(ctx, tx, actor, a, "host allocated", req.Description); err != nil {
			return nil, err
		}
		return map[string]any{"address": a}, nil
	})
}

func (m mutations) deleteHost(w http.ResponseWriter, r *http.Request) {
	addr, err := parseHost(chi.URLParam(r, "ip"))
	if err != nil {
		respondError(w, err)
		return
	}
	m.write(w, r, "editor", func(tx *sql.Tx, actor *auth.Claims) (any, error) {
		var desc string
		if err := tx.QueryRowContext(r.Context(), `DELETE FROM hosts WHERE address=$1::inet RETURNING description`, addr.String()).Scan(&desc); err != nil {
			return nil, err
		}
		if err := audit(r.Context(), tx, actor, addr.String(), "host deleted", desc); err != nil {
			return nil, err
		}
		return map[string]any{"status": "ok"}, nil
	})
}

func maskAllowed(n lockedNetwork, mask int) error {
	if !n.subdivide {
		return problem(409, "network is not enabled for subdivision")
	}
	if mask <= n.prefix.Bits() || mask > n.prefix.Addr().BitLen() {
		return problem(400, "mask must be more specific than the parent and valid for its address family")
	}
	// NULL and the legacy empty array both mean no explicit mask policy.
	if len(n.masks) > 0 {
		for _, allowed := range n.masks {
			if int64(mask) == allowed {
				return nil
			}
		}
		return problem(400, "mask is not allowed by the parent network")
	}
	return nil
}

func childPrefixes(ctx context.Context, tx *sql.Tx, id int64) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT address_range::text FROM networks WHERE parent=$1 ORDER BY address_range`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	children := []string{}
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		children = append(children, s)
	}
	return children, rows.Err()
}

func (m mutations) allocateSubnet(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		respondError(w, err)
		return
	}
	var req struct {
		Mask        int    `json:"mask"`
		CIDR        string `json:"cidr"`
		Description string `json:"description"`
		Subdivide   bool   `json:"subdivide"`
	}
	if !decodeRequest(w, r, &req) {
		return
	}
	var requested netip.Prefix
	if req.CIDR != "" {
		requested, err = netip.ParsePrefix(req.CIDR)
		if err != nil || requested.Addr().Is4In6() || requested != requested.Masked() {
			respondError(w, problem(400, "invalid or non-canonical CIDR"))
			return
		}
		if req.Mask != 0 && req.Mask != requested.Bits() {
			respondError(w, problem(400, "mask and CIDR disagree"))
			return
		}
		req.Mask = requested.Bits()
	}
	if req.Description == "" {
		req.Description = "auto"
	}
	m.write(w, r, "creator", func(tx *sql.Tx, actor *auth.Claims) (any, error) {
		ctx := r.Context()
		parent, err := lockNetwork(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		if err = maskAllowed(parent, req.Mask); err != nil {
			return nil, err
		}
		children, err := childPrefixes(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		cand := requested.String()
		if !requested.IsValid() {
			cand, err = ipam.NextFreeSubnetStr(parent.prefix.String(), children, req.Mask)
			if err != nil {
				return nil, problem(409, err.Error())
			}
		}
		if !ipam.ContainsStr(parent.prefix.String(), cand) {
			return nil, problem(400, "subnet not within parent network")
		}
		for _, child := range children {
			if ipam.OverlapStr(cand, child) {
				return nil, problem(409, "subnet overlaps with existing allocation")
			}
		}
		// Do not hide existing addresses beneath a newly-created child.
		var occupied bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM hosts WHERE address <<= $1::cidr)`, cand).Scan(&occupied); err != nil {
			return nil, err
		}
		if occupied {
			return nil, problem(409, "subnet contains existing host allocations")
		}
		var nid int64
		if err := tx.QueryRowContext(ctx, `INSERT INTO networks(parent,address_range,description,subdivide) VALUES($1,$2::cidr,$3,$4) RETURNING id`, id, cand, req.Description, req.Subdivide).Scan(&nid); err != nil {
			return nil, err
		}
		action := "subnet assigned"
		if req.Subdivide {
			action = "subnet allocated for subdivision"
		}
		if err := audit(ctx, tx, actor, cand, action, req.Description); err != nil {
			return nil, err
		}
		return map[string]any{"id": nid, "address_range": cand, "subdivide": req.Subdivide}, nil
	})
}

func (m mutations) updateNetwork(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		respondError(w, err)
		return
	}
	var req struct {
		Description *string  `json:"description"`
		Owner       *string  `json:"owner"`
		Account     *string  `json:"account"`
		Service     *int64   `json:"service"`
		Subdivide   *bool    `json:"subdivide"`
		ValidMasks  *[]int16 `json:"valid_masks"`
	}
	if !decodeRequest(w, r, &req) {
		return
	}
	m.write(w, r, "editor", func(tx *sql.Tx, actor *auth.Claims) (any, error) {
		ctx := r.Context()
		n, err := lockNetwork(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		if (req.Subdivide != nil || req.ValidMasks != nil) && !hasRole(actor, "administrator") {
			return nil, problem(403, "network settings require administrator")
		}
		fields := []string{}
		values := []any{}
		changes := map[string]any{}
		add := func(name string, value any) {
			values = append(values, value)
			fields = append(fields, fmt.Sprintf("%s=$%d", name, len(values)))
			changes[name] = value
		}
		if req.Description != nil {
			add("description", *req.Description)
		}
		if req.Owner != nil {
			add("owner", *req.Owner)
		}
		if req.Account != nil {
			add("account", *req.Account)
		}
		if req.Service != nil {
			add("service", *req.Service)
		}
		if req.Subdivide != nil {
			var conflict bool
			query := `SELECT EXISTS(SELECT 1 FROM hosts WHERE network=$1)`
			if !*req.Subdivide {
				query = `SELECT EXISTS(SELECT 1 FROM networks WHERE parent=$1)`
			}
			if err := tx.QueryRowContext(ctx, query, id).Scan(&conflict); err != nil {
				return nil, err
			}
			if conflict {
				return nil, problem(409, "cannot change network type while hosts or children exist")
			}
			add("subdivide", *req.Subdivide)
		}
		if req.ValidMasks != nil {
			seen := map[int16]bool{}
			for _, mask := range *req.ValidMasks {
				if int(mask) <= n.prefix.Bits() || int(mask) > n.prefix.Addr().BitLen() || seen[mask] {
					return nil, problem(400, "invalid or duplicate allocation mask")
				}
				seen[mask] = true
			}
			add("valid_masks", ipam.FormatSmallIntArray(*req.ValidMasks))
			fields[len(fields)-1] += "::smallint[]"
			changes["valid_masks"] = *req.ValidMasks
		}
		if len(fields) == 0 {
			return map[string]any{"status": "no change"}, nil
		}
		values = append(values, id)
		if _, err := tx.ExecContext(ctx, fmt.Sprintf("UPDATE networks SET %s WHERE id=$%d", strings.Join(fields, ","), len(values)), values...); err != nil {
			return nil, err
		}
		if err := audit(ctx, tx, actor, n.prefix.String(), "network updated", changes); err != nil {
			return nil, err
		}
		return map[string]any{"status": "ok"}, nil
	})
}

func (m mutations) deleteNetwork(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		respondError(w, err)
		return
	}
	m.write(w, r, "creator", func(tx *sql.Tx, actor *auth.Claims) (any, error) {
		n, err := lockNetwork(r.Context(), tx, id)
		if err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(r.Context(), `DELETE FROM networks WHERE id=$1`, id); err != nil {
			return nil, err
		}
		if err = audit(r.Context(), tx, actor, n.prefix.String(), "network deleted", nil); err != nil {
			return nil, err
		}
		return map[string]any{"status": "ok"}, nil
	})
}

func replaceRoles(ctx context.Context, tx *sql.Tx, id int64, roles []string) error {
	seen := map[string]bool{}
	ids := []int64{}
	for _, role := range roles {
		if seen[role] {
			continue
		}
		seen[role] = true
		var rid int64
		err := tx.QueryRowContext(ctx, `SELECT id FROM roles WHERE name=$1`, role).Scan(&rid)
		if errors.Is(err, sql.ErrNoRows) {
			return problem(400, "unknown role")
		}
		if err != nil {
			return err
		}
		ids = append(ids, rid)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM user_roles WHERE "user"=$1`, id); err != nil {
		return err
	}
	for _, rid := range ids {
		if _, err := tx.ExecContext(ctx, `INSERT INTO user_roles("user",role) VALUES($1,$2)`, id, rid); err != nil {
			return err
		}
	}
	return nil
}

func keepAdministrator(ctx context.Context, tx *sql.Tx) error {
	var exists bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users u JOIN user_roles ur ON ur."user"=u.id JOIN roles r ON r.id=ur.role WHERE u.status=1 AND r.name='administrator')`).Scan(&exists)
	if err != nil {
		return err
	}
	if !exists {
		return problem(409, "cannot remove the last active administrator")
	}
	return nil
}

func (m mutations) createUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string   `json:"username"`
		Password string   `json:"password"`
		Roles    []string `json:"roles"`
	}
	if !decodeRequest(w, r, &req) {
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" || len(req.Username) > 32 || len(req.Password) < 8 || len(req.Password) > 1024 {
		respondError(w, problem(400, "username must be 1-32 bytes and password 8-1024 bytes"))
		return
	}
	m.write(w, r, "administrator", func(tx *sql.Tx, actor *auth.Claims) (any, error) {
		hash, err := auth.HashPassword(req.Password)
		if err != nil {
			return nil, err
		}
		var id int64
		if err := tx.QueryRowContext(r.Context(), `INSERT INTO users(username,password,status) VALUES($1,$2,1) RETURNING id`, req.Username, hash).Scan(&id); err != nil {
			return nil, err
		}
		if err := replaceRoles(r.Context(), tx, id, req.Roles); err != nil {
			return nil, err
		}
		if err := audit(r.Context(), tx, actor, "0.0.0.0/0", "user created", map[string]any{"id": id, "username": req.Username, "roles": req.Roles}); err != nil {
			return nil, err
		}
		return map[string]any{"id": id, "username": req.Username}, nil
	})
}

func (m mutations) updateUser(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		respondError(w, err)
		return
	}
	var req struct {
		Password        *string   `json:"password"`
		CurrentPassword string    `json:"current_password"`
		Status          *int      `json:"status"`
		Roles           *[]string `json:"roles"`
	}
	if !decodeRequest(w, r, &req) {
		return
	}
	if req.Password != nil && (len(*req.Password) < 8 || len(*req.Password) > 1024) {
		respondError(w, problem(400, "password must be 8-1024 bytes"))
		return
	}
	if req.Status != nil && *req.Status != 0 && *req.Status != 1 {
		respondError(w, problem(400, "status must be 0 or 1"))
		return
	}
	m.write(w, r, "reader", func(tx *sql.Tx, actor *auth.Claims) (any, error) {
		isAdmin := hasRole(actor, "administrator")
		isSelf := actor.UserID == id
		if !isAdmin && (!isSelf || req.Status != nil || req.Roles != nil) {
			return nil, problem(403, "forbidden")
		}
		var username, oldHash string
		if err := tx.QueryRowContext(r.Context(), `SELECT username,password FROM users WHERE id=$1 FOR UPDATE`, id).Scan(&username, &oldHash); err != nil {
			return nil, err
		}
		details := map[string]any{"id": id, "username": username}
		if req.Password != nil {
			// Self-service always requires the existing password, including
			// administrators. Admin resets of another account do not.
			if isSelf {
				valid, err := auth.CheckPassword(oldHash, req.CurrentPassword)
				if err != nil {
					return nil, err
				}
				if !valid {
					return nil, problem(403, "current password is incorrect")
				}
			}
			hash, err := auth.HashPassword(*req.Password)
			if err != nil {
				return nil, err
			}
			if _, err := tx.ExecContext(r.Context(), `UPDATE users SET password=$1 WHERE id=$2`, hash, id); err != nil {
				return nil, err
			}
			details["password_changed"] = true
		}
		if req.Status != nil {
			if _, err := tx.ExecContext(r.Context(), `UPDATE users SET status=$1 WHERE id=$2`, *req.Status, id); err != nil {
				return nil, err
			}
			details["status"] = *req.Status
		}
		if req.Roles != nil {
			if err := replaceRoles(r.Context(), tx, id, *req.Roles); err != nil {
				return nil, err
			}
			details["roles"] = *req.Roles
		}
		if req.Status != nil || req.Roles != nil {
			if err := keepAdministrator(r.Context(), tx); err != nil {
				return nil, err
			}
		}
		if err := audit(r.Context(), tx, actor, "0.0.0.0/0", "user updated", details); err != nil {
			return nil, err
		}
		return map[string]any{"status": "ok", "reauthenticate": isSelf && req.Password != nil}, nil
	})
}

func (m mutations) deleteUser(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		respondError(w, err)
		return
	}
	m.write(w, r, "administrator", func(tx *sql.Tx, actor *auth.Claims) (any, error) {
		if actor.UserID == id {
			return nil, problem(409, "cannot delete the currently signed-in account")
		}
		var username string
		if err := tx.QueryRowContext(r.Context(), `SELECT username FROM users WHERE id=$1 FOR UPDATE`, id).Scan(&username); err != nil {
			return nil, err
		}
		// Snapshot legacy event attribution before clearing the user FK.
		if _, err := tx.ExecContext(r.Context(), `UPDATE changelog SET change=json_build_object('actor',$1::text,'action','historical event','details',change)::text,"user"=NULL WHERE "user"=$2`, username, id); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(r.Context(), `DELETE FROM user_roles WHERE "user"=$1`, id); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(r.Context(), `DELETE FROM users WHERE id=$1`, id); err != nil {
			return nil, err
		}
		if err := keepAdministrator(r.Context(), tx); err != nil {
			return nil, err
		}
		if err := audit(r.Context(), tx, actor, "0.0.0.0/0", "user deleted", map[string]any{"id": id, "username": username}); err != nil {
			return nil, err
		}
		return map[string]any{"status": "ok"}, nil
	})
}

func pathID(r *http.Request) (int64, error) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		return 0, problem(400, "invalid id")
	}
	return id, nil
}

func affected(result sql.Result) error {
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// availableSubnets validates policy before invoking bounded enumeration. A
// refused oversized listing is an error, never a misleading empty pool.
func (m mutations) availableSubnets(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		respondError(w, err)
		return
	}
	var cidr string
	var n lockedNetwork
	err = m.db.QueryRowContext(r.Context(), `SELECT address_range::text,subdivide,valid_masks FROM networks WHERE id=$1`, id).Scan(&cidr, &n.subdivide, &n.masks)
	if err != nil {
		respondError(w, err)
		return
	}
	n.prefix, err = netip.ParsePrefix(cidr)
	if err != nil {
		respondError(w, err)
		return
	}
	mask := n.prefix.Bits() + 1
	if len(n.masks) > 0 {
		mask = int(n.masks[0])
	}
	if text := r.URL.Query().Get("mask"); text != "" {
		mask, err = strconv.Atoi(text)
		if err != nil {
			respondError(w, problem(400, "invalid mask"))
			return
		}
	}
	if err = maskAllowed(n, mask); err != nil {
		respondError(w, err)
		return
	}
	if mask-n.prefix.Bits() > 16 {
		respondError(w, problem(422, "too many subnets to display; use a narrower parent or automatic allocation"))
		return
	}
	rows, err := m.db.QueryContext(r.Context(), `SELECT address_range::text FROM networks WHERE parent=$1`, id)
	if err != nil {
		respondError(w, err)
		return
	}
	defer rows.Close()
	children := []string{}
	for rows.Next() {
		var child string
		if err := rows.Scan(&child); err != nil {
			respondError(w, err)
			return
		}
		children = append(children, child)
	}
	if err := rows.Err(); err != nil {
		respondError(w, err)
		return
	}
	out := []map[string]any{}
	for _, cidr := range ipam.AvailableSubnetsStr(cidr, children, mask) {
		out = append(out, map[string]any{"address_range": cidr, "mask": mask})
	}
	writeJSON(w, out)
}
