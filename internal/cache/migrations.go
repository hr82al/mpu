package cache

// allMigrations is the ordered list of all schema migrations.
// New migrations must be appended with a strictly increasing Version.
var allMigrations = []Migration{
	{
		Version: 1,
		SQL: `CREATE TABLE token_cache (
			key         TEXT PRIMARY KEY,
			token       TEXT    NOT NULL,
			obtained_at DATETIME NOT NULL
		)`,
	},
	{
		Version: 2,
		SQL: `CREATE TABLE sl_clients (
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
	},
}
