# CLAUDE.md

Этот файл — инструкции для Claude Code при работе в `mp/mpu/py/` (Python-дерево `mpu`).

Корневой CLAUDE.md монорепо (`../../CLAUDE.md`) применяется как есть: token economy для CLAUDE.md, sandbox-правила, четыре принципа (думать до кода / минимум кода / хирургические правки / цели вместо процесса), language policy, MR-workflow. `../CLAUDE.md` (`mpu/CLAUDE.md`) — overview дерева `mpu` целиком (py/ + go/) и правило коммита прямо в main.

Здесь — только то, что специфично для Python-реализации `mpu`.

## Контекст проекта

`mpu` (от monorepo python utilities) — multi-purpose CLI на Python для вспомогательных операций над данными монорепо: data-fix скрипты, единичные миграции данных, интеграции, ad-hoc аналитика, поддержка ручных операций. Архитектурно: один bin с subcommands, каждая subcommand — самостоятельный модуль.

**Скоуп — что сюда:**
- одноразовые утилиты, которые не должны жить в production-кодовой базе sl-back / sw-back;
- утилиты, которые удобнее иметь как CLI с автодополнением и общей конфигурацией, а не как разрозненный bash/SQL.

**Что НЕ сюда:**
- production-сервисы, реактивные джобы, листенеры — это домен sl-back / sw-back;
- код, который вызывается из sl-back / sw-back при обработке запросов клиентов.

Отдельный `.git` — `mpu` версионируется независимо, как `sl-back` / `sw-back` / `sw-front`. Ветки/MR не создавать, работать прямо в `main` (как и `mp`; см. корневой Git & MR workflow).

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
| Модели JSON-границ | **pydantic** v2 — ТОЛЬКО в `lib/<x>_models.py`, импортируемых ЛЕНИВО из тел функций (cli.py жадно грузит все команды; импорт pydantic ~150 мс → top-level импорт в commands/lib запрещён, проверка: `python -X importtime -c "from mpu import cli" \| grep pydantic` пусто) |
| Fuzzy search | **rapidfuzz** (если понадобится) |

Распространение — `uv tool install --from .` + симлинк в `~/.local/bin/`. **Версия в `pyproject.toml` та же → uv отдаёт wheel из кэша, и новые модули в установленный бинарь не попадают** (симптом: `No such command '<новая>'` при зелёных тестах; ни `--force`, ни `--reinstall` сами по себе не помогают). Переустановка после правки кода:

```sh
uv cache clean mpu && uv tool install --from . mpu --force --reinstall
```

Не добавлять зависимости, которых нет в этом списке, без согласования с пользователем (см. `dependencies-unix-way` в монорепозиториях соседей — заводить аналог skill, если эта тема понадобится регулярно).

## Архитектура bin'ов

Один бинарь — `mpu` (`[project.scripts]` → `mpu.entry:main`; `entry.py` оборачивает вызов логом и
уже внутри него импортирует `mpu.cli`). Подкоманды диспатчатся внутри в два namespace'а:

- `mpu <X>` — по умолчанию ВЫПОЛНЯЕТ inner-команду (через Portainer для node-CLI обёрток; нативно для local-команд). Флаг `--print` / `-p` возвращает в print + clipboard режим. `--local` (вместе с `--print`) переключает на `sl-N-cli sh -c "..."` форму.
- `mpu api <X>` — HTTP-клиенты sl-back (бывший `mpuapi-X`)

Source of truth: `src/mpu/cli_registry.COMMANDS` (root) + `src/mpu/commands/_mpuapi_spec.COMMANDS` (api). Mount происходит в `cli.py` через `_mount(parent, registry)` и `build_api_group()`.

Регистрация новой команды:
- root subcommand: модуль в `src/mpu/commands/<name>.py` — `COMMAND_NAME` / `COMMAND_SUMMARY` константы, `app = typer.Typer(...)`. Для node-CLI обёрток принять параметры `--print` / `--local` и вычислить wrapper через `pick_wrapper(print_mode=..., local=...)` из `mpu.lib.cli_wrap`. Добавить kebab-имя в `COMMANDS` в `cli_registry.py`. Добавить модуль в `_REGISTERED_MODULES` в `commands/help.py` (откуда `mpu help` собирает список).
- api subcommand: добавить `CommandSpec` в `_mpuapi_spec.COMMANDS`.

