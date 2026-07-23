# Читаемость кода mpu — разбор и план

Документ-разбор: где именно код читается плохо, почему и что с этим делать. Правила, следующие
из разбора, живут в `CLAUDE.md` (принцип 8 «Читаемость»); здесь — доказательная база и очередь работ.

Замеры — срез `main` от 2026-07-23 (`src` = 32 121 строка, `tests` ≈ 40 000). Числа воспроизводимы
командами из раздела «Как мерить». Каждая находка ниже проверена по коду: место открыто, код сверен
с описанием; две находки при проверке отклонены и вынесены в §10 отдельно.

Сделанное помечается **✅** прямо в тексте находки — так видно, что осталось. Шаги 1–3 очереди (§11)
выполнены 2026-07-23: −178 и −287 строк нетто, тесты 3046 зелёные, покрытие 95,3%, справка всех
164 команд побайтно не изменилась.

---

## 0. Главный вывод

Код mpu не «многословен из-за Python» — он **неоднороден**: один класс задач решён в репозитории
и образцово, и вручную, с разницей в объёме в 10–50 раз.

```python
# src/mpu/commands/save_wb_expenses.py — 13 строк, всё понятно сразу
app = make_app(service="wbUnitCalculatedData", method="saveExpenses",
               command_name=COMMAND_NAME, include_nm_ids=True)
```

против `src/mpu/commands/process.py` — 406 строк ручной сборки той же сути.

| Стиль | Модулей | Размер модуля |
| ----- | ------- | ------------- |
| Декларативный (`make_app` / `lib/factories/*`) | 16 | 8–33 строки |
| Ручная сборка (`emit_node_cli` напрямую) | 14 | 63–406 строк |

Отсюда стратегия: не «переписать всё красиво», а **дотянуть отставшие места до уже принятого
в репозитории образца** и закрепить образец правилом, чтобы разрыв не открывался снова.

Второй сквозной мотив — **копия вместо общей точки**. Почти все находки ниже это один сценарий:
код решает задачу, соседний модуль решает её же, копию никто не связал, и дальше копии расходятся
(в одном случае — до разного поведения, см. §5.1 и §6.1).

---

## 1. Сигнатурный шум: тело команды тонет в декларациях опций

**Факты.** 4 254 строки `src` (13,2%) — аннотации параметров:

| Модуль | Строк аннотаций / всего | Доля |
| ------ | ----------------------- | ---- |
| `commands/_ssh_node_cli.py` | 101 / 218 | 46% |
| `commands/process.py` | 166 / 406 | 41% |
| `commands/recalculate_ozon_expenses.py` | 89 / 264 | 34% |
| `commands/logs.py` | 83 / 253 | 33% |
| `commands/kiten/move.py` | 108 / 413 | 26% |

`process.py:154 main` — 253 строки, 25 параметров: до первой строки логики читатель пролистывает
160 строк `Annotated[...]`.

**Повторы.** Всего 400 объявлений `typer.Option`; самые частые описывают одно и то же:
`--json` × 27, `--server` × 22, `--print` × 21, `--local` × 19, `--client-id` × 18, `--dry-run` × 16.
Help-строка селектора `"client_id, spreadsheet_id substring, или title substring"` скопирована 16 раз —
и уже начала расходиться между командами.

**✅ Сделано.** Каталог типов-опций `lib/cli_opts.py`:

```python
SelectorArg = Annotated[str, typer.Argument(help="client_id, spreadsheet_id substring, или title substring")]
ServerOpt   = Annotated[str | None, typer.Option("--server", help="Override резолва: sl-N")]
PrintOpt    = Annotated[bool, typer.Option("--print", "-p", help="Печатать обёртку в stdout + clipboard, не выполнять")]
ClientIdOpt = Annotated[int | None, typer.Option("--client-id", "--client_id", help="Override client_id если selector неоднозначен")]
```

Приём в проекте уже был признан — `commands/mr.py:108` (`MrRefOption`, `MessageOption`,
`BodyFileOption`), просто применялся в одном модуле.

