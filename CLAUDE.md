# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test

```bash
go build -ldflags="-s -w" -o mpu .     # release build
go test ./internal/webapp/ -v -timeout 120s  # integration tests (requires .env)
go test ./internal/webapp/ -run TestSpreadsheetsGet -v  # single test
```

## Architecture

`mpu` is a CLI utility (cobra) that proxies Google Sheets operations through a Google Apps Script endpoint. It does **not** use the Google Sheets API directly.

**Flow:** CLI command → `cmd/webapp_*.go` → `internal/webapp.Client.Do()` → HTTP POST to Apps Script URL → JSON response

### Key layers

- **`cmd/`** — One file per command. All `webApp` subcommands share persistent flags (`-s`, `-n`) and helpers (`newClient`, `requireFlag`, `checkResp`, `printRaw`) defined in `cmd/webapp.go`.
- **`internal/webapp/`** — `Client` interface with single `Do(Request) (*Response, error)` method. Handles retry (up to 9 attempts) and quota backoff. All requests are `map[string]interface{}` with an `"action"` key.
- **`internal/config/`** — Loads `.env` (searches up to 5 parent dirs). Two vars: `WB_PLUS_WEB_APP_URL`, `WB_PLUS_WEB_APP_EMAIL`.

### Adding a new webApp command

1. Create `cmd/webapp_<name>.go` with a `cobra.Command`
2. Use `newClient()` to get a `webapp.Client`
3. Call `c.Do(webapp.Request{"action": "...", ...})`
4. Handle with `checkResp()` + `printRaw()`
5. Register via `webAppCmd.AddCommand()` in `init()`

### Request format to Apps Script

```json
{"action": "spreadsheets/data/get", "ssId": "...", "sheetName": "...", ...}
```

Response: `{"success": true/false, "result": ..., "error": "..."}`


## Environment

`.env` file must contain `WB_PLUS_WEB_APP_URL` (Google Apps Script endpoint). This is the same endpoint used by `sl-back/src/webApp/webApp.service.js`.

### Test spreadsheet

`1eJfRwbYlkyHbtTxmWzH6nCxeIJHgbqZwPwn5tfsRRZo` — read/write access, used by all integration tests.
