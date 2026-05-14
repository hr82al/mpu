# CLAUDE.md

Этот файл — инструкции для Claude Code при работе в `mp/mpu/`.

Корневой CLAUDE.md монорепо (`../CLAUDE.md`) применяется как есть: token economy для CLAUDE.md, sandbox-правила, четыре принципа (думать до кода / минимум кода / хирургические правки / цели вместо процесса), language policy, MR-workflow.

Здесь — только то, что специфично для `mpu/`.

## Контекст проекта

`mpu` (от monorepo python utilities) — multi-purpose CLI на Python для вспомогательных операций над данными монорепо: data-fix скрипты, единичные миграции данных, интеграции, ad-hoc аналитика, поддержка ручных операций. Архитектурно — по образцу `new-mpu` (`~/mr/workspace/go/mpu/`): один bin с subcommands, каждая subcommand — самостоятельный модуль.

**Скоуп — что сюда:**
- одноразовые утилиты, которые не должны жить в production-кодовой базе sl-back / sw-back;
- утилиты, которые удобнее иметь как CLI с автодополнением и общей конфигурацией, а не как разрозненный bash/SQL.

**Что НЕ сюда:**
- production-сервисы, реактивные джобы, листенеры — это домен sl-back / sw-back;
- код, который вызывается из sl-back / sw-back при обработке запросов клиентов.

Отдельный `.git` — `mpu` версионируется независимо, как `sl-back` / `sw-back` / `sw-front`.

## Стек (зафиксирован)

| Слой | Выбор |
| ---- | ----- |
| Runtime | Python 3.12+ |
| Менеджер пакетов / venv | **uv** (lockfile `uv.lock`, скрипты, `uv tool install`) |
| CLI framework | **typer** (на Click под капотом) |
| Тесты | **pytest** |
| Линт + формат | **ruff** (lint и format в одном тулзе) |
| Типы | **pyright** strict |
| SQLite | `sqlite3` (stdlib) для конфига и кэша |
| HTTP | **httpx** (sync) |
| PostgreSQL | **psycopg[binary]** v3, sync режим |
| Fuzzy search | **rapidfuzz** (если понадобится) |

Распространение — `uv tool install --from .` + симлинк в `~/.local/bin/`.

Не добавлять зависимости, которых нет в этом списке, без согласования с пользователем (см. `dependencies-unix-way` в монорепозиториях соседей — заводить аналог skill, если эта тема понадобится регулярно).

## Архитектура bin'ов

Один бинарь — `mpu` (`[project.scripts]` → `mpu.cli:main`). Подкоманды диспатчатся внутри в три namespace'а:

- `mpu <X>` — print + clipboard для ssh+docker обёртки (бывший `mpu-X`)
- `mpu p <X>` — exec через Portainer (бывший `mpup-X`); `--print` на p-callback возвращает в print-mode
- `mpu api <X>` — HTTP-клиенты sl-back (бывший `mpuapi-X`)

Source of truth: `src/mpu/cli_registry.py` (root и `p`) + `src/mpu/commands/_mpuapi_spec.COMMANDS` (api). Mount происходит в `cli.py` через `_mount(parent, registry)` и `build_api_group()`.

Регистрация новой команды:
- print/portainer subcommand: модуль в `src/mpu/commands/<name>.py` — `COMMAND_NAME` / `COMMAND_SUMMARY` константы, `app = typer.Typer(...)`. Добавить kebab-имя в `PRINT_COMMANDS` и/или `PORTAINER_COMMANDS` в `cli_registry.py`. Добавить модуль в `_REGISTERED_MODULES` в `commands/help.py` (откуда `mpu help` собирает список).
- api subcommand: добавить `CommandSpec` в `_mpuapi_spec.COMMANDS`.

## Структура

```
pyproject.toml              # uv-managed, зависимости, [project.scripts] → mpu = mpu.cli:main
uv.lock
src/mpu/
  __init__.py               # __version__
  __main__.py               # `python -m mpu` → cli.main()
  cli.py                    # root Typer app + p-subgroup + api click.Group bridge
  cli_registry.py           # PRINT_COMMANDS / PORTAINER_COMMANDS (kebab → module)
  commands/
    __init__.py
    <name>.py               # одна subcommand — один файл (typer.Typer app)
    _<shared>.py            # private helper для группы команд (напр. _backup_unit_proto.py)
    _mpuapi_spec.py         # COMMANDS — спека всех `mpu api <X>` endpoint'ов
    _mpuapi_runtime.py      # build_api_group() — click.Group для `mpu api`
  lib/
    __init__.py
    servers.py              # резолв sl-N → server_number → IP из ~/.config/mpu/.env
    store.py                # SQLite-кэш ~/.config/mpu/mpu.db (sl_clients, sl_spreadsheets)
    pg.py                   # psycopg-коннект к PG-серверам (main = sl-0, инстансы sl-N)
    sql_runner.py           # выполнение SQL на удалённом PG, форматирование вывода
    backup_sql.py           # SQL-шаблон CTAS-бэкапа unit_proto в backups-схему
    resolver.py             # селектор → server_number (через store + servers)
tests/                      # test_<module>.py, выровнены по модулям src/mpu/
```

Локальных CLAUDE.md в подкаталогах пока нет — заводить, когда конвенции области устаканятся и потребуют отдельного места.

## Принципы (специфичные для CLI-утилит)

Поверх корневых четырёх принципов монорепо.

