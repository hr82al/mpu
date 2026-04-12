# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Coding guidelines

**Janet-first, Go для обвязки.** Весь новый код, если не оговорено иначе, должен:

1. **Следовать DRY и SOLID** — без дублирования, единая ответственность. В Janet: именованные роли вместо хардкода, `paint`/`c` вместо inline ANSI-кодов. В Go: типизированный мост (`DoEval`, `EvalStringSlice`) вместо парсинга строк.

2. **Быть написан преимущественно на Janet** — вся логика REPL (автодополнение, подсветка, форматирование, help, prompt) живёт в `janet/*.janet`. Go менять только когда нужна новая инфраструктура моста, concurrency или доступ к данным, недоступным из Janet (cobra flags, файловая система, горутины).

3. **Не жертвовать производительностью** — после каждого изменения Janet-кода запускать бенчмарки:
   ```bash
   go test ./cmd/ -bench . -benchmem -timeout 120s        # REPL script benchmarks
   go test ./internal/janet/ -bench . -benchmem            # VM-level benchmarks
   ```
   Если Janet-функция занимает >1ms для операции автодополнения или >5ms для подсветки — это проблема. Решение: минимальное изменение в Go (bridge function или C helper) при сохранении основной логики в Janet. Пример: дополнение флагов (`:keyword`, `--flag`) — Go читает cobra FlagSet напрямую (~1μs), но дополнение символов и команд идёт через Janet (~130μs, приемлемо).

4. **TDD обязателен.** Любая новая функциональность или багфикс начинается с теста, который падает по той же причине, что и проблема/отсутствующая фича. Только после **red** (тест упал на ожидаемом месте) пишется минимальный код до **green**, затем — рефакторинг. Для багов тест должен воспроизводить исходный симптом, чтобы поймать регрессию (пример: `TestResetCobraFlagsStringArray` и `TestReplBridgeBatchGetRanges` — первый изолирует root cause на уровне функции, второй воспроизводит full-stack сценарий через Janet bridge). Интеграционные тесты на живые API (`internal/webapp/client_test.go`) — отдельный слой; юнит-тесты не должны требовать `.env` и внешней сети.

5. **Справочные бенчмарки** (Intel i5-8350U):
   | Operation | Time | Where |
   |-----------|------|-------|
   | `highlight/result` | ~6μs | Janet |
   | `highlight/source` (short) | ~23μs | Janet |
   | `prompt/get` | ~6μs | Janet |
   | `complete/candidates` | ~130μs | Janet |
   | Flag completion (`:kw`, `--flag`) | ~1μs | Go |
   | `DoString` (simple expr) | ~6μs | Go→Janet |
   | `EvalStringSlice` (small array) | ~5μs | Go→Janet |

## Build & Test

```bash
CGO_ENABLED=1 go build -ldflags="-s -w" -o mpu .           # release build (cgo required for embedded Janet)
make install                                               # build + install to ~/.local/bin + copy .env

go test ./internal/webapp/ -v -timeout 120s                # integration tests (requires .env)
go test ./internal/webapp/ -run TestSpreadsheetsGet -v     # single test
go test ./cmd/ -v                                          # unit tests (no .env needed)
go test ./internal/cache/ -v                               # cache unit tests
go test ./internal/defaults/ -v                            # defaults unit tests
go test ./internal/pgclient/ -v                            # pgclient tests (connection test skipped without PG)
go test ./internal/janet/ -v                               # janet VM unit tests

go test ./cmd/ -bench . -benchmem -timeout 120s            # REPL Janet script benchmarks
go test ./internal/janet/ -bench . -benchmem               # VM-level benchmarks
```

**Important:** During build and test:
- Do **NOT** delete the SQLite cache (`~/.config/mpu/db`) or any config files
- Do **NOT** reset cached data between test runs
- Only create default files/directories if they don't already exist
- Tests and build artifacts must preserve user state and existing cache

## Architecture

`mpu` is a multi-purpose CLI utility (cobra) with four domains:

1. **Google Sheets** — proxy operations through a Google Apps Script endpoint (not the Sheets API directly)
2. **sl-back API** — client management, JWT auth, client data caching
3. **PostgreSQL** — direct SQL queries against local/remote databases per client schema
4. **Janet REPL** — embedded Janet scripting with access to all mpu commands at runtime

