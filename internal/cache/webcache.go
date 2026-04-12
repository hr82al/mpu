package cache

import (
	"database/sql"
	"errors"
)

// GetWebAppResponse returns cached webapp response by key, or (nil, false) if not found.
func (db *DB) GetWebAppResponse(key string) ([]byte, bool) {
	var response string
	err := db.QueryRow(
		`SELECT response FROM webapp_cache WHERE key = ?`, key,
	).Scan(&response)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false
	}
	if err != nil {
		return nil, false
	}
	return []byte(response), true
}

// SetWebAppResponse stores (or replaces) cached webapp response.
func (db *DB) SetWebAppResponse(key string, data []byte) error {
	_, err := db.Exec(
		`INSERT OR REPLACE INTO webapp_cache(key, response, cached_at)
		 VALUES (?, ?, datetime('now'))`,
		key, string(data),
	)
	return err
}