1. **Команды — для нейросетей и людей одновременно.**
   - Имена команд / флагов / ключей конфига — самодокументирующиеся (`--spreadsheet`, не `--ss-id`).
   - `--help` команды — полный, со всеми примерами (typer docstring + `help=` на каждом аргументе/опции).
   - Ошибки — машинно-читаемые: `<действие>: <причина> [контекст]; попробуй: <подсказка>`. Никаких `unknown error`.
   - Дефолтный вывод — структурный (JSON) для AI/pipe; флаги `--tsv`/`--csv`/`--raw` — для людей.

2. **Семантика > синтаксис вывода.**
   - Ключ присутствует ⇔ значение имеет смысл. Не выставлять «синтаксический шум» (пустую строку, дефолт, формула-эквивалент значения). ИИ читает буквально: `formula: "5"` → «формула равна 5», даже если на деле формулы нет.
   - Унифицированные пустоты: везде `None` (в JSON — `null`); в TSV — пустая ячейка. Не смешивать `None` / `""` / отсутствующий ключ для одного семантического состояния.
   - Tabular-вывод (TSV/CSV) — ровный по колонкам: пустая ячейка, не выкинутая колонка.

3. **Read-команды против внешних систем кэшируются.** Когда такой кэш заводится — отдельный модуль в `lib/`, master-switch на отключение, имя ключа в форме `<область>:<идентификатор>[:<вариант>]`, payload в ключе не вкладываем. На сейчас единственная закэшированная read-команда — `mpu search` против локального SQLite-снапшота из `mpu update`.

4. **PG-запросы (ad-hoc SQL) — без кэша.** SELECT'ы против клиентских БД должны видеть свежие данные.

5. **Строгая типизация.**
   - `pyright strict` обязателен. `Any`, `cast` без обоснования в комменте, `# type: ignore` без указания причины — запрещены.
   - Внешние границы (JSON-ответы API, sqlite rows, env, пользовательский ввод) типизировать через `pydantic` модель или явный type-guard, не через cast.

6. **Никаких magic env без документации.** Любая env-переменная, которую читает код, упомянута в `--help` команды или в общем help.

## Gate перед сдачей

Прежде чем сказать «готово», прогнать локально:

```sh
uv run ruff check . && uv run ruff format --check . && uv run pyright && uv run pytest
```

Любой красный шаг → не готово, чинить, не сдавать.

Дополнительно для CLI-команд: запустить команду из установленного bin'а хотя бы один раз с реальными аргументами, показать вывод. typecheck+тесты ≠ работающая фича.

## Самопроверка перед сдачей

Перед «готово» сам себе ответить:
1. Что сломается, если этот код вызвать с пустым входом / `None` / очень большим входом?
2. Что сломается, если внешний сервис ответит 500 / таймаутом / мусором?
3. Если вызвать команду дважды подряд — поведение идемпотентно или ломается?
4. Если кэш холодный vs тёплый — оба пути протестированы?

Если на любой вопрос ответ «не знаю» — добавить тест или починить.

## Как начинать работу

1. Понять задачу. Если она ссылается на уже существующее поведение в `new-mpu` (`~/mr/workspace/go/mpu/`) — прочитать соответствующий код TS-версии для контекста и **подтвердить с пользователем**, нужно ли такое же поведение, или другое.
2. Перед новой зависимостью / новым файлом в корне / новой схемой БД / новой командой / именами флагов — **спросить пользователя до создания**.
3. Внутри согласованной структуры — действовать самостоятельно:
   - новая команда → `src/mpu/commands/<name>.py` с `COMMAND_NAME` / `COMMAND_SUMMARY` константами и `app = typer.Typer(...)`; зарегистрировать kebab-имя в `cli_registry.py` (в `PRINT_COMMANDS` и/или `PORTAINER_COMMANDS`) и добавить модуль в `_REGISTERED_MODULES` `commands/help.py`
   - shared логика для группы команд → `commands/_<name>.py` (см. `_backup_unit_proto.py`)
   - shared утилита уровня lib (резолв, БД, env) → `lib/<name>.py`
   - тесты — рядом с модулем в `tests/test_<module>.py`

## Сейчас в репо

| subcommand | модуль | назначение |
| ---------- | ------ | ---------- |
| `mpu version` | `cli.py` | версия пакета |
| `mpu init` | `cli.py` | bootstrap SQLite + Portainer/Loki discovery |
| `mpu search` | `commands/search.py` | поиск клиента / spreadsheet в локальном SQLite-кэше |
| `mpu update` | `commands/update.py` | синк `~/.config/mpu/mpu.db` со всех PG-серверов |
| `mpu sql` | `commands/sql.py` | выполнить SQL на удалённом PG по селектору |
| `mpu backup-wb-unit-proto` | `commands/backup_wb_unit_proto.py` | CTAS-бэкап `wb_unit_proto` в `backups`-схему |
| `mpu backup-ozon-unit-proto` | `commands/backup_ozon_unit_proto.py` | CTAS-бэкап `ozon_unit_proto` в `backups`-схему |
| `mpu backup-wb-unit-manual-data` | `commands/backup_wb_unit_manual_data.py` | CTAS-бэкап `wb_unit_manual_data` в `backups`-схему |
| `mpu help` | `commands/help.py` | список команд + проброс `--help` каждой |
| `mpu p <X>` | `commands/<X>.py` | exec через Portainer (`mpu p --print <X>` — print-mode) |
| `mpu api <X>` | `commands/_mpuapi_*.py` | HTTP-клиенты для sl-back endpoints (~86 шт) |

Полный список subcommand'ов root и `p`: см. `PRINT_COMMANDS` и `PORTAINER_COMMANDS` в `cli_registry.py`. Полный список api: `mpu api --help` или `COMMANDS` в `commands/_mpuapi_spec.py`.

## Язык

Документация и общение — русский. Идентификаторы, имена команд, имена флагов — английский. (Совпадает с конвенциями монорепо.)