### Command groups

| Group | Commands | Description |
|-------|----------|-------------|
| sheets | `webApp *` (aliased at root) | Google Sheets CRUD via Apps Script |
| sl | `client`, `clients`, `token`, `update-spreadsheets`, `ldb`, `rdb`, `lsdb`, `rsdb` | sl-back API, PostgreSQL per-client schema access |
| meta | `config-path`, `repl` | Config location, Janet REPL |

### Flows

**Sheets:** CLI → `cmd/webapp_*.go` → `internal/webapp.Client.Do()` → HTTP POST to Apps Script → JSON response

**Client lookup:** CLI → `cmd/client.go` → `internal/cache` (SQLite) → miss → `internal/auth.GetToken()` + `internal/slapi.GetClients()` → cache → return

**Database query:** CLI → `cmd/ldb.go`/`cmd/rdb.go` → `internal/pgclient.QueryJSON()` → PostgreSQL → JSON output

**Janet REPL:** CLI → `cmd/repl.go` → `internal/janet.VM` (cgo + Janet amalgamation) → registers all cobra leaf commands as `mpu/*` Janet functions → interactive REPL or script execution

### Key packages

- **`cmd/`** — One file per command. WebApp subcommands share persistent flags (`-s`, `-n`) and helpers (`newClient`, `requireFlag`, `resolveSpreadsheetID`, `checkResp`, `printRaw`, `checkProtected`) in `cmd/webapp.go`. Shortcuts in `cmd/zzz_shortcuts.go` register all webApp subcommands at root level (e.g., `mpu get` = `mpu webApp get`).
- **`internal/webapp/`** — `Client` interface with `Do(Request) (*Response, error)`. Retries up to 10 attempts; sleeps 60s on "Quota exceeded". HTTP timeout 120s.
- **`internal/config/`** — Loads `.env` from `~/.config/mpu/.env` via godotenv. Three config types: `Config` (webApp), `AuthConfig` (sl-back), `PGConfig` (PostgreSQL).
- **`internal/defaults/`** — Persisted CLI state in `~/.config/mpu/config.json`: last command, saved flags, protected mode. File permissions 0600.
- **`internal/cache/`** — SQLite cache at `~/.config/mpu/db` with migration system. Stores JWT tokens (10min TTL), client rows, and spreadsheet rows. Atomic client replacement via transactions. Spreadsheets use versioned updates (write new version → commit/rollback) with chunked inserts.
- **`internal/auth/`** — Token retrieval with cache-aside pattern: check SQLite cache → fetch from sl-back → cache → return.
- **`internal/slapi/`** — sl-back REST client. `GetClients(token)` → `[]cache.ClientRow`.
- **`internal/pgclient/`** — PostgreSQL via pgx. `QueryJSON(sql)` returns `[]map[string]any`.
- **`internal/janet/`** — Embedded Janet v1.41.2 VM via cgo. Contains amalgamation (`janet.c`, `janet.h`) and Go wrapper (`janet.go`). `VM` type with `New()`, `Close()`, `Register()`, `DoString()`, `DoEval()`, `EvalStringSlice()`. Up to 64 Go functions registered via C trampoline dispatch. Compiled with `JANET_NO_DYNAMIC_MODULES`, `JANET_NO_FFI` — only `-lm` linked, portable across glibc and musl. Full Janet features enabled: fibers/coroutines, PEG, os/clock, event loop primitives. JSON support via vendored spork/json (`json.c`) registered on VM creation: `(json/encode x &opt tab newline buf)` and `(json/decode src &opt keywords nils)` — see `docs/janet-json.md` for Lisp-way patterns (get-in, postwalk, threading).

### Smart defaults pattern

Flags are remembered across invocations in `~/.config/mpu/config.json`:
- `-s` (spreadsheet-id), `-n` (sheet-name), `--fields`, `client-id`, `--scheme`, `--host` — saved on explicit use, reused when omitted
- `mpu` with no args repeats the last executed command ("smart repeat")
- `protected=true` (default) blocks destructive operations; must be set to `false` manually

