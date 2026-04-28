# next.md — план продолжения

Опорный документ: текущее состояние, очередь задач, открытые развилки. Чтобы возобновить работу, начни с **«Что делать дальше»**.

---

## 1. Текущее состояние (на 2026-04-27)

**Бинари (`npm run build && npm link`):**
- `new-mpu` — основной CLI (Go-`mpu` остаётся в PATH).
- `sheet` — алиас `new-mpu sheet`.

**Команды:**
- `sheet get` — read с per-cell {range, value, formula} (formula только у реальных формул); covering-cache; `--render values|formulas|formatted|both`; `--raw`/`--tsv`/`--json`; `-R/--refresh`; `--from <file|->`.
- `sheet set` — write через `spreadsheets/values/batchUpdate`; protected-режим (config `sheet.protected=true` default); `--force/-f`; `--literal/-l` (RAW); `--from`; cache-инвалидация через `SheetCache.invalidateUpdate`.
- `sheet ls` — список листов через `spreadsheets/get`; кэш `sheet:info:<ssId>`; `-l`/`--json`/`-R`.
- `sheet open [tab]` — браузер; `--print` для pipe.
- `sheet resolve` — диагностика резолва; `--json` с `ambiguous` секцией для ИИ.
- `sheet alias add/ls/rm` — короткие имена → ID, работают как `-s`/env/config.
- `sheet sync` — pull `/admin/ss` от sl-back в `sl_spreadsheets`; токен 10 мин в общем Cache.
- `new-mpu config` — все ключи: `cache.ttl`, `sheet.default`, `sheet.url`, `sheet.protected`, `sheet.cache.ttl`, `http.retries`, `http.timeout`.
- `new-mpu completion install [shell]` — ставит **оба bin** (`new-mpu` + `sheet`) для bash/fish/zsh.

**Архитектурные принципы (CLAUDE.md разделы 0/0a/0b/0c/1):**
- 0 — команды для ИИ и людей одновременно
- 0a — все read-команды кэшируются
- 0b — семантика > синтаксис: ключ присутствует ⇔ имеет смысл (например, `formula` только если реально формула)
- DRY — имена bin в `src/lib/branding.ts`
- UNIX-way и зависимости — таблица рекомендованных библиотек

**Тесты:** 217 ✓ через `npm test`.

**Структура:**
```
src/
  bin/{mpu,sheet}.ts
  program.ts
  lib/{a1,branding,cache,completion,config,db,env,help,paths,retry,
       sheet-aliases,sheet-cache,slapi,sl-spreadsheets,spreadsheet,webapp}.ts
  commands/{config,completion,help,internal-complete,sheet}.ts
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

# проверка
sheet resolve --json
sheet get 'UNIT!A1:C5' --json | head
sheet ls | head
```

**Инвалидация кэша руками** (для отладки):
```bash
sqlite3 ~/.config/mpu/mpu.db 'DELETE FROM sheet_cells'
sqlite3 ~/.config/mpu/mpu.db "DELETE FROM cache WHERE key LIKE 'sheet:info:%'"
```

**Тестовый spreadsheet:** `1e-YcucjBPBCtrX95o3ln0DQ2qhCuhJxP7D7myiw9SqE` (есть write-доступ; safe-zone — `Sheet1!Z1`).

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
