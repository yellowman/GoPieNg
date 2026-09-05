package db

import (
	"context"
	"database/sql"
	_ "github.com/lib/pq"
	"time"
)

// DB wraps sql.DB to add helper methods
type DB struct {
	*sql.DB
}

func Open(dsn string) (*DB, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return &DB{db}, nil
}

// SetMaxOpenConns delegates to underlying DB
func (d *DB) SetMaxOpenConns(n int) {
	d.DB.SetMaxOpenConns(n)
}

// SetMaxIdleConns delegates to underlying DB
func (d *DB) SetMaxIdleConns(n int) {
	d.DB.SetMaxIdleConns(n)
}

// SetConnMaxLifetime delegates to underlying DB
func (d *DB) SetConnMaxLifetime(t time.Duration) {
	d.DB.SetConnMaxLifetime(t)
}