Flag resolution: explicit flag > positional arg > saved default > cobra default.

Commands annotated with `skipDefaultsAnnotation` (e.g., `repl`) save config but do not update the `Command` field, preserving the previous command for smart repeat.

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

### Janet REPL

`mpu repl` starts an interactive Janet session with all mpu commands available:

```bash
mpu repl                          # interactive REPL
mpu repl script.janet             # execute a Janet script file
```

**Features (IPython-like):**
- Tab completion for mpu commands, flags, and Janet symbols
- Persistent history with Ctrl-R reverse search (`~/.config/mpu/history`)
- Multi-line input (unclosed parens auto-continue)
- Syntax-highlighted output (values colored by type via Janet)
- Result history: `_`, `__`, `___` (last three results)
- Input history: `_i`, `_ii`, `_iii` (last three inputs)
- Numbered prompt: `mpu:N>`
- Magic commands: `%time`, `%who`, `%hist`, `%load`, `%env`, `%pp`, `%highlight`, `%reset`
- Help system: `(?)`, `(? mpu/get)`, `(commands)`, `(apropos "search")`
- Color utilities: `color/red`, `color/green`, etc.; `highlight/source` for code

All leaf cobra commands are registered as `mpu/<name>` Janet functions. Flags can be passed in two styles:

```janet
# Keyword style (idiomatic Janet — рекомендуемый)
(mpu/get :spreadsheet-id "SHEET_ID" :sheet-name "Sheet1")   # mpu get -s SHEET_ID -n Sheet1
(mpu/get :s "SHEET_ID" :n "Sheet1")                         # то же через короткие имена
(mpu/client "42" :fields "name,email")                      # mpu client 42 --fields name,email
(mpu/rsdb :scheme "public" :host "sl-1" "SELECT 1")         # mpu rsdb --scheme public --host sl-1 "SELECT 1"

# CLI style (обратная совместимость — тоже работает)
(mpu/get "-s" "SHEET_ID" "-n" "Sheet1")
(mpu/ldb "42" "SELECT 1")

# Без аргументов
(mpu/config-path)
(mpu/token)
(mpu/clients)
```

Keyword args (`:flag-name "value"`) автоматически конвертируются в CLI flags (`--flag-name value`). Однобуквенные (`:s "X"`) → `-s X`. Tab-completion подсказывает доступные `:keyword`-флаги для каждой mpu-команды.

REPL bridge functions available in Janet: `repl/commands`, `repl/flags`, `repl/doc`, `repl/janet-dir`, `repl/history-file`, `repl/history`, `repl/completion-context`.

Commands that have subcommands (e.g., `webApp`, `editors`) are not registered directly — only their leaf subcommands are.

The `repl` command does **not** update the saved last-command in `config.json`, so `mpu` (smart repeat) still repeats the command before the REPL session.

### REPL architecture: Janet logic + Go concurrency

**Принцип: логика в Janet, обвязка в Go.** Автодополнение, подсветка синтаксиса и форматирование вывода REPL реализованы преимущественно в Janet — это позволяет менять поведение без перекомпиляции, дополнять через `rc.janet`, и держать всю предметную логику в одном месте. При этом Go обеспечивает многопоточную обвязку для максимальной отзывчивости:

- **Janet владеет логикой**: `complete/candidates` возвращает массив кандидатов, `highlight/result` раскрашивает вывод по типу, `prompt/get` генерирует промпт — вся предметная логика написана на Janet.
- **Go владеет потоками**: readline работает в отдельной горутине, а Janet VM привязан к основной горутине через `runtime.LockOSThread()` (требование TLS Janet). Канальный мост (`compReq`/`compResp`) связывает горутину readline с основной — запрос на автодополнение отправляется по каналу, основная горутина вызывает Janet и возвращает результат.
- **Флаги — в Go напрямую**: дополнение флагов (`--spreadsheet-id`, `-s`, `:spreadsheet-id`) читается из cobra `FlagSet` без вызова Janet — это быстрее и не требует сериализации. Поддерживаются три стиля: `--long`, `-s`, `:keyword`.
- **Типизированный мост**: `DoEval()` возвращает `Result` с типом (`TypeNumber`, `TypeString`, `TypeArray`...), `EvalStringSlice()` получает массив из Janet как `[]string` — без промежуточной сериализации в строку и парсинга обратно.
- **Fallback**: если Janet-скрипты недоступны (нет `~/.config/mpu/janet/`), REPL продолжает работать с Go-only автодополнением mpu-команд.

