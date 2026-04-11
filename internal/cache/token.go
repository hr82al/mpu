package cache

import (
	"database/sql"
	"errors"
	"time"
)

// GetToken returns the cached token for key if it was obtained within maxAge.
// Returns ("", false) when the cache is empty or the entry is stale.
func (db *DB) GetToken(key string, maxAge time.Duration) (string, bool) {
	var token string
	var obtainedAt time.Time
	err := db.QueryRow(
		`SELECT token, obtained_at FROM token_cache WHERE key = ?`, key,
	).Scan(&token, &obtainedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false
	}
	if err != nil {
		return "", false
	}
	if time.Since(obtainedAt) > maxAge {
		return "", false
	}
	return token, true
}

// SetToken stores (or replaces) the token for key, stamping obtained_at = now.
func (db *DB) SetToken(key, token string) error {
	_, err := db.Exec(
		`INSERT OR REPLACE INTO token_cache(key, token, obtained_at)
		 VALUES (?, ?, datetime('now'))`,
		key, token,
	)
	return err
}