## Структура

```
pyproject.toml              # uv-managed, зависимости, [project.scripts] → mpu = mpu.entry:main
uv.lock
src/mpu/
  __init__.py               # __version__
  __main__.py               # `python -m mpu` → entry.main()
  entry.py                  # обёртка лога вызовов вокруг всего процесса (см. lib/log.py)
  cli.py                    # root Typer app + api click.Group bridge
  cli_registry.py           # COMMANDS (kebab → module)
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
    cli_opts.py             # каталог переиспользуемых typer-опций (принцип 8.2)
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

7. **Read/write split.** Команда, мутирующая удалённое состояние, обязана иметь enforced read-only вариант (read → `permissions.allow`, write → `permissions.ask`); `run-js`/`ssh` — исключения (только подтверждение, RO-версии нет). Образец — `mpu sql` → `mpu sql-ro`. Подробности — skill `conv-mpu-readonly-split`.

8. **Читаемость и качество — приоритет над краткостью и скоростью.** Ясность и сопровождаемость важнее «покороче» / «поскорее». Дополняет корневой принцип «минимум кода» (тот — против спекулятивных фич; этот — против жертвы ясностью ради краткости), не противоречит ему.
   - Если ради читаемости уместна абстракция — её **заводить**, а не обходить вручную: своя shared-утилита / класс / модель по разделу «Как начинать работу» (`commands/_<name>.py` для группы команд, `lib/<name>.py` для утилиты уровня lib), с типами по принципу 5.
   - **Внешняя** зависимость ради этого — только с согласованием с пользователем до добавления (Стек зафиксирован, см. таблицу и «Как начинать работу»). Правило: свои абстракции — заводим, внешние зависимости — предлагаем.

   Проверяемые правила (общие слова про «говорящие имена» не работают — работают пороги и адреса):

   - **8.1 Бюджеты.** Тело команды ≤ 40 строк, функция ≤ 60, модуль ≤ 400, вложенность ≤ 4. Превысил — расслоить. `# noqa` на `C901` / `PLR0912` / `PLR0915` / `PLR0913` в новом коде не ставить: это сигнал декомпозиции, а не шум линтера. Аннотации опций в бюджет тела не входят, но см. 8.2.
   - **8.2 Опции — из каталога `lib/cli_opts.py`.** Повторяющиеся `--server` / `--print` / `--local` / `--client-id` / `--json` / `--dry-run` и селектор-аргумент берутся готовым `Annotated`-алиасом. Заново объявлять — только для опции, которой в каталоге нет; стала второй по счёту — перенести в каталог.
   - **8.3 Второй копии не бывает.** Понадобилось скопировать функцию или блок в соседний модуль — вместо копии общая точка (`commands/_<name>.py` / `lib/<name>.py`). Копии расходятся молча: в репо уже есть пара, где одинаковый резолв различается границей `N > 0` / `N >= 0` (`pssh.py:99` vs `run_js.py:176`), и четыре копии A1-кавычек, ни одна из которых не экранирует апостроф, — хотя корректный вариант лежит рядом (`sheet_batch.py:1299`).
   - **8.4 Команда = `plan → render → apply`.** Чистое планирование (без сети и БД) → один форматтер → выполнение. `--dry-run` — это «не вызвать `apply`», а не вторая ветка со своей печатью. Образец: `commands/kiten/timelog.py` (секция чистых хелперов).
   - **8.5 Канон вместо самопала.** Ошибки — `lib/cli_err` (`fail` / `die`), JSON — `lib/cli_out.print_json`, резолв селектора — `lib/resolver`, env — `lib/env`, таблицы — общий рендерер. Свой `_fail`, прямой `json.dumps`, ручной `ljust`-принтер, локальный `except ResolveError → echo → Exit` — не заводить; нужного варианта нет в `lib/` — добавить туда.
   - **8.6 Именованные структуры.** `dict` с фиксированным набором ключей, кортеж длиннее двух, чтение результата SQL как `row[0]`/`row[3]` → `@dataclass(frozen=True)` или `NamedTuple`. Поток данных должен читаться по сигнатурам, а не по индексам; передавать состояние атрибутом, навешенным на чужой объект, — нельзя.
   - **8.7 Приватное соседа не импортировать.** `_foo` из другого модуля (тем более с `pyright: ignore[reportPrivateUsage]`) — признак недостающей публичной точки: сделать функцию публичной там, где ей место.
   - **8.8 Тесты — такой же код.** Общие двойники и spy — в `tests/conftest.py` (образцы: `tests/pg_fakes.py`), а не копией в каждом файле; разбиение тестовых файлов повторяет разбиение модулей; фикстуру не типизировать как `object` ради краткости.

   Разбор текущего состояния, адреса всех известных нарушений и очередь работ — `docs/readability.md`. Перед правкой области — свериться с ним; исправил пункт — вычеркнуть там же.

