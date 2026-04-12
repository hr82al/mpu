# Cache Management Scripts

This directory contains scripts for managing the offline cache system (`forceCache` modes).

## Overview

The `mpu` CLI supports three cache modes to work offline when network is unavailable:

| Mode | Use Case |
|------|----------|
| `""` (default) | Normal operation, network calls fresh, results NOT cached |
| `"accumulate"` | Network calls fresh AND cache results in SQLite for later offline use |
| `"use"` | Read ONLY from cache; errors if data not cached (no network needed) |

## Scripts

### 1. `test-with-cache.sh` ⭐ **RECOMMENDED**

Complete test suite with automatic cache population.

**What it does:**
1. Builds the project
2. Runs all unit tests (defaults, cache, config, pgclient)
3. Creates mock cache data (token, clients, spreadsheets, etc.)
4. Switches to `forceCache=use` mode
5. Verifies offline operation works

**Usage:**
```bash
./scripts/test-with-cache.sh
```

**Output:**
```
✅ Build successful
✅ All unit tests passed
✅ Mock cache created
✅ Offline mode verified
```

**Time:** ~10-15 seconds

---

### 2. `cache-accumulate.sh`

Accumulates cache using real API calls (requires `.env` with credentials).

**What it does:**
1. Ensures config directory and `.env` exist
2. Sets `forceCache=accumulate`
3. Runs unit tests (to ensure cache tables exist)
4. Runs mpu commands to cache results:
   - `./mpu token` → caches auth token
   - `./mpu clients` → caches client list
   - `./mpu client <id>` → caches single client
   - `./mpu ldb <id> "SELECT..."` → caches DB query
5. Switches to `forceCache=use` mode

**Usage:**
```bash
./scripts/cache-accumulate.sh
```

**Requirements:**
- `.env` file at `~/.config/mpu/.env` with credentials:
  ```bash
  WB_PLUS_WEB_APP_URL=<url>
  WB_PLUS_WEB_APP_EMAIL=<email>
  NEXT_PUBLIC_SERVER_URL=<url>
  BASE_API_URL=/api
  TOKEN_EMAIL=<email>
  TOKEN_PASSWORD=<password>
  PG_DB_NAME=<dbname>
  PG_LOCAL_PORT=5441
  PG_PORT=5432
  PG_CLIENT_USER_PASSWORD=<password>
  # Optional for remote PG:
  PG_MY_USER_NAME=<user>
  PG_MY_USER_PASSWORD=<password>
  # Server host mappings:
  sl_1=10.0.0.1
  sl_2=10.0.0.2
  ```

**Time:** Depends on network; 1-5 minutes typically

---

### 3. `cache-mock.sh`

Populates cache with mock data (no credentials needed).

**What it does:**
1. Builds project
2. Creates SQLite cache database with schema
3. Inserts mock data:
   - 1 JWT token
   - 4 client records
   - 4 spreadsheet records
   - 1 webapp response
   - 1 PG query result
4. Switches to `forceCache=use` mode

**Usage:**
```bash
./scripts/cache-mock.sh
```

**No requirements** — works standalone

**Mock data:**
```
Clients:  1, 42, 100, 101
Servers:  sl-1, sl-2
Sheets:   sales, report, inventory
```

**Time:** ~5 seconds

---

## Workflow Examples

### Scenario 1: Testing Offline Mode (Fast)

```bash
# Generate mock cache and run tests
./scripts/test-with-cache.sh

# Now you can test offline:
./mpu token           # ✅ Works (from cache)
./mpu client 42       # ✅ Works (from cache)
./mpu clients         # ❌ Error (network unavailable)
```

### Scenario 2: Real API with .env Credentials

```bash
# Ensure .env exists
cat > ~/.config/mpu/.env << 'EOF'
WB_PLUS_WEB_APP_URL=https://script.google.com/...
WB_PLUS_WEB_APP_EMAIL=user@example.com
NEXT_PUBLIC_SERVER_URL=https://api.example.com
TOKEN_EMAIL=user@example.com
TOKEN_PASSWORD=your_password
PG_DB_NAME=dbname
PG_LOCAL_PORT=5441
PG_PORT=5432
PG_CLIENT_USER_PASSWORD=pwd
PG_MY_USER_NAME=myuser
PG_MY_USER_PASSWORD=mypwd
sl_1=192.168.1.10
sl_2=192.168.1.20
EOF

# Accumulate cache from real APIs
./scripts/cache-accumulate.sh

# Now forceCache=use, works offline
./mpu get -s <sheet_id> -n <sheet_name>
```

