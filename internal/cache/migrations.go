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
	{
		Version: 3,
		SQL: `CREATE TABLE sl_spreadsheets (
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
		);
		CREATE INDEX idx_sl_spreadsheets_client_id ON sl_spreadsheets(client_id);
		CREATE INDEX idx_sl_spreadsheets_title ON sl_spreadsheets(title);
		CREATE INDEX idx_sl_spreadsheets_spreadsheet_id ON sl_spreadsheets(spreadsheet_id);
		CREATE INDEX idx_sl_spreadsheets_version ON sl_spreadsheets(version)`,
	},
}