## Gate перед сдачей

Прежде чем сказать «готово», прогнать локально:

```sh
uv run ruff check . && uv run ruff format --check . && uv run pyright && uv run pytest
```

Любой красный шаг → не готово, чинить, не сдавать.

**Покрытие — ratchet-порог.** Coverage не в `addopts` (замедляет обычный прогон) — мерить отдельной командой; порог `--cov-fail-under` держит планку и не даёт деградировать:

```sh
uv run pytest --cov=mpu --cov-report=term-missing --cov-fail-under=95
```

Падает ниже 95% → дописать тесты на затронутый код, не снижать порог. Поднялось ощутимо выше — поднять порог (только вверх). Конфиг — `[tool.coverage.*]` в `pyproject.toml` (branch-coverage включён).

Дополнительно для CLI-команд: запустить команду из установленного bin'а хотя бы один раз с реальными аргументами, показать вывод. typecheck+тесты ≠ работающая фича. Перед этим переустановить bin с очисткой кэша (см. «Стек») — иначе проверяется старая сборка.

**Новый файл — сразу `git add`.** Весь gate (pytest / pyright / ruff / прогон команды) резолвит импорты из рабочего дерева и поэтому СЛЕП к забытому `git add`: untracked-модуль физически есть на диске, всё зелено, а в коммит он не попадает — и на чужой машине `mpu` падает целиком (`cli.py` монтирует все команды жадно, `ModuleNotFoundError` убивает даже `--help`). Проверка, если менялся состав файлов:

```sh
git status --short | grep '^??'                     # пусто, либо add
git diff HEAD > /tmp/p.diff && git clone -q . /tmp/x && cd /tmp/x && git apply /tmp/p.diff \
  && uv run python -m mpu --help && uv run pytest -q
```

**Читаемость — тоже ratchet.** Пороги 8.1 строже настроек `pyproject.toml` (там они ослаблены под существующий хвост), поэтому меряются отдельно и в затронутых файлах должны только убывать:

```sh
uv run ruff check --preview --select PLR1702 --config 'lint.pylint.max-nested-blocks=4' src
uv run ruff check --select C901 --config 'lint.mccabe.max-complexity=10' src
grep -rn 'err=True\|json.dumps\|# noqa' src | wc -l
```

Числа выросли из-за твоей правки → расслоить, а не подавить. Полный набор счётчиков с текущими значениями — `docs/readability.md` §12.

## Самопроверка перед сдачей

Перед «готово» сам себе ответить:
1. Что сломается, если этот код вызвать с пустым входом / `None` / очень большим входом?
2. Что сломается, если внешний сервис ответит 500 / таймаутом / мусором?
3. Если вызвать команду дважды подряд — поведение идемпотентно или ломается?
4. Если кэш холодный vs тёплый — оба пути протестированы?

Если на любой вопрос ответ «не знаю» — добавить тест или починить.

## Как начинать работу

