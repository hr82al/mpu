package cache

import (
	"database/sql"
	"encoding/json"
	"errors"
)

// GetPGResult returns cached PG query result by key, or (nil, false) if not found.
func (db *DB) GetPGResult(key string) ([]byte, bool) {
	var result string
	err := db.QueryRow(
		`SELECT result FROM pgquery_cache WHERE key = ?`, key,
	).Scan(&result)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false
	}
	if err != nil {
		return nil, false
	}
	return []byte(result), true
}

// SetPGResult stores (or replaces) cached PG query result.
func (db *DB) SetPGResult(key string, data []byte) error {
	_, err := db.Exec(
		`INSERT OR REPLACE INTO pgquery_cache(key, result, cached_at)
		 VALUES (?, ?, datetime('now'))`,
		key, string(data),
	)
	return err
}

// SetPGResultFromRows converts []map[string]any to JSON and stores in cache.
func (db *DB) SetPGResultFromRows(key string, rows []map[string]any) error {
	data, err := json.Marshal(rows)
	if err != nil {
		return err
	}
	return db.SetPGResult(key, data)
}
