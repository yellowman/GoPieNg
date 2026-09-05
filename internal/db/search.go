package db

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
)

func searchHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("q")
		mode := r.URL.Query().Get("mode")
		if mode == "" {
			mode = "hosts"
		}
		if len(q) > 256 || (mode != "hosts" && mode != "networks") {
			respondError(w, problem(400, "invalid search"))
			return
		}
		results := []map[string]any{}
		if q == "" {
			writeJSON(w, map[string]any{"results": results})
			return
		}
		pattern := "%" + q + "%"
		var rows *sql.Rows
		var err error
		if mode == "networks" {
			rows, err = db.QueryContext(r.Context(), `SELECT id,address_range::text,description,owner,account FROM networks WHERE address_range::text ILIKE $1 OR description ILIKE $1 OR owner ILIKE $1 OR account=$2 ORDER BY address_range LIMIT 100`, pattern, q)
		} else {
			rows, err = db.QueryContext(r.Context(), `SELECT host(h.address),h.network,h.description,n.address_range::text FROM hosts h JOIN networks n ON h.network=n.id WHERE host(h.address) ILIKE $1 OR h.description ILIKE $1 ORDER BY h.address LIMIT 100`, pattern)
		}
		if err != nil {
			respondError(w, err)
			return
		}
		defer rows.Close()
		ids := []int64{}
		for rows.Next() {
			var id int64
			var address string
			if mode == "networks" {
				var desc, owner, account sql.NullString
				err = rows.Scan(&id, &address, &desc, &owner, &account)
				results = append(results, map[string]any{"type": "network", "id": id, "address_range": address, "description": desc.String, "owner": owner.String, "account": account.String})
			} else {
				var desc, network string
				err = rows.Scan(&address, &id, &desc, &network)
				results = append(results, map[string]any{"type": "host", "address": address, "network_id": id, "description": desc, "network_range": network})
			}
			if err != nil {
				respondError(w, err)
				return
			}
			ids = append(ids, id)
		}
		err = rows.Err()
		rows.Close() // Release before ancestry queries, even with a one-connection pool.
		if err != nil {
			respondError(w, err)
			return
		}
		cache := map[int64][]int64{}
		for i, id := range ids {
			path, ok := cache[id]
			if !ok {
				path, err = ancestry(r.Context(), db, id)
				if err != nil {
					respondError(w, err)
					return
				}
				cache[id] = path
			}
			p := append([]int64{}, path...)
			if mode == "hosts" {
				p = append(p, id)
			}
			results[i]["ancestry"] = p
		}
		writeJSON(w, map[string]any{"results": results})
	}
}

func ancestry(ctx context.Context, db *sql.DB, id int64) ([]int64, error) {
	path := []int64{}
	seen := map[int64]bool{}
	for depth := 0; depth < 128; depth++ {
		if seen[id] {
			return nil, fmt.Errorf("cycle in network ancestry")
		}
		seen[id] = true
		var parent sql.NullInt64
		if err := db.QueryRowContext(ctx, `SELECT parent FROM networks WHERE id=$1`, id).Scan(&parent); err != nil {
			return nil, err
		}
		if !parent.Valid {
			for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
				path[i], path[j] = path[j], path[i]
			}
			return path, nil
		}
		path = append(path, parent.Int64)
		id = parent.Int64
	}
	return nil, fmt.Errorf("network ancestry exceeds 128 levels")
}