1. Понять задачу. `mpu` самодостаточен: внешних бинарей-предшественников больше нет, весь код здесь.
2. Перед новой зависимостью / новым файлом в корне / новой схемой БД / новой командой / именами флагов — **спросить пользователя до создания**.
3. Внутри согласованной структуры — действовать самостоятельно:
   - новая команда → см. «Регистрация новой команды» (раздел «Архитектура bin'ов»)
   - shared логика для группы команд → `commands/_<name>.py` (см. `_backup_unit_proto.py`)
   - shared утилита уровня lib (резолв, БД, env) → `lib/<name>.py`
   - тесты — рядом с модулем в `tests/test_<module>.py`

## Сейчас в репо

Источник истины по командам — `cli_registry.COMMANDS` + `mpu help` / `<cmd> --help` (root и `p`-обёртки: `PRINT_COMMANDS`/`PORTAINER_COMMANDS`); по api — `mpu api --help` / `_mpuapi_spec.COMMANDS`. Доменные детали команды — в её `--help` и в соответствующем `tool-*`/`conv-*` скиле; здесь только тонкий индекс `команда → модуль`.

| subcommand | модуль | назначение (детали — `--help` / skill) |
| ---------- | ------ | ---------- |
| `version` / `init` / `update` | `cli.py` / `update.py` | версия / bootstrap SQLite+discovery / синк локального кэша с PG |
| `mp-init` | `mp_init.py` | поднять локальный dev-стек (mp-config-local + `mp/local-stack`); ловушка: sl-0/sl-1 с `OBSERVABILITY_ENABLED=false` (иначе otel-preload роняет флот без otel-пакетов); core-образы не собирает; `--dry-run`; ENV `MPU_MP_CONFIG_LOCAL` |
| `search` | `search.py` | поиск клиента/spreadsheet; email→client_id (10X impersonation) — skill `tool-mpu-search-email` |
| `sql` / `sql-ro` | `sql.py` / `sql_ro.py` | ad-hoc SQL по селектору (write c подтверждением / enforced read-only) — skill `conv-mpu-readonly-split` |
| `config` | `config.py` | ключи в таблице `config` (`sheet.default`, `xlsx.default`, `sheet.cache.*`): показать/задать/`--unset`, с источником значения (env/config/default) |
| `sheet` / `xlsx` | `sheet.py` / `xlsx.py` | Google Sheets / локальные `.xlsx` (собственный OOXML-ридер на stdlib, `lib/xlsx_reader.py`) — skill `tool-mpu-sheet-xlsx` |
| `backup-{wb,ozon}-unit-proto`, `backup-wb-unit-manual-data` | `backup_*.py` | CTAS-бэкап `*_proto` / `wb_unit_manual_data` в `backups`-схему |
| `telegram` | `telegram.py` | Telegram от лица пользователя — skill `tool-mpu-telegram`. Ловушка: прокси только через `TELEGRAM_PROXY`, НЕ `HTTPS_PROXY` (утечёт на весь `mpu`) |
| `mr` | `mr.py` | GitLab MR ревью — skill `tool-mpu-mr`; ENV `GLAB_TOKEN` |
| `glab-status` | `glab_status.py` | GitLab MR одной таблицей (колонки-ветки `trunk/main/dev/qa/predprod/prod`, `✅`=merge долетел): без аргументов — мои MR за `--since`, с адресами MR (URL / `group/repo!iid` / `iid`) — ровно эти MR любых авторов (шапка + «прочие ветки», `--branches`); `--repos`/`--json`; ENV `GLAB_TOKEN`/`GITLAB_BASE_URL` |
| `kiten` | `kiten/` | Kaiten-карточки (`status`/`card`/`ls`/`comment`/`move`/`ready`/`review`/`close`/`field`/`time`/справочник) — skill `tool-mpu-kiten`. `status` — вся моя работа матрицей по всем доскам (назначенное + где списывал время + где что-то делал); ENV `KITEN_STAGE_MAP` |
| `log` | `log.py` | журнал вызовов самого `mpu` (`~/.config/mpu/mpu.log`): команда, вывод, ошибки, exit; фильтры `--failed`/`--cmd`/`--since`/`--run`. Пишет `lib/log.py` + `lib/capture.py`; ENV `MPU_LOG_*` (см. `.env.example`) |
| `help` | `help.py` | список команд + проброс `--help` |
| (node-CLI обёртка) | `commands/<X>.py` | exec через Portainer; `--print`/`-p` — print+clipboard |
| `api <X>` | `_mpuapi_*.py` | HTTP-клиенты sl-back endpoints (~97; список — `mpu api --help`) |
