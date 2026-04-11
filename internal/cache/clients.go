package cache

import (
	"database/sql"
	"fmt"
	"strconv"
	"time"
)

// ClientRow is a client record stored in the local SQLite cache.
type ClientRow struct {
	ID           int64      `json:"id"`
	Server       string     `json:"server"`
	IsActive     bool       `json:"is_active"`
	IsLocked     bool       `json:"is_locked"`
	IsDeleted    bool       `json:"is_deleted"`
	CreatedAt    *time.Time `json:"created_at,omitempty"`
	UpdatedAt    *time.Time `json:"updated_at,omitempty"`
	DataLoadedAt *time.Time `json:"data_loaded_at,omitempty"`
	SyncedAt     time.Time  `json:"synced_at"`
}

// ReplaceClients replaces all rows in sl_clients within a single transaction.
// On success the old data is fully replaced; on error nothing changes.
func (db *DB) ReplaceClients(rows []ClientRow) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	if _, err := tx.Exec(`DELETE FROM sl_clients`); err != nil {
		return fmt.Errorf("clear sl_clients: %w", err)
	}

	stmt, err := tx.Prepare(`
		INSERT INTO sl_clients(id, server, is_active, is_locked, is_deleted,
		                       created_at, updated_at, data_loaded_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		return fmt.Errorf("prepare insert: %w", err)
	}
	defer stmt.Close()

	for _, r := range rows {
		_, err := stmt.Exec(
			r.ID, r.Server,
			boolToInt(r.IsActive), boolToInt(r.IsLocked), boolToInt(r.IsDeleted),
			nullableTime(r.CreatedAt), nullableTime(r.UpdatedAt), nullableTime(r.DataLoadedAt),
		)
		if err != nil {
			return fmt.Errorf("insert client %d: %w", r.ID, err)
		}
	}
	return tx.Commit()
}

// GetClient returns a single client by ID, or (nil, false) if not found.
func (db *DB) GetClient(id int64) (*ClientRow, bool) {
	row := db.QueryRow(`
		SELECT id, server, is_active, is_locked, is_deleted,
		       created_at, updated_at, data_loaded_at, synced_at
		FROM sl_clients WHERE id = ?`, id)

	r, err := scanClient(row)
	if err != nil {
		return nil, false
	}
	return r, true
}

// HasClients returns true if the sl_clients table contains at least one row.
func (db *DB) HasClients() bool {
	var count int
	db.QueryRow(`SELECT COUNT(*) FROM sl_clients`).Scan(&count) //nolint:errcheck
	return count > 0
}

// ListClientIDs returns all client IDs as strings, sorted ascending.
// Used for shell completion.
func (db *DB) ListClientIDs() ([]string, error) {
	rows, err := db.Query(`SELECT id FROM sl_clients ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			continue
		}
		ids = append(ids, strconv.FormatInt(id, 10))
	}
	return ids, rows.Err()
}

// ActiveServers returns distinct server names from active clients.
func (db *DB) ActiveServers() ([]string, error) {
	rows, err := db.Query(`SELECT DISTINCT server FROM sl_clients WHERE is_active = 1 AND server != '' ORDER BY server`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var servers []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			continue
		}
		servers = append(servers, s)
	}
	return servers, rows.Err()
}

// — helpers —

func scanClient(row *sql.Row) (*ClientRow, error) {
	var r ClientRow
	var isActive, isLocked, isDeleted int
	var createdAt, updatedAt, dataLoadedAt sql.NullString
	var syncedAt string

	if err := row.Scan(
		&r.ID, &r.Server,
		&isActive, &isLocked, &isDeleted,
		&createdAt, &updatedAt, &dataLoadedAt,
		&syncedAt,
	); err != nil {
		return nil, err
	}
	r.IsActive = isActive != 0
	r.IsLocked = isLocked != 0
	r.IsDeleted = isDeleted != 0
	r.CreatedAt = parseNullTime(createdAt)
	r.UpdatedAt = parseNullTime(updatedAt)
	r.DataLoadedAt = parseNullTime(dataLoadedAt)
	r.SyncedAt, _ = time.Parse(time.DateTime, syncedAt)
	return &r, nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func nullableTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format(time.RFC3339)
}

func parseNullTime(s sql.NullString) *time.Time {
	if !s.Valid || s.String == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339, time.DateTime, "2006-01-02T15:04:05.999Z07:00"} {
		if t, err := time.Parse(layout, s.String); err == nil {
			return &t
		}
	}
	return nil
}
