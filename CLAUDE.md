# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test

```bash
go build -ldflags="-s -w" -o mpu .                        # release build
make install                                               # build + install to ~/.local/bin + copy .env

go test ./internal/webapp/ -v -timeout 120s                # integration tests (requires .env)
go test ./internal/webapp/ -run TestSpreadsheetsGet -v     # single test
go test ./cmd/ -v                                          # unit tests (no .env needed)
go test ./internal/cache/ -v                               # cache unit tests
go test ./internal/defaults/ -v                            # defaults unit tests
go test ./internal/pgclient/ -v                            # pgclient tests (connection test skipped without PG)
```

## Architecture

`mpu` is a multi-purpose CLI utility (cobra) with three domains:

1. **Google Sheets** — proxy operations through a Google Apps Script endpoint (not the Sheets API directly)
2. **sl-back API** — client management, JWT auth, client data caching
3. **PostgreSQL** — direct SQL queries against local/remote databases per client schema

### Command groups

| Group | Commands | Description |
|-------|----------|-------------|
| sheets | `webApp *` (aliased at root) | Google Sheets CRUD via Apps Script |
| sl | `client`, `clients`, `token`, `update-spreadsheets` | sl-back API: client lookup, sync, auth, spreadsheet cache |
| meta | `ldb`, `rdb`, `lrdb`, `lsdb`, `config-path` | Database queries, config location |

### Flows

**Sheets:** CLI → `cmd/webapp_*.go` → `internal/webapp.Client.Do()` → HTTP POST to Apps Script → JSON response

**Client lookup:** CLI → `cmd/client.go` → `internal/cache` (SQLite) → miss → `internal/auth.GetToken()` + `internal/slapi.GetClients()` → cache → return

**Database query:** CLI → `cmd/ldb.go`/`cmd/rdb.go` → `internal/pgclient.QueryJSON()` → PostgreSQL → JSON output

### Key packages

- **`cmd/`** — One file per command. WebApp subcommands share persistent flags (`-s`, `-n`) and helpers (`newClient`, `requireFlag`, `resolveSpreadsheetID`, `checkResp`, `printRaw`, `checkProtected`) in `cmd/webapp.go`. Shortcuts in `cmd/zzz_shortcuts.go` register all webApp subcommands at root level (e.g., `mpu get` = `mpu webApp get`).
- **`internal/webapp/`** — `Client` interface with `Do(Request) (*Response, error)`. Retries up to 10 attempts; sleeps 60s on "Quota exceeded". HTTP timeout 120s.
- **`internal/config/`** — Loads `.env` from `~/.config/mpu/.env` via godotenv. Three config types: `Config` (webApp), `AuthConfig` (sl-back), `PGConfig` (PostgreSQL).
- **`internal/defaults/`** — Persisted CLI state in `~/.config/mpu/config.json`: last command, saved flags, protected mode. File permissions 0600.
- **`internal/cache/`** — SQLite cache at `~/.config/mpu/db` with migration system. Stores JWT tokens (10min TTL), client rows, and spreadsheet rows. Atomic client replacement via transactions. Spreadsheets use versioned updates (write new version → commit/rollback) with chunked inserts.
- **`internal/auth/`** — Token retrieval with cache-aside pattern: check SQLite cache → fetch from sl-back → cache → return.
- **`internal/slapi/`** — sl-back REST client. `GetClients(token)` → `[]cache.ClientRow`.
- **`internal/pgclient/`** — PostgreSQL via pgx. `QueryJSON(sql)` returns `[]map[string]any`.

### Smart defaults pattern

Flags are remembered across invocations in `~/.config/mpu/config.json`:
- `-s` (spreadsheet-id), `-n` (sheet-name), `--fields`, `client-id` — saved on explicit use, reused when omitted
- `mpu` with no args repeats the last executed command ("smart repeat")
- `protected=true` (default) blocks destructive operations; must be set to `false` manually

Flag resolution: explicit flag > positional arg > saved default > cobra default.

### Spreadsheet ID resolution

WebApp commands accept a positional argument to resolve spreadsheet ID instead of `-s`:
- `mpu get 54 -n UNIT` — lookup by client ID, interactive menu if multiple
- `mpu get "Cool Flaps" -n UNIT` — fuzzy search by title (sahilm/fuzzy), ranked menu
- `mpu get -s <id> -n UNIT` — explicit `-s` always wins
- For commands with JSON body: `mpu set 42 '[...]'` — query arg first, then body

Data comes from `sl_spreadsheets` table, populated by `mpu update-spreadsheets`.
Menu shows: `client_id`, `is_active`, `spreadsheet_id`, `title`, `template_name` (max 50 items).
Selected spreadsheet ID is saved to defaults.

### Adding a new webApp command

1. Create `cmd/webapp_<name>.go` with a `cobra.Command`
2. Use `newClient()` to get a `webapp.Client`
3. Call `c.Do(webapp.Request{"action": "...", ...})`
4. Handle with `checkResp()` + `printRaw()`; call `checkProtected()` for destructive ops
5. Register via `webAppCmd.AddCommand()` in `init()`
6. Add root-level shortcut in `cmd/zzz_shortcuts.go` via `shortcut()`

### Request format to Apps Script

```json
{"action": "spreadsheets/data/get", "ssId": "...", "sheetName": "...", ...}
```

Response: `{"success": true/false, "result": ..., "error": "..."}`

## Testing conventions

- **Unit tests** (`cmd/`, `internal/defaults/`, `internal/cache/`): no external deps, use temp dirs and mocks
- **Integration tests** (`internal/webapp/client_test.go`): require `.env` with real Apps Script URL and test spreadsheet
- **Mock pattern**: `testClientFn` in `cmd/webapp.go` allows injecting a mock `webapp.Client` for command tests
- **Test helpers**: `setupTest()`, `resetFlags()`, `run()` in `cmd/flags_test.go`
- **PG tests**: connection test only; query tests skipped without running PostgreSQL

## File locations

| Path | Purpose |
|------|---------|
| `~/.config/mpu/config.json` | Persisted defaults, protected flag, last command |
| `~/.config/mpu/.env` | Environment variables (credentials, URLs, ports) |
| `~/.config/mpu/db` | SQLite cache (tokens, clients, spreadsheets) |
| `~/.local/bin/mpu` | Installed binary |

## Environment

`.env` at `~/.config/mpu/.env` (copied there by `make install`).

**WebApp (required for sheets commands):**
- `WB_PLUS_WEB_APP_URL` — Google Apps Script deployment URL
- `WB_PLUS_WEB_APP_EMAIL` — authenticated user email

**sl-back API (required for client/clients/token):**
- `NEXT_PUBLIC_SERVER_URL`, `BASE_API_URL` — API base
- `TOKEN_EMAIL`, `TOKEN_PASSWORD` — login credentials

**PostgreSQL (required for ldb/rdb):**
- `PG_LOCAL_PORT`, `PG_PORT`, `PG_DB_NAME`, `PG_CLIENT_USER_PASSWORD`
- `PG_HOST` — optional, defaults to 127.0.0.1
- `PG_MY_USER_NAME`, `PG_MY_USER_PASSWORD` — remote access for lrdb / update-spreadsheets
- `PG_MAIN_USER_NAME`, `PG_MAIN_USER_PASSWORD` — local access for lsdb
- Server-name env vars (e.g., `sl_1=192.168.150.31`) — for remote host resolution in `rdb`

### Test spreadsheet

`1eJfRwbYlkyHbtTxmWzH6nCxeIJHgbqZwPwn5tfsRRZo` — read/write access, used by all integration tests.
