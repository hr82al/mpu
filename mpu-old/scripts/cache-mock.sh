#!/bin/bash
set -e

# Mock cache population for offline testing (without .env credentials)
# Usage: ./scripts/cache-mock.sh
# This populates cache with mock data for testing forceCache=use mode

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CONFIG_DIR="$HOME/.config/mpu"
DB_PATH="$CONFIG_DIR/db"

echo "🎭 Mock Cache Population"
echo "========================"
echo ""

# === Step 1: Build
echo "🔨 Building..."
cd "$PROJECT_ROOT"
CGO_ENABLED=1 go build -ldflags="-s -w" -o mpu .
echo "✅ Built"

# === Step 2: Create config with accumulate mode
echo "⚙️  Setting up config..."
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

cat > "$CONFIG_DIR/config.json" << 'EOF'
{
  "protected": false,
  "forceCache": "accumulate",
  "remotePostgresOnly": false,
  "defaults": {
    "client-id": 42,
    "spreadsheet-id": "mock_sheet_id_123"
  }
}
EOF
echo "✅ Config ready"

# === Step 3: Create mock cache data
echo ""
echo "📝 Populating mock cache data..."

# Initialize database with migrations
./mpu config-path > /dev/null 2>&1 || true
if [ ! -f "$DB_PATH" ]; then
    # Force database creation by opening it
    sqlite3 "$DB_PATH" "SELECT 1;" > /dev/null

    # Apply migrations manually
    sqlite3 "$DB_PATH" << 'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- Migration 1: token_cache
INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
CREATE TABLE IF NOT EXISTS token_cache (
    key         TEXT PRIMARY KEY,
    token       TEXT    NOT NULL,
    obtained_at DATETIME NOT NULL
);