### Scenario 3: Switch Between Modes

```bash
# Currently in use mode (offline)
jq '.forceCache = "accumulate"' ~/.config/mpu/config.json | sponge ~/.config/mpu/config.json

# Now accumulate new results
./mpu token
./mpu clients

# Back to use mode
jq '.forceCache = "use"' ~/.config/mpu/config.json | sponge ~/.config/mpu/config.json
```

---

## Cache Location

```
~/.config/mpu/db           # SQLite cache database
~/.config/mpu/config.json  # Configuration (includes forceCache setting)
~/.config/mpu/.env         # Credentials (not needed for use mode)
```

## Cache Tables

| Table | Purpose | Key |
|-------|---------|-----|
| `token_cache` | Auth tokens | `sl_access_token` |
| `sl_clients` | Client records | `client_id` |
| `sl_spreadsheets` | Spreadsheet metadata | `(server, client_id, spreadsheet_id)` |
| `webapp_cache` | HTTP responses from Apps Script | SHA256(request) |
| `pgquery_cache` | PostgreSQL query results | SHA256(host+port+user+sql) |

## Inspect Cache

```bash
# List tables
sqlite3 ~/.config/mpu/db ".tables"

# Count rows
sqlite3 ~/.config/mpu/db "SELECT COUNT(*) FROM sl_clients;"

# View clients
sqlite3 ~/.config/mpu/db "SELECT id, server, is_active FROM sl_clients;"

# View cached responses
sqlite3 ~/.config/mpu/db "SELECT COUNT(*) FROM webapp_cache;"
```

## Configuration

View current mode:
```bash
jq '.forceCache' ~/.config/mpu/config.json
```

Change mode:
```bash
# To accumulate mode (cache writes)
jq '.forceCache = "accumulate"' ~/.config/mpu/config.json | sponge ~/.config/mpu/config.json

# To use mode (read-only cache)
jq '.forceCache = "use"' ~/.config/mpu/config.json | sponge ~/.config/mpu/config.json

# To normal mode (no caching)
jq '.forceCache = ""' ~/.config/mpu/config.json | sponge ~/.config/mpu/config.json
```

Or edit manually:
```bash
nano ~/.config/mpu/config.json
```

## remotePostgresOnly Mode

When `remotePostgresOnly: true`, PostgreSQL commands route to remote servers:

```bash
# Set in config
jq '.remotePostgresOnly = true' ~/.config/mpu/config.json | sponge ~/.config/mpu/config.json

# Now ldb uses remote PG (host from client.server)
./mpu ldb 42 "SELECT * FROM table"

# lsdb requires --host
./mpu lsdb --host sl-1 --scheme schema_42 "SELECT * FROM table"
```

## Troubleshooting

**Q: "no cached response" error in use mode**
```bash
A: You need to populate cache first in accumulate mode
   jq '.forceCache = "accumulate"' ~/.config/mpu/config.json | sponge ~/.config/mpu/config.json
   ./mpu get -s <sheet_id> -n <sheet_name>
   jq '.forceCache = "use"' ~/.config/mpu/config.json | sponge ~/.config/mpu/config.json
```

**Q: "network unavailable" error when running clients/token in use mode**
```bash
A: This is expected. These commands fetch from network.
   Run them in accumulate mode first, then switch to use mode.
```

**Q: Cache is stale, want to refresh**
```bash
# Option 1: Selective refresh
jq '.forceCache = "accumulate"' ~/.config/mpu/config.json | sponge ~/.config/mpu/config.json
./mpu clients  # Refreshes client list
./mpu ldb 42 "SELECT..."  # Refreshes this query
jq '.forceCache = "use"' ~/.config/mpu/config.json | sponge ~/.config/mpu/config.json

# Option 2: Full reset
rm ~/.config/mpu/db
./scripts/cache-mock.sh    # Or cache-accumulate.sh for real data
```

## Performance Notes

Cache hit times:
- Token: ~1ms (no TTL check)
- Client: ~5ms
- Spreadsheet: ~10ms
- WebApp response: ~2ms
- PG query: ~3ms

Cache miss error time: ~1ms (immediate fail)

---

## See Also

- `CLAUDE.md` — Full project documentation
- `.env.enc` — Encrypted credentials (for git sync)
- `config.json` — Persistent configuration
