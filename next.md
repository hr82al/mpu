# next.md — план продолжения

Опорный документ: текущее состояние, очередь задач, открытые развилки. Чтобы возобновить работу, начни с **«Что делать дальше»**.

---

## 1. Текущее состояние (на 2026-05-01)

**Бинари (`npm run build && npm link` → симлинки в `~/.local/bin`):**
- `new-mpu` — основной CLI (Go-`mpu` остаётся в PATH как `mpu`).
- `sheet` — алиас `new-mpu sheet`.

**Команды (sheet):**
- `sheet get` — read с per-cell {range, value, formula} (formula только у реальных формул); covering-cache; `--render values|formulas|formatted|both`; `--raw`/`--tsv`/`--json`; `-R/--refresh`; `--from <file|->`.
- `sheet set` — write через `spreadsheets/values/batchUpdate`; protected-режим (config `sheet.protected=true` default); `--force/-f`; `--literal/-l` (RAW); `--from`; cache-инвалидация через `SheetCache.invalidateUpdate`.
- `sheet ls` — список листов через `spreadsheets/get`; кэш `sheet:info:<ssId>`; `-l`/`--json`/`-R`.
- `sheet open [tab]` — браузер; `--print` для pipe.
- `sheet resolve` — диагностика резолва; `--json` с `ambiguous` секцией для ИИ.
- `sheet alias add/ls/rm` — короткие имена → ID, работают как `-s`/env/config.
- `sheet sync` — pull `/admin/ss` от sl-back в `sl_spreadsheets`; токен 10 мин в общем Cache.

**Команды (db) — новое:**
- `new-mpu db sync` — pull `/admin/client` (включая `server`-поле) → `sl_clients`. Источник правды для client→server. Без него `db query`/`db server` падают.
- `new-mpu db server <hint>` — резолвит hint в `client_id, server, ip`. Hint: full/partial ssId, client_id, IP, server name, title (exact-title fast-path → fuzzy fallback). `--ss/--client/--server/--schema` как явные перекрытия. `--json` для ИИ.
- `new-mpu db ip <name>` — `sl-1`/`sl_1`/`SL_1` → IP через env. IP идёт обратно как есть.
- `new-mpu db query <hint> [sql]` — основная команда. Резолвит target, выбирает mode и пускает SQL. SQL — позиционный или через stdin (когда не TTY). Форматы: `--json` (default — массив объектов), `--tsv`, `--csv` (RFC 4180). **PG-запросы НЕ кэшируются** (явное решение пользователя, см. memory feedback).

**db query — выбор mode:**
- *client mode* (когда есть `client_id`): user=`client_<id>`, password=`PG_CLIENT_USER_PASSWORD`. Без `SET search_path` — у роли `client_<id>` стоит дефолтный `search_path` на `schema_<id>`.
- *direct mode* (`--server` + `--schema`): user=`PG_MY_USER_NAME`, password=`PG_MY_USER_PASSWORD`, выполняется `SET search_path TO "<schema>"` до основного запроса.

**Прочее:**
- `new-mpu config` — все ключи: `cache.ttl`, `sheet.default`, `sheet.url`, `sheet.protected`, `sheet.cache.ttl`, `http.retries`, `http.timeout`.
- `new-mpu completion install [shell]` — ставит **оба bin** (`new-mpu` + `sheet`) для bash/fish/zsh.

**Архитектурные принципы (CLAUDE.md разделы 0/0a/0b/0c/1):**
- 0 — команды для ИИ и людей одновременно
- 0a — все read-команды кэшируются (исключение: `db query` — см. memory feedback)
- 0b — семантика > синтаксис: ключ присутствует ⇔ имеет смысл (например, `formula` только если реально формула)
- DRY — имена bin в `src/lib/branding.ts`
- UNIX-way и зависимости — таблица рекомендованных библиотек

**Тесты:** 268 (266 ✓ / 2 ✕ pre-existing — `sheet-open` и `sheet-resolve --json` пред-сущие падения, не связаны с db). Через `npm test`.