При изменении логики автодополнения или подсветки — менять `janet/*.janet`, не Go-код. Go-код менять только при изменении архитектуры моста (каналы, типы, новые методы VM).

### Janet scripts

Janet REPL scripts live in `janet/` (project) and are installed to `~/.config/mpu/janet/` by `make install`:

| File | Purpose |
|------|---------|
| `highlight.janet` | Theme system (`*theme*`, `set-theme`, `paint`), `highlight/result`, `highlight/value`, `highlight/token`, `highlight/source` |
| `prelude.janet` | Result/input history vars, magic commands (`%time`, `%who`, etc.) |
| `help.janet` | `(commands)`, `(?)`, `(apropos)` — с показом keyword-флагов для каждой команды |
| `completion.janet` | `complete/candidates` → array для `EvalStringSlice`; `complete/mpu-names`, `complete/keyword-flags`, `complete/janet-symbols` |
| `prompt.janet` | Prompt generation, `(set-prompt fn)` |
| `init.janet` | Final init hook (documentation only) |
| `rc.janet` | User customization (optional, not overwritten by install) |

Override the scripts directory via `MPU_JANET_DIR` env var.

### Color theme system

Подсветка синтаксиса использует именованные семантические роли, а не хардкод ANSI-кодов. Каждая роль имеет цвет в текущей теме (`*theme*`). Встроенные темы: `theme/default` (тёмный терминал), `theme/light` (светлый). Пользовательские темы — через `rc.janet`.

| Role | Default color | Usage |
|------|--------------|-------|
| `:num` | blue | Numbers: `42`, `3.14` |
| `:str` | green | Strings: `"hello"` |
| `:kw` | magenta | Keywords: `:name` |
| `:bool` | cyan | `true`, `false`, `nil` |
| `:nil` | gray | `nil`, dim text |
| `:special` | bold cyan | Special forms: `def`, `var`, `fn`, `if`, `do` |
| `:macro` | bold yellow | Macros: `defn`, `let`, `each`, `loop`, `when`, `cond` |
| `:builtin` | yellow | Built-in functions |
| `:mpu` | orange (256) | mpu/ commands |
| `:opt` | teal (256) | Keyword options: `:spreadsheet-id` |
| `:comment` | gray | Comments: `# ...` |
| `:paren` | gray | Delimiters: `()[]{}` |
| `:fn` | gray | Function display: `<function>` |
| `:mut` | yellow | Mutable collections: `@[]`, `@{}` |
| `:buf` | green | Buffers: `@""` |
| `:err` | red | Errors |
| `:prompt` | bold cyan | Prompt accent |
| `:counter` | yellow | Prompt counter |

Функция `(paint role str)` оборачивает строку в цвет роли. `(c role)` — сырой ANSI-код. `(cr)` — reset. Все highlight-функции используют `paint`/`c` (DRY, не дублируют ANSI-коды).

Переключение: `(set-theme theme/light)`. Создание своей темы:
```janet
# rc.janet
(def my-theme (merge theme/default @{:num "\e[38;5;39m" :str "\e[38;5;34m"}))
(set-theme my-theme)
```

### Janet VM bridge (`internal/janet`)

Go wrapper exposes three levels of Janet interaction:

| Method | Returns | Use case |
|--------|---------|----------|
| `DoString(code)` | `string, error` | Simple eval, string results |
| `DoEval(code)` | `*Result, error` | Typed result with `Type`, `Num`, `Bool`, `Arr` |
| `EvalStringSlice(code)` | `[]string, error` | Janet array/tuple → Go slice directly |

