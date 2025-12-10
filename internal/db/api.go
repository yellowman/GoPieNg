package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/example/pieng-go-spa/internal/auth"
	"github.com/example/pieng-go-spa/internal/ipam"
	"github.com/example/pieng-go-spa/internal/middleware"
)

type Network struct{ ID int64; Parent sql.NullInt64; AddressRange string; Description sql.NullString; Subdivide bool; ValidMasks []int16; Owner, Account sql.NullString; Service sql.NullInt64 }

type Host struct{ Address string; NetworkID int64; Description string }

type Change struct{ Time string; Prefix string; Change string }

// Helper to write JSON response with proper Content-Type
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

// Get username from request context
func getUsername(r *http.Request, db *sql.DB) string {
	claims := middleware.GetClaims(r)
	if claims == nil { return "unknown" }
	var username string
	db.QueryRow(`SELECT username FROM users WHERE id=$1`, claims.UserID).Scan(&username)
	if username == "" { return "unknown" }
	return username
}

// Check if user has admin role
func isAdmin(r *http.Request) bool {
	claims := middleware.GetClaims(r)
	if claims == nil { return false }
	for _, role := range claims.Roles {
		if role == "administrator" { return true }
	}
	return false
}

// Check if user can create/delete networks (administrator or creator)
func isCreator(r *http.Request) bool {
	claims := middleware.GetClaims(r)
	if claims == nil { return false }
	for _, role := range claims.Roles {
		if role == "administrator" || role == "creator" { return true }
	}
	return false
}

// Check if user can edit (administrator, creator, or editor)
func isEditor(r *http.Request) bool {
	claims := middleware.GetClaims(r)
	if claims == nil { return false }
	for _, role := range claims.Roles {
		if role == "administrator" || role == "creator" || role == "editor" { return true }
	}
	return false
}

