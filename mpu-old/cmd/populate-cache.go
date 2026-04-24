// +build ignore

package main

import (
	"database/sql"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

func main() {
	home, err := os.UserHomeDir()
	if err != nil {
		log.Fatalf("get home dir: %v", err)
	}

	dbPath := filepath.Join(home, ".config", "mpu", "db")
	if err := os.MkdirAll(filepath.Dir(dbPath), 0700); err != nil {
		log.Fatalf("mkdir: %v", err)
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	// Initialize migrations table first
	db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version    INTEGER PRIMARY KEY,
		applied_at DATETIME NOT NULL DEFAULT (datetime('now'))
	)`)

	// Mark all migrations as applied
	for i := 1; i <= 5; i++ {
		db.Exec(`INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)`, i)
	}

	// Create tables
	tables := []string{
		`CREATE TABLE IF NOT EXISTS token_cache (
			key         TEXT PRIMARY KEY,
			token       TEXT    NOT NULL,
			obtained_at DATETIME NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS sl_clients (
			id             INTEGER PRIMARY KEY,
			server         TEXT    NOT NULL DEFAULT '',
			is_active      INTEGER NOT NULL DEFAULT 0,
			is_locked      INTEGER NOT NULL DEFAULT 0,
			is_deleted     INTEGER NOT NULL DEFAULT 0,
			created_at     TEXT,
			updated_at     TEXT,
			data_loaded_at TEXT,
			synced_at      TEXT    NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE TABLE IF NOT EXISTS sl_spreadsheets (
			server                  TEXT    NOT NULL DEFAULT '',
			client_id               INTEGER NOT NULL DEFAULT 0,
			spreadsheet_id          TEXT    NOT NULL DEFAULT '',
			title                   TEXT    NOT NULL DEFAULT '',
			template_name           TEXT    NOT NULL DEFAULT '',
			script_id               TEXT    NOT NULL DEFAULT '',
			is_active               INTEGER NOT NULL DEFAULT 0,
			created_at              TEXT,
			updated_at              TEXT,
			subscription_expires_at TEXT,
			version                 INTEGER NOT NULL DEFAULT 0,
			synced_at               TEXT    NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (server, client_id, spreadsheet_id)
		)`,
		`CREATE TABLE IF NOT EXISTS webapp_cache (
			key        TEXT PRIMARY KEY,
			response   TEXT NOT NULL,
			cached_at  DATETIME NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE TABLE IF NOT EXISTS pgquery_cache (
			key        TEXT PRIMARY KEY,
			result     TEXT NOT NULL,
			cached_at  DATETIME NOT NULL DEFAULT (datetime('now'))
		)`,
	}

	for _, ddl := range tables {
		db.Exec(ddl)
	}

	now := time.Now()

	// Insert token
	db.Exec(`DELETE FROM token_cache`)
	db.Exec(
		`INSERT INTO token_cache(key, token, obtained_at) VALUES (?, ?, ?)`,
		"sl_access_token", "mock_token_test_abc123def456", now,
	)

	// Insert clients
	db.Exec(`DELETE FROM sl_clients`)
	for _, vals := range [][]interface{}{
		{1, "sl-1", 1},
		{42, "sl-1", 1},
		{100, "sl-2", 1},
	} {
		db.Exec(
			`INSERT INTO sl_clients(id, server, is_active, is_locked, is_deleted, synced_at) VALUES (?, ?, ?, 0, 0, ?)`,
			vals[0], vals[1], vals[2], now,
		)
	}

	// Insert spreadsheets
	db.Exec(`DELETE FROM sl_spreadsheets`)
	for _, vals := range [][]interface{}{
		{"sl-1", 1, "sheet_1", "Sales", "sales", "script_1", 1},
		{"sl-1", 42, "sheet_42", "Report", "report", "script_42", 1},
		{"sl-2", 100, "sheet_100", "Inventory", "inventory", "script_100", 1},
	} {
		db.Exec(
			`INSERT INTO sl_spreadsheets(server, client_id, spreadsheet_id, title, template_name, script_id, is_active, version, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
			vals[0], vals[1], vals[2], vals[3], vals[4], vals[5], vals[6], now,
		)
	}

	// Insert webapp cache
	resp := map[string]interface{}{"success": true, "result": map[string]interface{}{"data": "test"}}
	respBytes, _ := json.Marshal(resp)
	db.Exec(`INSERT INTO webapp_cache(key, response, cached_at) VALUES (?, ?, ?)`,
		"test_webapp_key", string(respBytes), now)

	// Insert pgquery cache
	pgResult := []map[string]interface{}{{"id": 1, "name": "test"}}
	pgBytes, _ := json.Marshal(pgResult)
	db.Exec(`INSERT INTO pgquery_cache(key, result, cached_at) VALUES (?, ?, ?)`,
		"test_pgquery_key", string(pgBytes), now)

	log.Printf("✅ Mock cache populated at %s", dbPath)
}