-- Migration 2: sl_clients
INSERT OR IGNORE INTO schema_migrations(version) VALUES (2);
CREATE TABLE IF NOT EXISTS sl_clients (
    id             INTEGER PRIMARY KEY,
    server         TEXT    NOT NULL DEFAULT '',
    is_active      INTEGER NOT NULL DEFAULT 0,
    is_locked      INTEGER NOT NULL DEFAULT 0,
    is_deleted     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT,
    updated_at     TEXT,
    data_loaded_at TEXT,
    synced_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Migration 3: sl_spreadsheets
INSERT OR IGNORE INTO schema_migrations(version) VALUES (3);
CREATE TABLE IF NOT EXISTS sl_spreadsheets (
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
CREATE INDEX IF NOT EXISTS idx_sl_spreadsheets_client_id ON sl_spreadsheets(client_id);
CREATE INDEX IF NOT EXISTS idx_sl_spreadsheets_title ON sl_spreadsheets(title);
CREATE INDEX IF NOT EXISTS idx_sl_spreadsheets_spreadsheet_id ON sl_spreadsheets(spreadsheet_id);
CREATE INDEX IF NOT EXISTS idx_sl_spreadsheets_version ON sl_spreadsheets(version);

-- Migration 4: webapp_cache
INSERT OR IGNORE INTO schema_migrations(version) VALUES (4);
CREATE TABLE IF NOT EXISTS webapp_cache (
    key        TEXT PRIMARY KEY,
    response   TEXT NOT NULL,
    cached_at  DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- Migration 5: pgquery_cache
INSERT OR IGNORE INTO schema_migrations(version) VALUES (5);
CREATE TABLE IF NOT EXISTS pgquery_cache (
    key        TEXT PRIMARY KEY,
    result     TEXT NOT NULL,
    cached_at  DATETIME NOT NULL DEFAULT (datetime('now'))
);
SQL
fi

# === Step 4: Insert mock data
echo ""
echo "🔌 Inserting mock data..."

sqlite3 "$DB_PATH" << 'SQL'
-- Insert mock token
INSERT OR REPLACE INTO token_cache(key, token, obtained_at)
VALUES ('sl_access_token', 'mock_jwt_token_' || hex(randomblob(32)), datetime('now'));

-- Insert mock clients
DELETE FROM sl_clients;
INSERT INTO sl_clients(id, server, is_active, is_locked, is_deleted, created_at, updated_at, synced_at)
VALUES
  (1, 'sl-1', 1, 0, 0, '2024-01-01T00:00:00Z', '2024-01-15T10:30:00Z', datetime('now')),
  (42, 'sl-1', 1, 0, 0, '2024-01-05T08:00:00Z', '2024-02-10T14:20:00Z', datetime('now')),
  (100, 'sl-2', 1, 0, 0, '2024-02-01T12:00:00Z', '2024-02-28T16:45:00Z', datetime('now')),
  (101, 'sl-2', 0, 0, 0, '2024-02-15T09:15:00Z', '2024-03-01T11:30:00Z', datetime('now'));

-- Insert mock spreadsheets
INSERT OR REPLACE INTO sl_spreadsheets(server, client_id, spreadsheet_id, title, template_name, script_id, is_active, version, synced_at)
VALUES
  ('sl-1', 1, 'mock_sheet_id_001', 'Q1 Sales Report', 'sales_template', 'script_001', 1, 1, datetime('now')),
  ('sl-1', 42, 'mock_sheet_id_123', 'Test Spreadsheet', 'test_template', 'script_042', 1, 1, datetime('now')),
  ('sl-1', 42, 'mock_sheet_id_124', 'Archive Sheet', 'archive_template', 'script_043', 0, 1, datetime('now')),
  ('sl-2', 100, 'mock_sheet_id_200', 'Q1 Pipeline', 'pipeline_template', 'script_100', 1, 1, datetime('now'));

-- Insert mock webapp response (simple GET response)
INSERT OR REPLACE INTO webapp_cache(key, response, cached_at)
VALUES
  ('d7a8f6c0e3b5a2f1d9c8b7a6e5f4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7',
   '{"success":true,"result":[[1,"Header1","Header2"],[2,"Row1Col1","Row1Col2"]]}',
   datetime('now'));

-- Insert mock pgquery result
INSERT OR REPLACE INTO pgquery_cache(key, result, cached_at)
VALUES
  ('e8b9f7d6c5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9',
   '[{"count":42},{"count":100},{"count":58}]',
   datetime('now'));
SQL

echo "✅ Mock data inserted"

# === Step 5: Verify cache
echo ""
echo "🔍 Cache contents:"
sqlite3 "$DB_PATH" << 'SQL'
SELECT '=== token_cache ===' as status, COUNT(*) as count FROM token_cache
UNION ALL SELECT '=== sl_clients ===' as status, COUNT(*) FROM sl_clients
UNION ALL SELECT '=== sl_spreadsheets ===' as status, COUNT(*) FROM sl_spreadsheets
UNION ALL SELECT '=== webapp_cache ===' as status, COUNT(*) FROM webapp_cache
UNION ALL SELECT '=== pgquery_cache ===' as status, COUNT(*) FROM pgquery_cache;

SELECT '--- Clients ---' as info;
SELECT id, server, is_active FROM sl_clients LIMIT 5;

SELECT '--- Spreadsheets ---' as info;
SELECT client_id, spreadsheet_id, title FROM sl_spreadsheets LIMIT 5;
SQL

# === Step 6: Switch to use mode
echo ""
echo "⚙️  Switching to forceCache=use..."
cat > "$CONFIG_DIR/config.json" << 'EOF'
{
  "protected": false,
  "forceCache": "use",
  "remotePostgresOnly": false,
  "defaults": {
    "client-id": 42,
    "spreadsheet-id": "mock_sheet_id_123"
  }
}
EOF
echo "✅ Switched to offline mode"

# === Step 7: Test offline mode
echo ""
echo "✅ Testing offline mode..."
echo ""

if ./mpu client 42 > /dev/null 2>&1; then
    echo "✅ mpu client 42 — works offline (from cache)"
else
    echo "❌ mpu client 42 — failed"
fi

if ./mpu token 2>&1 | grep -q "mock_jwt_token_"; then
    echo "✅ mpu token — works offline (from cache)"
else
    echo "❌ mpu token — failed"
fi

# === Summary
echo ""
echo "════════════════════════════════════════════"
echo "✅ Mock cache population complete!"
echo "════════════════════════════════════════════"
echo ""
echo "Status: forceCache=use (OFFLINE MODE)"
echo "Cache DB: $DB_PATH"
echo ""
echo "Cached data:"
echo "  • 1 token"
echo "  • 4 clients (IDs: 1, 42, 100, 101)"
echo "  • 4 spreadsheets"
echo "  • 1 webapp response"
echo "  • 1 pgquery result"
echo ""
echo "Test offline access:"
echo "  ./mpu token"
echo "  ./mpu client 42"
echo "  ./mpu clients"
echo ""
echo "Switch back to accumulate mode:"
echo "  jq '.forceCache = \"accumulate\"' ~/.config/mpu/config.json > /tmp/cfg.json"
echo "  mv /tmp/cfg.json ~/.config/mpu/config.json"
echo ""