// Log a change - requires user FK (matches original PieNg schema)
func logChange(db *sql.DB, prefix, action, username string) {
	var userID int64
	err := db.QueryRow(`SELECT id FROM users WHERE username=$1`, username).Scan(&userID)
	if err != nil {
		// Can't log without valid user - this shouldn't happen in normal operation
		return
	}
	db.Exec(`INSERT INTO changelog(prefix, change, "user") VALUES($1::inet, $2, $3)`, prefix, action, userID)
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

func API(db *sql.DB, jwt any) http.Handler {
	r := chi.NewRouter()

	// Ping check endpoint - checks if IP responds
	// Uses TCP connect since ICMP requires setuid which pledge disables
	r.Get("/check-ip/{ip}", func(w http.ResponseWriter, rq *http.Request) {
		ip := chi.URLParam(rq, "ip")
		// Validate IP format to prevent abuse
		if strings.ContainsAny(ip, ";|&$`\\\"' \t\n") {
			http.Error(w, "invalid IP", 400)
			return
		}
		// Try common ports to see if host is up
		// Both SYN-ACK (open) and RST (closed) mean host is alive
		responds := false
		for _, port := range []string{"22", "80", "443", "23"} {
			conn, err := net.DialTimeout("tcp", ip+":"+port, 1*time.Second)
			if err == nil {
				conn.Close()
				responds = true
				break
			}
			// "connection refused" = RST received = host is up
			if strings.Contains(err.Error(), "refused") {
				responds = true
				break
			}
		}
		writeJSON(w, map[string]any{"ip": ip, "responds": responds})
	})

	// Search endpoint - searches networks or hosts based on mode
	r.Get("/search", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("q")
		mode := r.URL.Query().Get("mode") // "hosts" (default) or "networks"
		if mode == "" {
			mode = "hosts"
		}
		
		if q == "" {
			writeJSON(w, map[string]any{"results": []any{}})
			return
		}
		
		// Helper to get ancestry path (from root to parent)
		getAncestry := func(netId int64) []int64 {
			path := []int64{}
			currentId := netId
			for i := 0; i < 20; i++ { // safety limit
				var parentId sql.NullInt64
				err := db.QueryRow(`SELECT parent FROM networks WHERE id = $1`, currentId).Scan(&parentId)
				if err != nil || !parentId.Valid {
					break
				}
				path = append([]int64{parentId.Int64}, path...) // prepend
				currentId = parentId.Int64
			}
			return path
		}
		
		results := []map[string]any{}
		
		if mode == "networks" {
			// Search networks - account is EXACT match, others are fuzzy
			pattern := "%" + q + "%"
			rows, err := db.Query(`
				SELECT id, address_range::text, description, owner, account 
				FROM networks 
				WHERE address_range::text ILIKE $1 
				   OR description ILIKE $1 
				   OR owner ILIKE $1 
				   OR account = $2
				ORDER BY address_range
				LIMIT 100`, pattern, q)
			if err == nil {
				defer rows.Close()
				for rows.Next() {
					var id int64
					var addr string
					var desc, owner, account sql.NullString
					rows.Scan(&id, &addr, &desc, &owner, &account)
					results = append(results, map[string]any{
						"type":          "network",
						"id":            id,
						"address_range": addr,
						"description":   desc.String,
						"owner":         owner.String,
						"account":       account.String,
						"ancestry":      getAncestry(id),
					})
				}
			}
		} else {
			// Search hosts (default)
			pattern := "%" + q + "%"
			rows, err := db.Query(`
				SELECT host(h.address), h.network, h.description, n.address_range::text
				FROM hosts h
				JOIN networks n ON h.network = n.id
				WHERE host(h.address) ILIKE $1 
				   OR h.description ILIKE $1
				ORDER BY h.address
				LIMIT 100`, pattern)
			if err == nil {
				defer rows.Close()
				for rows.Next() {
					var addr string
					var netId int64
					var desc, netRange string
					rows.Scan(&addr, &netId, &desc, &netRange)
					ancestry := getAncestry(netId)
					ancestry = append(ancestry, netId) // include the network itself
					results = append(results, map[string]any{
						"type":          "host",
						"address":       addr,
						"network_id":    netId,
						"description":   desc,
						"network_range": netRange,
						"ancestry":      ancestry,
					})
				}
			}
		}
		
		writeJSON(w, map[string]any{"results": results})
	})

	r.Get("/networks", func(w http.ResponseWriter, r *http.Request){
		q := r.URL.Query().Get("q")
		parent := r.URL.Query().Get("parent_id")
		where := ""
		args := []any{}
		if parent != "" { 
			where = "WHERE parent=$1"
			pid, _ := strconv.ParseInt(parent,10,64)
			args = append(args, pid) 
		} else { 
			where = "WHERE parent IS NULL" 
		}
		if q != "" { 
			if len(args)>0 { 
				where += " AND " 
			} else { 
				where = "WHERE " 
			}
			where += "(address_range::text ILIKE '%'||$"+fmt.Sprint(len(args)+1)+"||'%' OR coalesce(description,'') ILIKE '%'||$"+fmt.Sprint(len(args)+1)+"||'%' OR coalesce(owner,'') ILIKE '%'||$"+fmt.Sprint(len(args)+1)+"||'%')"
			args = append(args, q) 
		}
		rows, err := db.Query("SELECT id, parent, address_range::text, description, subdivide, valid_masks, owner, account, service FROM networks "+where+" ORDER BY address_range", args...)
		if err != nil { 
			http.Error(w, err.Error(), 500)
			return 
		}
		defer rows.Close()
		
		out := []map[string]any{}
		for rows.Next() { 
			var n Network
			var vm sql.NullString
			if err := rows.Scan(&n.ID,&n.Parent,&n.AddressRange,&n.Description,&n.Subdivide,&vm,&n.Owner,&n.Account,&n.Service); err != nil {
				continue
			}
			if vm.Valid { 
				n.ValidMasks = ipam.ParseSmallIntArray(vm.String) 
			}
			out = append(out, map[string]any{
				"id":n.ID, "parent":n.Parent.Int64, "address_range":n.AddressRange,
				"description":n.Description.String, "subdivide":n.Subdivide, "valid_masks":n.ValidMasks,
				"owner":n.Owner.String, "account":n.Account.String, "service":n.Service.Int64,
			})
		}
		writeJSON(w, out)
	})

	r.Get("/networks/{id}", func(w http.ResponseWriter, r *http.Request){ 
		id, _ := strconv.ParseInt(chi.URLParam(r,"id"),10,64)
		var n Network
		var vm sql.NullString
		err := db.QueryRow(`SELECT id,parent,address_range::text,description,subdivide,valid_masks,owner,account,service FROM networks WHERE id=$1`, id).Scan(&n.ID,&n.Parent,&n.AddressRange,&n.Description,&n.Subdivide,&vm,&n.Owner,&n.Account,&n.Service)
		if err != nil { 
			http.Error(w, "not found", 404)
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

	r.Patch("/networks/{id}", func(w http.ResponseWriter, r *http.Request){ 
		if !isEditor(r) { http.Error(w, "forbidden", 403); return }
		id, _ := strconv.ParseInt(chi.URLParam(r,"id"),10,64)
		username := getUsername(r, db)
		var req map[string]any
		json.NewDecoder(r.Body).Decode(&req)
		fields := []string{}
		vals := []any{}
		i := 1
		if v, ok := req["description"].(string); ok { 
			fields = append(fields, fmt.Sprintf("description=$%d", i))
			vals = append(vals, v)
			i++ 
		}
		if v, ok := req["owner"].(string); ok { 
			fields = append(fields, fmt.Sprintf("owner=$%d", i))
			vals = append(vals, v)
			i++ 
		}
		if v, ok := req["account"].(string); ok { 
			fields = append(fields, fmt.Sprintf("account=$%d", i))
			vals = append(vals, v)
			i++ 
		}
		if v, ok := req["subdivide"].(bool); ok { 
			// subdivide is admin-only (structural change)
			if !isAdmin(r) { http.Error(w, "forbidden: admin only", 403); return }
			fields = append(fields, fmt.Sprintf("subdivide=$%d", i))
			vals = append(vals, v)
			i++ 
		}
		if v, ok := req["service"].(float64); ok { 
			fields = append(fields, fmt.Sprintf("service=$%d", i))
			vals = append(vals, int64(v))
			i++ 
		}
		if v, ok := req["valid_masks"]; ok { 
			// valid_masks is admin-only
			if !isAdmin(r) { http.Error(w, "forbidden: admin only", 403); return }
			arr := ipam.InterfaceToSmallIntSlice(v)
			fields = append(fields, fmt.Sprintf("valid_masks=$%d::smallint[]", i))
			vals = append(vals, ipam.FormatSmallIntArray(arr))
			i++ 
		}
		vals = append(vals, id)
		if len(fields) == 0 { 
			writeJSON(w, map[string]string{"status":"no change"})
			return 
		}
		q := fmt.Sprintf("UPDATE networks SET %s WHERE id=$%d", strings.Join(fields,","), i)
		_, err := db.Exec(q, vals...)
		if err != nil { 
			http.Error(w, err.Error(), 500)
			return 
		}
		var cidr string
		db.QueryRow(`SELECT address_range::text FROM networks WHERE id=$1`, id).Scan(&cidr)
		logChange(db, cidr, fmt.Sprintf("updated by %s", username), username)
		writeJSON(w, map[string]string{"status":"ok"}) 
	})

	r.Delete("/networks/{id}", func(w http.ResponseWriter, r *http.Request){ 
		if !isCreator(r) { http.Error(w, "forbidden", 403); return }
		id, _ := strconv.ParseInt(chi.URLParam(r,"id"),10,64)
		username := getUsername(r, db)
		var cidr string
		db.QueryRow(`SELECT address_range::text FROM networks WHERE id=$1`, id).Scan(&cidr)
		_, err := db.Exec(`DELETE FROM networks WHERE id=$1`, id)
		if err != nil { 
			http.Error(w, err.Error(), 500)
			return 
		}
		logChange(db, cidr, fmt.Sprintf("deleted by %s", username), username)
		writeJSON(w, map[string]string{"status":"ok"}) 
	})

	r.Get("/networks/{id}/hosts", func(w http.ResponseWriter, r *http.Request){ 
		id, _ := strconv.ParseInt(chi.URLParam(r,"id"),10,64)
		rows, err := db.Query(`SELECT host(address), network, description FROM hosts WHERE network=$1 ORDER BY address`, id)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer rows.Close()
		
		out := []map[string]any{}
		for rows.Next() { 
			var a string
			var nid int64
			var d string
			if err := rows.Scan(&a, &nid, &d); err != nil {
				continue
			}
			out = append(out, map[string]any{"address": a, "network": nid, "description": d}) 
		}
		writeJSON(w, out) 
	})
	
	// Get all possible hosts in a network (for edit mode)
	r.Get("/networks/{id}/hosts/all", func(w http.ResponseWriter, r *http.Request){ 
		id, _ := strconv.ParseInt(chi.URLParam(r,"id"),10,64)
		var cidr string
		if err := db.QueryRow(`SELECT address_range::text FROM networks WHERE id=$1`, id).Scan(&cidr); err != nil { 
			http.Error(w, "network not found", 404)
			return 
		}
		// Get existing hosts
		rows, err := db.Query(`SELECT host(address), description FROM hosts WHERE network=$1`, id)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		existing := map[string]string{}
		for rows.Next() { 
			var a, d string
			if err := rows.Scan(&a, &d); err != nil {
				continue
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
		writeJSON(w, out) 
	})
	
	r.Post("/networks/{id}/hosts", func(w http.ResponseWriter, r *http.Request){ 
		if !isEditor(r) { http.Error(w, "forbidden", 403); return }
		id, _ := strconv.ParseInt(chi.URLParam(r,"id"),10,64)
		username := getUsername(r, db)
		var req struct{ Address, Description string; Update bool }
		json.NewDecoder(r.Body).Decode(&req)
		
		if req.Update {
			// Update existing host description
			_, err := db.Exec(`UPDATE hosts SET description=$1 WHERE address=$2::inet`, req.Description, req.Address)
			if err != nil { 
				http.Error(w, err.Error(), 500)
				return 
			}
			logChange(db, req.Address+"/32", fmt.Sprintf("host updated: %s by %s", req.Description, username), username)
		} else {
			// Insert new host - fail if exists
			_, err := db.Exec(`INSERT INTO hosts(address,network,description) VALUES($1::inet,$2,$3)`, req.Address, id, req.Description)
			if err != nil { 
				if strings.Contains(err.Error(), "duplicate") || strings.Contains(err.Error(), "unique") {
					http.Error(w, "IP already exists", 409)
					return
				}
				http.Error(w, err.Error(), 500)
				return 
			}
			logChange(db, req.Address+"/32", fmt.Sprintf("host added: %s by %s", req.Description, username), username)
		}
		writeJSON(w, map[string]any{"status":"ok"}) 
	})
	
	r.Delete("/hosts/{ip}", func(w http.ResponseWriter, r *http.Request){ 
		if !isEditor(r) { http.Error(w, "forbidden", 403); return }
		ip := chi.URLParam(r, "ip")
		username := getUsername(r, db)
		_, err := db.Exec(`DELETE FROM hosts WHERE address=$1::inet`, ip)
		if err != nil { 
			http.Error(w, err.Error(), 500)
			return 
		}
		logChange(db, ip+"/32", fmt.Sprintf("host deleted by %s", username), username)
		writeJSON(w, map[string]any{"status":"ok"}) 
	})

	r.Post("/networks/{id}/allocate-host", func(w http.ResponseWriter, r *http.Request){ 
		if !isEditor(r) { http.Error(w, "forbidden", 403); return }
		id, _ := strconv.ParseInt(chi.URLParam(r,"id"),10,64)
		username := getUsername(r, db)
		var req struct{ Description string `json:"description"` }
		json.NewDecoder(r.Body).Decode(&req)
		desc := req.Description
		if desc == "" { 
			desc = "auto" 
		}
		
		var cidr string
		if err := db.QueryRow(`SELECT address_range::text FROM networks WHERE id=$1`, id).Scan(&cidr); err != nil { 
			http.Error(w, "network not found", 404)
			return 
		}
		rows, err := db.Query(`SELECT host(address) FROM hosts WHERE network=$1`, id)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		used := map[string]bool{}
		for rows.Next() { 
			var a string
			rows.Scan(&a)
			used[a] = true 
		}
		rows.Close()
		
		a := ipam.NextFreeHostStr(cidr, used)
		if a == "" { 
			http.Error(w, "no free host", 409)
			return 
		}
		if _, err := db.Exec(`INSERT INTO hosts(address,network,description) VALUES($1::inet,$2,$3)`, a, id, desc); err != nil { 
			// Check if it's a duplicate key error (race condition - another user allocated it first)
			if strings.Contains(err.Error(), "duplicate") || strings.Contains(err.Error(), "unique") {
				http.Error(w, "address already allocated, please retry", 409)
				return
			}
			http.Error(w, err.Error(), 500)
			return 
		}
		logChange(db, a+"/32", fmt.Sprintf("host allocated: %s by %s", desc, username), username)
		writeJSON(w, map[string]any{"address": a}) 
	})

	r.Post("/networks/{id}/allocate-subnet", func(w http.ResponseWriter, r *http.Request){ 
		if !isCreator(r) { http.Error(w, "forbidden", 403); return }
		id, _ := strconv.ParseInt(chi.URLParam(r,"id"),10,64)
		username := getUsername(r, db)
		var req struct{ 
			Mask int `json:"mask"`
			Cidr string `json:"cidr"`
			Description string `json:"description"`
			Subdivide bool `json:"subdivide"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		
		desc := req.Description
		if desc == "" { 
			desc = "auto" 
		}
		
		var parent string
		if err := db.QueryRow(`SELECT address_range::text FROM networks WHERE id=$1`, id).Scan(&parent); err != nil { 
			http.Error(w, "network not found", 404)
			return 
		}
		
		var cand string
		if req.Cidr != "" {
			// Specific CIDR requested - verify it's available
			rows, err := db.Query(`SELECT address_range::text FROM networks WHERE parent=$1`, id)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			var children []string
			for rows.Next() { 
				var c string
				rows.Scan(&c)
				children = append(children, c) 
			}
			rows.Close()
			
			// Check if requested CIDR overlaps with existing
			for _, child := range children {
				if ipam.OverlapStr(req.Cidr, child) {
					http.Error(w, "subnet overlaps with existing allocation", 409)
					return
				}
			}
			// Check if requested CIDR is within parent
			if !ipam.ContainsStr(parent, req.Cidr) {
				http.Error(w, "subnet not within parent network", 400)
				return
			}
			cand = req.Cidr
		} else if req.Mask > 0 {
			// Legacy: auto-allocate by mask
			rows, err := db.Query(`SELECT address_range::text FROM networks WHERE parent=$1`, id)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			var children []string
			for rows.Next() { 
				var c string
				rows.Scan(&c)
				children = append(children, c) 
			}
			rows.Close()
			
			var allocErr error
			cand, allocErr = ipam.NextFreeSubnetStr(parent, children, req.Mask)
			if allocErr != nil { 
				http.Error(w, allocErr.Error(), 409)
				return 
			}
		} else {
			http.Error(w, "mask or cidr required", 400)
			return
		}
		
		var nid int64
		if err := db.QueryRow(`INSERT INTO networks(parent,address_range,description,subdivide) VALUES($1,$2::cidr,$3,$4) RETURNING id`, id, cand, desc, req.Subdivide).Scan(&nid); err != nil { 
			// Check if it's a duplicate key error (race condition - another user allocated it first)
			if strings.Contains(err.Error(), "duplicate") || strings.Contains(err.Error(), "unique") {
				http.Error(w, "subnet already allocated, please retry", 409)
				return
			}
			http.Error(w, err.Error(), 500)
			return 
		}
		action := "assigned"
		if req.Subdivide {
			action = "allocated for subdivision"
		}
		logChange(db, cand, fmt.Sprintf("subnet %s: %s by %s", action, desc, username), username)
		writeJSON(w, map[string]any{"id": nid, "address_range": cand, "subdivide": req.Subdivide}) 
	})

	// Get available subnets for a network (for edit mode)
	r.Get("/networks/{id}/available-subnets", func(w http.ResponseWriter, rq *http.Request){ 
		id, _ := strconv.ParseInt(chi.URLParam(rq,"id"),10,64)
		var parent string
		var validMasksStr sql.NullString
		if err := db.QueryRow(`SELECT address_range::text, valid_masks FROM networks WHERE id=$1`, id).Scan(&parent, &validMasksStr); err != nil { 
			http.Error(w, "network not found", 404)
			return 
		}
		// Get existing children
		rows, err := db.Query(`SELECT address_range::text FROM networks WHERE parent=$1`, id)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		var children []string
		for rows.Next() { 
			var c string
			rows.Scan(&c)
			children = append(children, c) 
		}
		rows.Close()
		
		// Use mask from query param if provided
		mask := 0
		if maskStr := rq.URL.Query().Get("mask"); maskStr != "" {
			mask, _ = strconv.Atoi(maskStr)
		}
		
		// If no mask specified, determine default
		if mask == 0 {
			// Use largest existing child, or largest valid mask, or parent+1
			for _, c := range children {
				m := ipam.GetMask(c)
				if mask == 0 || m < mask { 
					mask = m 
				}
			}
			if mask == 0 {
				if validMasksStr.Valid {
					validMasks := ipam.ParseSmallIntArray(validMasksStr.String)
					if len(validMasks) > 0 {
						mask = int(validMasks[0])
					}
				}
				if mask == 0 {
					mask = ipam.GetMask(parent) + 1
				}
			}
		}
		
		// Get all possible subnets at this mask
		available := ipam.AvailableSubnetsStr(parent, children, mask)
		out := []map[string]any{}
		for _, cidr := range available {
			out = append(out, map[string]any{"address_range": cidr, "mask": mask})
		}
		writeJSON(w, out) 
	})

	r.Get("/logs", func(w http.ResponseWriter, r *http.Request){ 
		limit := 50
		if s := r.URL.Query().Get("limit"); s != "" { 
			if v, err := strconv.Atoi(s); err == nil { 
				limit = v 
			} 
		}
		rows, err := db.Query(`
			SELECT c.change_time::text, c.prefix::text, c.change, u.username 
			FROM changelog c 
			JOIN users u ON c."user" = u.id 
			ORDER BY c.change_time DESC LIMIT $1`, limit)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer rows.Close()
		
		out := []map[string]any{}
		for rows.Next() { 
			var ctime, prefix, change, changedBy string
			if err := rows.Scan(&ctime, &prefix, &change, &changedBy); err != nil {
				continue
			}
			action := formatChangeLog(change, changedBy)
			out = append(out, map[string]any{"created_at": ctime, "prefix": prefix, "action": action, "user": changedBy})
		}
		writeJSON(w, out) 
	})

	// User management endpoints (admin only)
	r.Get("/users", func(w http.ResponseWriter, r *http.Request){
		if !isAdmin(r) { 
			http.Error(w, "admin required", 403)
			return 
		}
		rows, err := db.Query(`SELECT u.id, u.username, u.status, COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') as roles FROM users u LEFT JOIN user_roles ur ON ur."user"=u.id LEFT JOIN roles r ON r.id=ur.role GROUP BY u.id ORDER BY u.username`)
		if err != nil {
			http.Error(w, err.Error(), 500)
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
				continue
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
		writeJSON(w, out)
	})

	r.Post("/users", func(w http.ResponseWriter, r *http.Request){
		if !isAdmin(r) { 
			http.Error(w, "admin required", 403)
			return 
		}
		var req struct{ Username, Password string; Roles []string }
		json.NewDecoder(r.Body).Decode(&req)
		if req.Username == "" || req.Password == "" { 
			http.Error(w, "username and password required", 400)
			return 
		}
		hash := auth.MakeRFC2307SSHA(req.Password)
		var id int64
		err := db.QueryRow(`INSERT INTO users(username, password, status) VALUES($1, $2, 1) RETURNING id`, req.Username, hash).Scan(&id)
		if err != nil { 
			http.Error(w, err.Error(), 500)
			return 
		}
		// Add roles
		for _, role := range req.Roles {
			var rid int64
			if err := db.QueryRow(`SELECT id FROM roles WHERE name=$1`, role).Scan(&rid); err == nil {
				db.Exec(`INSERT INTO user_roles("user", role) VALUES($1, $2) ON CONFLICT DO NOTHING`, id, rid)
			}
		}
		writeJSON(w, map[string]any{"id": id, "username": req.Username})
	})

	r.Patch("/users/{id}", func(w http.ResponseWriter, r *http.Request){
		if !isAdmin(r) { 
			http.Error(w, "admin required", 403)
			return 
		}
		id, _ := strconv.ParseInt(chi.URLParam(r,"id"),10,64)
		var req struct{ Password string; Status *int; Roles []string }
		json.NewDecoder(r.Body).Decode(&req)
		if req.Password != "" {
			hash := auth.MakeRFC2307SSHA(req.Password)
			db.Exec(`UPDATE users SET password=$1 WHERE id=$2`, hash, id)
		}
		if req.Status != nil {
			db.Exec(`UPDATE users SET status=$1 WHERE id=$2`, *req.Status, id)
		}
		if req.Roles != nil {
			db.Exec(`DELETE FROM user_roles WHERE "user"=$1`, id)
			for _, role := range req.Roles {
				var rid int64
				if err := db.QueryRow(`SELECT id FROM roles WHERE name=$1`, role).Scan(&rid); err == nil {
					db.Exec(`INSERT INTO user_roles("user", role) VALUES($1, $2)`, id, rid)
				}
			}
		}
		writeJSON(w, map[string]any{"status": "ok"})
	})

	r.Delete("/users/{id}", func(w http.ResponseWriter, r *http.Request){
		if !isAdmin(r) { 
			http.Error(w, "admin required", 403)
			return 
		}
		id, _ := strconv.ParseInt(chi.URLParam(r,"id"),10,64)
		db.Exec(`DELETE FROM user_roles WHERE "user"=$1`, id)
		db.Exec(`DELETE FROM users WHERE id=$1`, id)
		writeJSON(w, map[string]any{"status": "ok"})
	})

	r.Get("/roles", func(w http.ResponseWriter, r *http.Request){
		rows, err := db.Query(`SELECT id, name FROM roles ORDER BY name`)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer rows.Close()
		
		out := []map[string]any{}
		for rows.Next() {
			var id int64
			var name string
			if err := rows.Scan(&id, &name); err != nil {
				continue
			}
			out = append(out, map[string]any{"id": id, "name": name})
		}
		writeJSON(w, out)
	})

	return r
}