**Структура:**
```
src/
  bin/{mpu,sheet}.ts
  program.ts
  lib/{a1,branding,cache,completion,config,db,db-resolve,env,help,paths,
       pgclient,retry,server-resolve,sheet-aliases,sheet-cache,sl-clients,
       slapi,sl-spreadsheets,spreadsheet,webapp}.ts
  commands/{config,completion,db,help,internal-complete,sheet}.ts
tests/                # *.test.ts
```

---

## 2. Live-test playbook

```bash
# первая настройка (один раз)
cp .env ~/.config/mpu/.env                 # для дев-окружения
new-mpu config sheet.url <APPS_SCRIPT_URL> # либо WB_PLUS_WEB_APP_URL в env
new-mpu config sheet.default 1e-YcucjBPBCtrX95o3ln0DQ2qhCuhJxP7D7myiw9SqE
sheet sync                                  # ~3.5s, ~6000 spreadsheets
new-mpu db sync                              # ~4600 clients — populate sl_clients

# проверка sheet
sheet resolve --json
sheet get 'UNIT!A1:C5' --json | head
sheet ls | head

# проверка db
new-mpu db ip sl-1                                              # → IP из .env
new-mpu db server 1YCG33sFWPditVaTNOdHUaWNtW3o-kj7wsmtx76jGEvs  # client+server+ip
new-mpu db server 3377 --json                                   # JSON для ИИ
new-mpu db query 3377 "SELECT current_database(), current_schema(), current_user"
echo "SELECT now()" | new-mpu db query 1YCG33                   # SQL через stdin, prefix-резолв
new-mpu db query 3377 "SELECT 1 AS n, 'hi' AS s" --tsv           # TSV
new-mpu db query --server sl-1 --schema 42 "SELECT 1"            # direct mode
```

**Инвалидация кэша руками** (для отладки):
```bash
sqlite3 ~/.config/mpu/mpu.db 'DELETE FROM sheet_cells'
sqlite3 ~/.config/mpu/mpu.db "DELETE FROM cache WHERE key LIKE 'sheet:info:%'"
sqlite3 ~/.config/mpu/mpu.db 'DELETE FROM sl_clients'      # форсит db sync
```

**Тестовый spreadsheet:** `1e-YcucjBPBCtrX95o3ln0DQ2qhCuhJxP7D7myiw9SqE` (есть write-доступ; safe-zone — `Sheet1!Z1`).
**Тестовый db-таргет:** `1YCG33sFWPditVaTNOdHUaWNtW3o-kj7wsmtx76jGEvs` → client `3377`, server `sl-4`, schema `schema_3377`.

---

## 2a. db — шпаргалка для ИИ

**Когда использовать.** Любой запрос к PG-данным конкретного клиента: «сколько строк в orders у клиента 3377?», «какая схема у `1YCG33...`?», «на каком сервере живёт «PrintPortal | 10X WB»?». Не путать со `sheet` — это Google Sheets. `db` — это PostgreSQL.

**Резолвер `<hint>` пробует все интерпретации одновременно** (порядок описан в `lib/db-resolve.ts`):

| Тип hint                            | Пример                                        | Источник            |
|-------------------------------------|-----------------------------------------------|---------------------|
| Полный spreadsheet ID               | `1YCG33sFWPditVaTNOdHUaWNtW3o-kj7wsmtx76jGEvs` | `sl_spreadsheets`   |
| Любой фрагмент ssId (не только начало) | `1YCG33`, `FWPditVaTNOdHUaWN`              | `sl_spreadsheets`   |
| Числовой `client_id`                | `3377`                                        | `sl_clients`        |
| IP                                  | `10.0.0.1` (требует `--schema`)               | прямо               |
| Имя сервера                         | `sl-1`, `sl_1` (если 1 client → client mode)  | env + `sl_clients`  |
| Title (точный, case-insensitive)    | `"PrintPortal \| 10X WB"`                     | `sl_spreadsheets`   |
| Title fuzzy (Fuse.js)               | `"printportal"`                               | `sl_spreadsheets`   |