Итог: **120 объявлений** заменены алиасами в 31 файле: −469 строк деклараций против +244 (из них 60 — сам новый каталог), нетто −225. Из них 90 кросс-модульных
(`SelectorArg` ×16, `ServerOpt` ×19, `LocalOpt` ×17, `PrintOpt` ×17, `ClientIdOpt` ×16,
`SpreadsheetIdOpt` ×5) — в `lib/cli_opts.py`; 25 kaiten-специфичных (`CardArg` ×15,
`CardArgOpt` ×2, `JsonOpt` ×8) — в `commands/kiten/_common.py`; 5 `-s/--spreadsheet` — локальным
алиасом в `commands/sheet.py`. Сигнатура `process.main` — со 160 строк деклараций до 26.

Показательный итог по одной строке: help карточки Kaiten («ID карточки или URL btlz.kaiten.ru…»)
имел **10** независимых источников (9 литералов + локальная константа `_SELECTOR_HELP`
в `timelog.py`) — теперь один, `_CARD_HELP` в `commands/kiten/_common.py`.

Заменялись только байт-в-байт идентичные объявления, поэтому справка всех 164 команд не изменилась
(проверено diff'ом `--help` против версии до правки). Разошедшиеся варианты не трогали — они остались
как остаток работы:

- `--json` — 11 разных формулировок на 26 объявлений (`JSON-вывод вместо таблицы`,
  `JSON (машинный)`, `Structured JSON array.`, …);
- `--dry-run` — 13 формулировок на 16 объявлений;
- `--date-from` / `--date-to` — по 6 формулировок;
- `-s/--spreadsheet` в `commands/sheet.py` — у пяти подкоманд вообще **нет** `help`, что
  противоречит принципу 1 CLAUDE.md («`help=` на каждом аргументе/опции»);
- селектор-аргумент — 12 вариантов описания одного и того же (`sl-N либо client_id / spreadsheet_id
  / title`, `client_id / spreadsheet_id substring / title substring / sl-N`, …).

Их сведение — уже изменение видимой справки, поэтому отдельным шагом и с явным решением, какая
формулировка канон.

**✅ Смежное, почти бесплатное — сделано.** `lib/kaiten.py:28-130` — реэкспорт моделей под
`if TYPE_CHECKING`: 34 отдельных импорт-стейтмента на 103 строки; то же в `lib/gitlab_mr.py:34-65`.
Причина — дефолт isort в ruff. Флаг `combine-as-imports = true` в `[tool.ruff.lint.isort]`
плюс `ruff check --fix` убрал 108 строк импорт-шума в 8 файлах без единой правки логики.

---

## 2. Ручная сборка вместо фабрики

14 модулей повторяют шаблон `pick_wrapper` → `resolve_selector` → `require(client_id)` →
собрать `flags: dict` → `emit_node_cli`. Крупнейшие: `process.py` (406), `ozon_fix_fo_tax.py` (305),
`recalculate_ozon_expenses.py` (264), `iu_wb.py` (234). Фабрики, которые это уже умеют:
`lib/factories/{loader_by_sid,loader_by_seller_client,migrations_app,migrations_with_dataset,migrations_with_type,jobs_show}.py`
и `commands/_ssh_node_cli.py:make_app`.

Внутри самого шаблона нашлись три отдельных копипаста:

| Место | Что продублировано | Лечение | Объём |
| ----- | ------------------ | ------- | ----- |
| ✅ `commands/wb_cards_reset.py:97` + `wb_loader_{load,status,reset,resume,blocked}.py` | 6 click-callback'ов, дословно форвардящих kwargs в `_run(*, ...)` | **сделано:** `callback=_run` напрямую, −68 строк | S |
| `commands/process.py:93` vs `recalculate_ozon_expenses.py:81` | `_complete_sku` — дословная копия (различие только в докстринге), плюс `_avoid_singleton_collapse` / `_join_int_bracket` | вынести три чистые функции в `commands/_ozon_completers.py` | S |
| `commands/process.py:374`, `recalculate_ozon_expenses.py:245`, `ozon_fix_fo_tax.py:152` | verbose-печать лезет за приватным `cli_wrap._build_inner` через `pyright: ignore[reportPrivateUsage]` | сделать публичным (или завести `debug_echo_inner`) — приватный импорт из соседа не должен быть штатным приёмом | S |

Объём в целом: L (по модулю за раз) · выигрыш: high.

---

## 3. Оркестраторы, делающие пять дел сразу

`commands/kiten/move.py:279 close` — 135 строк и **четыре** подавления линтера
(`# noqa: C901, PLR0912, PLR0913, PLR0915`): разбор взаимоисключающих `--reply`/`--reply-file`,
чтение файла/stdin, поход в API, планирование полей, раскрытие `@all`, печать плана для `--dry-run`,
выполнение четырёх шагов, печать отчёта. Ветка `dry_run` при этом **дублирует** форматирование,
которое ниже собирается заново для реального прогона.

Тот же силуэт: `commands/logs.py:84 main` (170 строк), `run_js.py:356 main` (124),
`update.py:49 run_update` (109), `pssh.py:166 main` (115), `commands/sheet.py:405 set_`
(4 обязанности: выбор источника из 4 веток → вызов API → инвалидация кэша → печать, под `noqa: C901, PLR0912`).

**Лечение — расслоение `plan → render → apply`:**

```python
plan = build_close_plan(card, provided, force=force_fields, ...)  # чистая, тестируемая
typer.echo(render_close_plan(plan))                               # один форматтер на оба режима
if dry_run:
    return
apply_close_plan(client, plan)                                    # только I/O
```

`--dry-run` перестаёт быть веткой с собственным выводом и становится «просто не вызвать `apply`».
Образец расслоения уже есть в самом пакете: `kiten/timelog.py:61-177`, секция «Чистые хелперы
(без сети и БД, тестируемые)».

Объём: M на команду · выигрыш: high.

---

## 4. Разнобой: канон есть, но его обходят

| Тема | Канон | Обходят |
| ---- | ----- | ------- |
| Ошибки | `lib/cli_err.py` (`fail` / `die`) | 318 мест `typer.echo(..., err=True)`, 163 `raise typer.Exit`; каноном пользуются 18 модулей, **ни один файл `lib/`** |
| JSON-вывод | `lib/cli_out.print_json` (72 вызова) | 37 прямых `json.dumps` |
| Резолв селектора | `lib/resolver.resolve_server` | блок `except ResolveError → echo → Exit(2)` скопирован в 11 модулях `commands/` |
| Локальный `_fail` | — | 8 определений; 4 (`wb_loader_resume.py:113`, `wb_cards_reset.py:58`, `wb_loader_blocked.py:88`, `ss_access.py:49`) отличаются только зашитым `COMMAND` |
| Таблицы | — | ручные `ljust`-принтеры: `ps.py:140`, `ps.py:172`, `health.py:169` (+ `_row`/`_str_field` в `ps.py:154` и `health.py:135` идентичны побайтно) |
| Portainer-конфиг | — | парсинг `PORTAINER_VERIFY_TLS` в 6 местах (`pssh.py:137,221,360,379`, `portainer_discover.py:157`, `_portainer_resolve.py:49`); проверка `PORTAINER_API_KEY` — дважды в `pssh.py` |

Отдельно показательно: `lib/cli_wrap.py` — модуль, задающий стандарт для команд, — сам не пользуется
`cli_err`: 6 ручных `echo`+`Exit` блоков (строки 125, 143, 148, 172, 199, 415, 488).

**Лечение.** `cli_err.bind(COMMAND) -> Fail` (одна фабрика вместо четырёх копий `_fail`);
`resolver.resolve_server_or_exit(selector, *, command_name)` (снимает 11 копий обработки ошибки);
один `render_table(rows, headers)` вместо трёх ljust-принтеров; `servers.portainer_verify_tls()`
и `require_portainer_api_key()`. Перевод модулей — по одному, начиная с тех, где `err=True` встречается
10+ раз: `sheet.py` (28), `run_js.py` (27), `mp_init.py` (20), `_logs_loki.py` (17), `lib/pg_copy.py` (16), `pssh.py` (15).

Объём: L суммарно, делится на независимые S-порции · выигрыш: medium-high.

---

## 5. Копии, которые уже разошлись

Это подкласс §4, вынесенный отдельно: здесь копипаста перестала быть косметикой.

**5.1. Резолв таргета — `run_js.py:126` vs `pssh.py:75-129`.** Один и тот же четырёхшаговый алгоритм
(`dev:N` → `sl-N` → точное имя контейнера в Portainer-кэше → fallback через поиск), включая
структурно идентичные `_ServerTarget`/`_ContainerTarget` (`run_js.py:82-91`, `pssh.py:64-73`).
Механический diff даёт две дельты — и одна из них смысловая: `run_js.py:176,200` проверяет `n < 0`
(«ожидается sl-N (N>=0)»), `pssh.py:99,126` — `n <= 0` («ожидается sl-N (N>0)»), то есть `sl-0`
одна команда принимает, а вторая отвергает. Читатель, знающий одну команду, получит на другой
неожиданный отказ; из кода не видно, намеренная это разница или расхождение копий.
Лечение: общий `commands/_target_resolve.py` с одной зафиксированной границей. Объём: M · выигрыш: high.

**✅ 5.2. A1-кавычки имени листа — `sheet_cache.py:408,419,580`, `commands/sheet.py:135`.** Четыре копии
одной эвристики `f"'{tab}'" if any(ch in tab for ch in " '!")`, и **ни одна не экранирует апостроф**
(`'` → `''`): имя `John's` даёт сломанный A1-диапазон `'John's'!A1:…`. Условие про `'` в них есть —
значит про апостроф помнили, а экранирование потеряли. Корректная версия существует, но в другом
файле и не переиспользуется: `sheet_batch.py:1299` (`"'" + default_tab.replace("'", "''") + "'"`).
Это уже не читаемость, а тихая ошибка на листе с апострофом в имени. **Сделано:** `quote_tab_name()`
в `sheet_cache.py`, все 5 мест (включая `sheet_batch.py`) — через неё.

Побочный эффект, который стоит знать: критерий кавычек подтянут к строгому (кавычить всё, что
не `[A-Za-z0-9_]`) — тому, что уже был документирован в `docs/sheet-batch.md:46` и жил в
`sheet_batch._full_range`. Поэтому кавычки теперь ставятся шире: `Чек-лист`, `01.2026`,
`План(черновик)` раньше уходили без кавычек, теперь — в кавычках. Это безопасно в обе стороны:
новый критерий — надмножество старого (кавычки только добавляются), Sheets API принимает обе формы
и сам канонизирует ответ в квотированную (проверено live-запросом), ключи локального кэша хранят
сырое имя листа и не затронуты. Заодно устранён рассинхрон вывода: поле `range` из кэша печаталось
`Чек-лист!A1:B2`, а из живого ответа API — `'Чек-лист'!A1:B2`.

**5.3. `_pick_client_id` — `copy_client.py:37` vs `move_client.py:31` (+ `move_client_back.py:52`).**
Дословная копия, включая тексты ошибок. Лечение: `resolver.require_single_client_id(candidates, command_name)`.
Объём: M · выигрыш: medium.

**5.4. `_logs_loki.py:53` — `run()` и `follow()` как параллельные копии** пролога подготовки запроса
плюс три идентичных `except`-блока httpx (`:79-86`, `:160-167`, `:189-197`). Лечение: общий `_prepare()`
и `_query_or_report(..., fatal: bool)`. Объём: M · выигрыш: high.

**5.5. HTTP-клиенты — `lib/slapi.py:53` vs `lib/x10api.py:47`.** `_truncate`, `_build_url`,
класс ошибки со `status`/`body` реализованы заново в каждом. Лечение: общие примитивы
в `lib/http_client_base.py`, доменная логика остаётся на месте. Объём: M · выигрыш: low-medium.

**5.6. Прочие точечные дубли.**

| Место | Что | Лечение | Объём |
| ----- | --- | ------- | ----- |
| `lib/kaiten_cache.py:71,104,138,171,199` | 5 × скелет «env-check → try/except → DELETE+INSERT» | `_best_effort(fetch) -> T \| str` | S |
| ✅ `lib/kiten_status.py:97` и `:114` | две функции с идентичным телом, различие — имя env-переменной | **сделано:** `_load_casefold_json_map(env_var)` | S |
| ✅ `lib/miro.py:121 delete_frame` | политика «DELETE, терпимый к 404 и к 400+locked с разлочкой и повтором» написана дважды подряд, `try` внутри `try` внутри `for` (глубина 5) | **сделано:** `_delete_tolerant(path, item_id=…)`, тело `delete_frame` — 3 строки | S · high |
| `lib/sql_runner.py:121` vs `lib/sql_sw.py` | хвост форматирования результата — 2 копии | `sql_runner.emit_result(...)` | S |
| `commands/kiten/refs.py:53` (+ roles/boards/lanes/columns) | 5 команд копируют скелет «discover → filter → (json \| table + счётчик)», ~230 строк | `_print_ref_table(...)` в `_render.py` | S |
| `commands/kiten/timelog.py:232` | таблица записей времени: `_print_logs` и инлайн-копия в `_summary` | параметризовать `_print_logs` | M |
| `lib/xlsx_reader.py:156` и `:232` | разбор адреса ячейки — 2 копии | `_split_letters_digits(addr)` | S |

---

## 6. Непрозрачный поток данных

| Место | Что не так | Лечение | Объём · выигрыш |
| ----- | ---------- | ------- | --------------- |
| `commands/update.py:23` | строки клиента — позиционные кортежи, читаются как `row[0]…row[4]` в 4 местах | `@dataclass(frozen=True) ClientRow` / `SpreadsheetRow`, мапить сразу после курсора | M · medium |
| `commands/glab_status.py:219` | строка отчёта — `dict[str, Any]` на 10 произвольных ключей, читается по всему модулю | `@dataclass(frozen=True) MrRow` | M · medium |
| ✅ `lib/portainer.py:270` | остаток буфера WS-хендшейка передавался **monkeypatch-атрибутом на объекте socket** вместо возврата | **сделано:** `_open_ws() -> tuple[socket, bytearray]`, `leftover` — явный параметр `_read_ws_frames`; `# type: ignore` убран | S · high |
| `lib/iu_formula.py:62` | `pairs` + `seen` вручную воспроизводят то, что даёт обычный `dict` (порядок вставки гарантирован) | один `dict[str, str]` | S · medium |

---

## 7. Ручные автоматы и парсеры

| Место | Глубина | Что там | Лечение |
| ----- | ------- | ------- | ------- |
| `lib/sheet_batch.py:292 parse_style_flags` | 10 | разбор `bg=#EA4335 bold` посимвольно | таблица «флаг → парсер значения» |
| `lib/sheet_batch.py:40,92,113` | 7 | **три** независимые копии одного quote-автомата (`split_statements`, `_scan_word`, `tokenize`) | общий примитив `_skip_quoted(s, i)` |
| `lib/sheet_batch.py:1237 compile_read` | 8 | грамматики `get` и `read` в одном теле под `noqa: C901, PLR0912` | `_parse_get_stmt` / `_parse_read_stmt` + тонкий диспетчер |
| `lib/d2_parser.py:141 parse_d2_source` | 3 | один 95-строчный цикл разбирает 6 грамматических форм | `_try_markdown_block` / `_try_connection` / `_try_property` / `_try_block_open` / `_try_leaf` |
| `lib/d2_parser.py:359 parse_svg` | 3 | viewBox + edge-группы + shape-группы в одном цикле | `_parse_edge_group` / `_parse_shape_group` |
| `lib/d2_parser.py:269 _path_bbox` | 8 | 12-ветковый `if/elif` с общим мутируемым состоянием | таблица `dict[str, handler]` по букве команды |

`sheet_batch.py` (1342 строки) переписывать целиком не нужно — он уже неплохо устроен внутри
(44 builder-функции через единую dispatch-таблицу `_VERBS`). Достаточно вынести общий сканер
и разрезать файл по швам, которые уже прочерчены комментариями: лексер / компилятор записи /
компилятор чтения. Объём: L · выигрыш: medium — трогают редко, приоритет ниже §1–§4.

✅ Отдельно: `commands/sheet.py:196` — блок `conn = _open_db()` + `try/finally: conn.close()`
был повторён **13 раз**; **сделано:** `@contextmanager def _sheet_db()`, все 13 сайтов — `with _sheet_db() as conn:`.

---

## 8. Тесты: 40 000 строк почти без общих двойников

889 вызовов `monkeypatch.setattr`. Одни и те же фейки объявлены заново десятками:
`_fake_run` × 33, `_fake_resolve` × 22, `fake_run` × 21, `_fake_connect` × 13.

| Место | Что | Лечение | Объём · выигрыш |
| ----- | --- | ------- | --------------- |
| `tests/test_kiten.py` | 3 885 строк тестируют 8 уже разнесённых модулей `commands/kiten/*`; внутри виден шов — стиль разделителей меняется с `# ── … ──` (×35) на `# --- … ---` (×10) | разбить по образу `src`: `test_kiten_card.py`, `test_kiten_move.py`, `test_kiten_refs.py`, … | L · high |
| `tests/test_telegram.py:339` | 9 `Fake*Client` копируют один async `connect`/`disconnect`-боилерплейт (8 дословных повторов) | базовый `_FakeTelegramClientBase`, наследники переопределяют только своё | M · medium |
| `tests/test_pssh.py:342` | 15 ручных `captured: dict[str, object]` spy-замыканий + 3 стаб-класса Portainer | один `Recorder` в начале файла | S · low |
| `tests/test_pssh.py:583` | фикстура `bootstrap_db` растипизирована до `object` в 14 сигнатурах + 4 `# type: ignore[operator]` | `Callable[[Path \| str], None]` — тип уже импортирован в файле | S · low |

Образцы, которые стоит распространить, уже есть в самом каталоге: `tests/pg_fakes.py`,
`_install_client` в `test_kiten.py:1324`, секции «Фикстуры»/«Fakes» в `test_sheet_command.py`.
Общие двойники (`fake_node_cli`, `fake_resolve`, `fake_pg`) — в `tests/conftest.py`.

---

## 9. Побочные находки (не читаемость, но нашлись попутно)

- **Старт CLI ~1 с.** `mpu version` — 1,05 с, из них 0,65 с — импорт `mpu.cli`, жадно монтирующий
  все 54 команды и тянущий `psycopg` (148 мс), `httpx` (126 мс), `asyncio` (102 мс). Лечится ленивым
  монтированием (импорт модуля команды в момент вызова).
- **`emit_node_cli` совмещает две роли** (`lib/cli_wrap.py:210`): при `wrapper="portainer"` выполняет
  и возвращает `""` «для совместимости сигнатуры», иначе печатает и возвращает строку. Кандидат
  на разделение `run_node_cli` / `render_node_cli`.
- **noqa-долг: 119 подавлений в `src`**, из них 62 — `PLR2004` (magic values). Правило включено,
  но массово глушится: либо выносить константы, либо честно выключить правило.

---

## 10. Что проверено и признано НЕ проблемой

Чтобы к этим местам не возвращались повторно:

- `commands/kiten/_common.py:132` — четыре резолвера (`_resolve_space/_board/_lane/_column`) выглядят
  как копипаста, но общий алгоритм **уже** вынесен уровнем ниже (`lib/kaiten_cache.py:355`);
  оставшиеся 8 строк на сущность — тонкие адаптеры с разными типами и сообщениями. Обобщение
  ухудшило бы читаемость.
- `lib/pg.py:162-231` — шесть фабрик `PgConn` выглядят однотипно, но экстракция общего уже сделана:
  две из шести вообще не читают env, остальные различаются набором фолбэков. Дальнейшее сжатие —
  чистая потеря ясности.

---

## 11. Очередь работ

Порядок — по отношению «выигрыш / риск». Шаги независимы.

| # | Шаг | Объём | Выигрыш |
| - | --- | ----- | ------- |
| ✅ 1 | `combine-as-imports = true` + `ruff --fix` — сделано (−108 строк в 8 файлах) | S | medium |
| ✅ 2 | Точечные S-фиксы — сделано: `miro._delete_tolerant`, `portainer` явный возврат, `kiten_status` общая функция, `_sheet_db()` ×13, `callback=_run` ×6, `quote_tab_name` ×5 (§5.2, с фиксом экранирования) | S каждый | high |
| ✅ 3 | `lib/cli_opts.py` + перевод модулей — сделано (120 объявлений, −225 строк с учётом нового каталога, справка не изменилась) | M | high |
| 4 | `resolver.resolve_server_or_exit` + `require_single_client_id` + `cli_err.bind` | M | high |
| 5 | Общие фикстуры в `tests/conftest.py` (`fake_node_cli`, `fake_resolve`, `fake_pg`) | M | high |
| 6 | `plan → render → apply` для команд с `--dry-run` (начать с `kiten close`) | M | high |
| 7 | Общий `_target_resolve.py` для `run_js`/`pssh` (снимает расхождение `N>0`/`N>=0`) | M | high |
| 8 | Разбить `tests/test_kiten.py` по модулям `commands/kiten/*` | L | high |
| 9 | Расширить `make_app`/фабрики, перевести 14 ручных обёрток | L | high |
| 10 | `sheet_batch.py`: общий сканер + разрез по швам; `d2_parser.py`: `_try_*`-хелперы | L | medium |
| 11 | Ленивое монтирование команд (побочно — старт CLI) | S | (perf) |
| 12 | Свести разошедшиеся формулировки `--json` / `--dry-run` / дат / селектора (§1) — меняет видимую справку | M | medium |

---

## 12. Как мерить

Ratchet-проверки — числа в комментариях текущие, они должны только убывать:

Значения — на 2026-07-23, после шагов 1–2 очереди.

```sh
# структурные пороги (см. CLAUDE.md, принцип 8)
uv run ruff check --preview --select PLR1702 --config 'lint.pylint.max-nested-blocks=4' src   # 7 (было 8)
uv run ruff check --select C901 --config 'lint.mccabe.max-complexity=10' src                   # 9 (было 10)
uv run ruff check --select PLR0915 --config 'lint.pylint.max-statements=40' src                # 11

# обходы канонов
grep -rn 'err=True' src | wc -l                    # 318 → убывает
grep -rn 'json.dumps' src | wc -l                  # 37  → 0 вне lib/cli_out.py
grep -rn 'except ResolveError' src | wc -l         # 13  → 0 вне lib/resolver.py
grep -rn 'monkeypatch.setattr' tests | wc -l       # 895 → убывает
grep -rn '# noqa' src | wc -l                      # 113 (было 119) → убывает

# самые длинные функции и доля деклараций
uv run python - <<'PY'
import ast, pathlib
rows = []
for p in pathlib.Path("src/mpu").rglob("*.py"):
    tree = ast.parse(p.read_text())
    for n in ast.walk(tree):
        if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef):
            rows.append(((n.end_lineno or n.lineno) - n.lineno + 1, f"{p}:{n.lineno} {n.name}"))
rows.sort(reverse=True)
print(f">60 строк: {sum(1 for L, _ in rows if L > 60)}")   # 53
for L, where in rows[:10]:
    print(f"{L:4d}  {where}")
PY
```
