package cache

import (
	"database/sql"
	"fmt"
	"time"
)

// SpreadsheetRow is a spreadsheet record cached from public.spreadsheets.
type SpreadsheetRow struct {
	Server                string     `json:"server"`
	ClientID              int64      `json:"client_id"`
	SpreadsheetID         string     `json:"spreadsheet_id"`
	Title                 string     `json:"title"`
	TemplateName          string     `json:"template_name"`
	ScriptID              string     `json:"script_id"`
	IsActive              bool       `json:"is_active"`
	CreatedAt             *time.Time `json:"created_at,omitempty"`
	UpdatedAt             *time.Time `json:"updated_at,omitempty"`
	SubscriptionExpiresAt *time.Time `json:"subscription_expires_at,omitempty"`
	Version               int64      `json:"version"`
	SyncedAt              time.Time  `json:"synced_at"`
}

const ChunkSize = 500

// NextSpreadsheetVersion returns MAX(version)+1, or 1 if no rows exist.
func (db *DB) NextSpreadsheetVersion() (int64, error) {
	var v int64
	err := db.QueryRow(`SELECT COALESCE(MAX(version), 0) + 1 FROM sl_spreadsheets`).Scan(&v)
	return v, err
}

// InsertSpreadsheetChunk inserts a batch of rows in a single transaction.
func (db *DB) InsertSpreadsheetChunk(rows []SpreadsheetRow) error {
	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	stmt, err := tx.Prepare(`
		INSERT OR REPLACE INTO sl_spreadsheets(
			server, client_id, spreadsheet_id, title, template_name, script_id,
			is_active, created_at, updated_at, subscription_expires_at, version)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		return fmt.Errorf("prepare insert: %w", err)
	}
	defer stmt.Close()

	for _, r := range rows {
		_, err := stmt.Exec(
			r.Server, r.ClientID, r.SpreadsheetID,
			r.Title, r.TemplateName, r.ScriptID,
			boolToInt(r.IsActive),
			nullableTime(r.CreatedAt), nullableTime(r.UpdatedAt),
			nullableTime(r.SubscriptionExpiresAt),
			r.Version,
		)
		if err != nil {
			return fmt.Errorf("insert spreadsheet %s/%d/%s: %w", r.Server, r.ClientID, r.SpreadsheetID, err)
		}
	}
	return tx.Commit()
}

// CommitSpreadsheetVersion deletes all rows with version < v (old data).
func (db *DB) CommitSpreadsheetVersion(v int64) error {
	_, err := db.Exec(`DELETE FROM sl_spreadsheets WHERE version < ?`, v)
	return err
}

// RollbackSpreadsheetVersion deletes all rows with version = v (new incomplete data).
func (db *DB) RollbackSpreadsheetVersion(v int64) error {
	_, err := db.Exec(`DELETE FROM sl_spreadsheets WHERE version = ?`, v)
	return err
}

// maxVersionFilter is a subquery returning the current (latest) version.
const maxVersionFilter = `version = (SELECT COALESCE(MAX(version), 0) FROM sl_spreadsheets)`

// SpreadsheetsByClientID returns all spreadsheets for a given client_id (latest version).
func (db *DB) SpreadsheetsByClientID(clientID int64) ([]SpreadsheetRow, error) {
	rows, err := db.Query(`
		SELECT server, client_id, spreadsheet_id, title, template_name, script_id,
		       is_active, created_at, updated_at, subscription_expires_at, version, synced_at
		FROM sl_spreadsheets
		WHERE client_id = ? AND `+maxVersionFilter+`
		ORDER BY title`, clientID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSpreadsheets(rows)
}

// SearchSpreadsheets returns spreadsheets matching query via LIKE on title (latest version).
func (db *DB) SearchSpreadsheets(query string, limit int) ([]SpreadsheetRow, error) {
	rows, err := db.Query(`
		SELECT server, client_id, spreadsheet_id, title, template_name, script_id,
		       is_active, created_at, updated_at, subscription_expires_at, version, synced_at
		FROM sl_spreadsheets
		WHERE LOWER(title) LIKE ? AND `+maxVersionFilter+`
		LIMIT ?`, "%"+query+"%", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSpreadsheets(rows)
}

// AllSpreadsheets returns all spreadsheets (latest version). Used for fuzzy ranking.
func (db *DB) AllSpreadsheets() ([]SpreadsheetRow, error) {
	rows, err := db.Query(`
		SELECT server, client_id, spreadsheet_id, title, template_name, script_id,
		       is_active, created_at, updated_at, subscription_expires_at, version, synced_at
		FROM sl_spreadsheets
		WHERE ` + maxVersionFilter + `
		ORDER BY title`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSpreadsheets(rows)
}

// HasSpreadsheets returns true if sl_spreadsheets has at least one row.
func (db *DB) HasSpreadsheets() bool {
	var count int
	db.QueryRow(`SELECT COUNT(*) FROM sl_spreadsheets`).Scan(&count) //nolint:errcheck
	return count > 0
}

func scanSpreadsheets(rows *sql.Rows) ([]SpreadsheetRow, error) {
	var result []SpreadsheetRow
	for rows.Next() {
		r, err := scanSpreadsheetRow(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *r)
	}
	return result, rows.Err()
}

func scanSpreadsheetRow(rows *sql.Rows) (*SpreadsheetRow, error) {
	var r SpreadsheetRow
	var isActive int
	var createdAt, updatedAt, subExpires sql.NullString
	var syncedAt string

	if err := rows.Scan(
		&r.Server, &r.ClientID, &r.SpreadsheetID,
		&r.Title, &r.TemplateName, &r.ScriptID,
		&isActive,
		&createdAt, &updatedAt, &subExpires,
		&r.Version, &syncedAt,
	); err != nil {
		return nil, err
	}
	r.IsActive = isActive != 0
	r.CreatedAt = parseNullTime(createdAt)
	r.UpdatedAt = parseNullTime(updatedAt)
	r.SubscriptionExpiresAt = parseNullTime(subExpires)
	r.SyncedAt, _ = time.Parse(time.DateTime, syncedAt)
	return &r, nil
}