Если интерпретаций несколько и они дают разные `(server, schema)` — ошибка `ambiguous` с перечислением вариантов. Снимать неоднозначность через `--ss/--client/(--server + --schema)`.

**Семантика выходных JSON для ИИ (правило 0b):**
- `db server --json` → `{kind: "client", clientId, server, ip}` или `{kind: "direct", server, ip, schema}`. **`kind` всегда есть.**
- `db query` (default JSON) → массив объектов `{column: value}`. `null` ↔ NULL в БД (правило 0b: один смысл — одно представление).
- `db query --tsv/--csv` — заголовок + строки; пустые ячейки = пустая строка.

**Type quirks pg→JS** (проверено `node-postgres` v8):
- `BIGINT` / `NUMERIC` → строка (`"1"`, `"1.5"`). Дефолт node-postgres — потеря точности недопустима. ИИ не должен это интерпретировать как «число потеряно».
- `DATE` / `TIMESTAMP` / `TIMESTAMPTZ` → JS `Date` → ISO-строка в JSON (`"2026-05-01T07:26:45.036Z"`).
- `JSONB` → уже распарсенный объект (не строка).
- `BYTEA` → Buffer; в JSON выйдет как `{type:"Buffer", data:[…]}`.
- `BOOLEAN` → JS `true`/`false`.
- `NULL` → `null`.

**Типичные ошибки и что делать:**
| Сообщение                                                          | Решение                                                          |
|--------------------------------------------------------------------|------------------------------------------------------------------|
| `client X not found in local sl_clients`                           | `new-mpu db sync`                                                |
| `client X has no server in sl_clients (server=NULL)`               | На стороне sl-back клиент без server. Уточнить с владельцем БД. |
| `host for server "sl-N" not found in env`                          | Добавить `sl_N=<IP>` в `~/.config/mpu/.env`                       |
| `IP "X" requires --schema`                                         | Добавить `--schema <client_id>` или `--schema schema_<id>`       |
| `ambiguous: server "X" has N clients`                              | `--client <id>` или `--schema <id>`                              |
| `ambiguous ssId fragment "X" — multiple spreadsheets match`        | Удлинить фрагмент или дать full ssId                             |
| `ambiguous title "X" — multiple spreadsheets match`                | Использовать `--ss <id>` или более конкретный title              |
| `no SQL provided`                                                  | Передать SQL позиционно или через stdin                          |
| `PG_DB_NAME is required`                                           | Прописать в `~/.config/mpu/.env` (см. `mpu-old/CLAUDE.md` env)   |

**Безопасность.** SQL не парсится — что передал, то и выполнится. **Кэширования нет** — каждый вызов идёт в живую БД. Нет автоматического `LIMIT` — если запрос выходит большой, добавляйте `LIMIT N` сами.

**Без `db sync` — не работает.** `sl_clients` обязательна. Если `--ss`/`--client`-резолв падает с «not found in sl_clients», первое — `new-mpu db sync`.

---

## 3. Что делать дальше (в порядке приоритета)

### Приоритет A — короткие, очевидно полезные

1. **Auto-hint для smart-resolve, когда `sl_spreadsheets` пуст.** Сейчас `sheet get -s 42` без `sync` → fallback на parseSpreadsheetUrl("42") → ошибка от webapp. Добавить: если `lookupCandidates` вернул 0 и `store.count() === 0` — кинуть осмысленную ошибку «run `sheet sync` first to enable smart resolve, or pass full ID/URL». ~30 строк, тест на проверку.

2. **`sheet rm <range>`** — алиас к `sheet set <range> '' -f`. Семантика «очистить ячейку», без `-f` тоже под protected-guard. ~20 строк.