`DoEval` and `EvalStringSlice` use C helpers (`janet_indexed_to_strings`, `janet_value_type`) to avoid stringifying and re-parsing — native type transfer between Janet and Go.

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
- **Janet tests** (`internal/janet/janet_test.go`): VM lifecycle, DoString, DoEval (all types), EvalStringSlice, function registration and dispatch, Janet features (fibers, PEG, os/clock)
- **REPL tests** (`cmd/repl_test.go`): script execution, error handling, `skipDefaults`, completer (mpu commands, flags, Janet symbols, edge cases), bridge functions, Janet script loading, highlight/prompt/completion/prelude scripts

## File locations

| Path | Purpose |
|------|---------|
| `~/.config/mpu/config.json` | Persisted defaults, protected flag, last command |
| `~/.config/mpu/.env` | Environment variables (credentials, URLs, ports) |
| `~/.config/mpu/db` | SQLite cache (tokens, clients, spreadsheets) |
| `~/.config/mpu/history` | REPL command history (readline) |
| `~/.config/mpu/janet/` | Janet REPL scripts (highlight, help, completion, prompt, prelude) |
| `~/.config/mpu/janet/rc.janet` | User REPL customization (optional, not overwritten) |
| `~/.local/bin/mpu` | Installed binary |

## Environment

`.env` at `~/.config/mpu/.env` (copied there by `make install`).

### Encrypted .env sync via git

`.env` содержит секреты и в `.gitignore`. Для синхронизации через git используется `.env.enc` — файл зашифрованный тройным шифром по паролю.

**Цепочка шифрования**: AES-256-CTR → ChaCha20 → Camellia-256-CTR. Каждый слой — PBKDF2 (100k итераций) с независимой солью. Единственная зависимость — `openssl` (есть на любой Linux/macOS).

```bash
make env-encrypt          # зашифровать .env → .env.enc (спрашивает подтверждение)
make env-decrypt          # расшифровать .env.enc → .env (спрашивает подтверждение)
make env-sync             # обновить .env.enc если .env изменился
make install              # если .env нет, предложит расшифровать из .env.enc
```

Все операции интерактивны — каждая спрашивает "Encrypt/Decrypt? [y/N]" и пароль. Можно пропустить ответив "n".

| Env var | Effect |
|---------|--------|
| `MPU_ENV_PASS` | Пароль (не спрашивать интерактивно) |
| `MPU_ENV_SKIP=1` | Полностью пропустить шифрование/расшифровку |
| `MPU_ENV_YES=1` | Авто-подтверждение (для CI/скриптов) |

Workflow:
1. `git clone` → `.env.enc` в репозитории, `.env` нет
2. `make install` → "Decrypt .env.enc → .env? [y/N]" → вводишь пароль → сборка
3. Редактируешь `.env` → `make env-sync` → "Encrypt? [y/N]" → обновляет `.env.enc`
4. `git add .env.enc && git commit`
5. Не хочешь шифровать → жмёшь "n" или `MPU_ENV_SKIP=1 make install`

**WebApp (required for sheets commands):**
- `WB_PLUS_WEB_APP_URL` — Google Apps Script deployment URL
- `WB_PLUS_WEB_APP_EMAIL` — authenticated user email

**sl-back API (required for client/clients/token):**
- `NEXT_PUBLIC_SERVER_URL`, `BASE_API_URL` — API base
- `TOKEN_EMAIL`, `TOKEN_PASSWORD` — login credentials

**PostgreSQL (required for ldb/rdb):**
- `PG_LOCAL_PORT`, `PG_PORT`, `PG_DB_NAME`, `PG_CLIENT_USER_PASSWORD`
- `PG_HOST` — optional, defaults to 127.0.0.1
- `PG_MY_USER_NAME`, `PG_MY_USER_PASSWORD` — remote access for rsdb / update-spreadsheets
- `PG_MAIN_USER_NAME`, `PG_MAIN_USER_PASSWORD` — local access for lsdb
- Server-name env vars (e.g., `sl_1=192.168.150.31`) — for remote host resolution in `rdb`

**Janet REPL (optional):**
- `MPU_JANET_DIR` — custom path to Janet scripts directory (default `~/.config/mpu/janet`)

### Test spreadsheet

`1eJfRwbYlkyHbtTxmWzH6nCxeIJHgbqZwPwn5tfsRRZo` — read/write access, used by all integration tests.