3. **`sheet ls --filter` / `--active`** — фильтр по template_name / is_active в локальном `sl_spreadsheets`. Сейчас `ls` — это листы внутри одного spreadsheet, а тут другая команда — `sheet clients` или `sheet spreadsheets ls` с фильтрами по локальному кэшу. Подумать про namespace.

### Приоритет B — средние

4. **Token `sl:token` сейчас живёт в общем `cache` без явного `cache.ttl=0` master-switch.** Проверить: при `cache.ttl=0` поведение токена — должен ли отключаться? По смыслу — нет (это auth, не кэш данных). Возможно вынести в отдельную таблицу `auth_tokens` или ключ с `ttl: Infinity` и собственной expiration логикой. См. как было в old (`token_cache` с 10-мин TTL независимым от `forceCache`).

5. **`sheet set` — чисто batch-операции через JSON.** Сейчас `--from` парсит TSV. Добавить `--from-json` для случая когда нужно писать массивы / разные типы (числа, bool). Принимать `[{range, values: [[...]]}, ...]`.

6. **Smart resolve — auto-sync при stale cache.** Если в `sl_spreadsheets` запись есть, но `synced_at` старше N (config `sl.sync.ttl`?) — авто-sync перед резолвом, с явным флагом `--no-auto-sync` для отключения.

7. **`sheet history`** — список последних операций (sheet set / mutations). SQLite-таблица `op_log`. Полезно для отладки "что я сегодня записал".

### Приоритет C — большие, требуют согласования

8. **REPL.** В CLAUDE.md помечено как открытый вопрос. Если делать — Node `repl` с pre-loaded `sheet`/`new-mpu` биндингами; не Janet (не наш стек).

9. **Реальные миграции БД.** Сейчас идемпотентный DDL. При первом `ALTER TABLE` — поставить `postgrator` или 30-строчный runner на `PRAGMA user_version` (см. CLAUDE.md раздел 1).

10. **PG/sl-back другие endpoints** — `clients`, `users`, `ssDatasets`. Зависит от того, что нужно ИИ через `new-mpu`. Скорее всего не нужно — у sheet-команды уже всё.

---

## 4. Открытые развилки (нужны решения от пользователя)

- **`sheet sync` интервал/auto.** Делать ли auto-sync при первом «холодном» smart-lookup? (см. B6)
- **Output `sheet ls` vs `sheet spreadsheets`.** `ls` — листы внутри одного spreadsheet. Как назвать команду показа всех **spreadsheets**? Варианты: `sheet spreadsheets ls`, `sheet sl ls`, `sheet list-all`. Пока пусто — есть только `sheet sync --json` который дампит всё.
- **Имя bin `sheet`.** Конфликта с системными утилитами нет, оставлено. При ренейме менять `src/lib/branding.ts` + `package.json#bin`.
- **Token TTL.** См. B4.

---

## 5. Как продолжить (рутинный шаг)

```bash
cd /home/user/mr/workspace/go/mpu
npm test                  # baseline: должно быть 217 ✓
git status                # посмотреть что не закоммичено
```

Затем выбери задачу из секции 3 (предпочтительно A1 — она самая дешёвая и реально мешает ИИ-консьюмеру) и делай TDD:
1. test red
2. implementation green
3. live smoke (см. playbook)
4. apdate этого `next.md` если новые открытые вопросы

---

## 6. Принципы (короткое резюме CLAUDE.md)

- **TDD обязателен.** Тест → код → рефакторинг.
- **Не изобретать.** Перед рукописным runner-ом / парсером — глянуть таблицу UNIX-way библиотек в CLAUDE.md.
- **Команда = ИИ + человек.** JSON output для AI, human для шелла, errors с подсказками что попробовать.
- **Кэшировать всё что читается.** `cache.wrapAsync(key, fn)` или специализированный кэш.
- **Семантика ключей строгая.** Ключ присутствует ⇔ имеет смысл. Не дублировать значения в формулу-эквивалент.
- **Никаких лишних слоёв.** Бэкфикс не тянет рефакторинг. KIS.
