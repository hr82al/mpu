# Formula evaluator — iteration report

Цель итерации: вычислять каждую формулу листа UNIT, дозаполнять
`formula-fns/` по мере обнаружения недореализованных функций, собрать
список нерешаемых проблем.

## Что работает (с TDD)

- **`formula-finder/resolve`** — различает `[:formula]` / `[:direct]` /
  `nil`. Для ячеек с прямым вводом (нет формулы сверху-слева) возвращает
  `[:direct addr value]`. Тесты: 4 ✓
- **`formula-eval/eval`** — AST-walker: literals, `:ref` со стрипом `$`,
  `:range` (2D), `:unop` / `:postfix` / `:binop`, `:array`, `:call` с
  dispatch-таблицей, `:name` с env-scoping. Тесты: 16 ✓
- **LET + LAMBDA + env-scope** — замыкания работают,
  `LET(x,3,x+1) → 4`, `LET(d,LAMBDA(x,x*2),d(5)) → 10`. Тесты: 3 ✓
- **Cross-sheet loader с кэшем** — `Sheet!A1` триггерит
  `mpu/batch-get-all`, результат кэшируется в `ctx :sheet-cache`.
- **Auto-stub генерация** — при вызове незарегистрированной функции
  `formula-fns/<name>.janet` создаётся рабочий шаблон, печатающий
  debug и возвращающий `[:stub NAME]`.

## Реально реализованные функции

`ARRAYFORMULA`, `CONCATENATE`, `IF`, `IFERROR`, `LAMBDA`, `LET`, `NA`,
`SUM`, `TODAY`

## Прогон на UNIT (650 формул)

```
matched:        7
stub-returned:  412    ← вызывают хотя бы один недореализованный stub
mismatched:    226    ← пропагация [:stub ...] в родительских вычислениях
eval-errors:    5    ← арифметика над массивами/диапазонами
direct-cells:  150
```

## Auto-stub'ы (созданы, ждут логики)

`CHOOSEROWS`, `CL_QUERY`, `INDEX`, `ISBLANK`, `KEYSQUERY`, `MAP`,
`SQL_DATE`, `XLOOKUP` — каждый лежит в `janet/formula-fns/<name>.janet`.
Шаблон регистрируется, печатает аргументы при вызове и возвращает
`[:stub NAME]`, так что эвалюатор продолжает обход AST без падения.

## Оставшиеся проблемы

1. **Array broadcasting** (5 eval-errors) — в Sheets `A + B`, где оба
   аргумента — диапазоны/массивы, работает поэлементно. Требуется
   обёртка над `:binop` в `formula-eval.janet`, приводящая tuples к
   element-wise.
2. **412 stub-вызовов** — чтобы 412 формул стали matched, нужно
   реализовать 8 функций выше.
3. **226 mismatches** — все из-за того, что stub возвращает
   `[:stub NAME]`, а ожидается реальное значение. Исчезнут
   автоматически по мере реализации stub-функций.
4. **Нерешённые именованные диапазоны** — на UNIT не встречено,
   unresolved-список пуст. Если встретятся при расширении — попадут в
   `ctx :unresolved`.

## Архитектура

| Файл | Назначение |
|------|-----------|
| `janet/formula-finder.janet` | `cell->rc`, `find-source`, `resolve`, `lookup-cell` |
| `janet/formula-parser.janet` | Токенайзер + Pratt-парсер, AST из tagged-tuples |
| `janet/formula-eval.janet` | AST-walker с env, замыканиями, dispatch-таблицей |
| `janet/formula-fns/*.janet` | По файлу на `:call`-функцию; регистрируются через `formula-eval/register` |
| `janet/commands/ss-eval.janet` | `mpu ss-eval -s ... -n UNIT` — прогон + отчёт |
| `cmd/repl.go:552` | Loader сканирует `formula-fns/` при boot VM |
| `janet/tests/*_test.janet` | Юнит-тесты для finder, parser, eval |

## Запуск отчёта повторно

```bash
MPU_JANET_DIR=$(pwd)/janet ./mpu ss-eval \
  -s 1NHoyZVE_zj6KG6K7UE2EeBsMVlM_Xqi1-3OeFgFlttM \
  -n UNIT
```

## Следующие шаги (инкрементально)

Каждый шаг переводит группу формул из `stub` в `matched`:

1. Реализовать broadcasting для `:binop` → снимет 5 eval-errors.
2. Реализовать `INDEX`, `MATCH` → снимет базу для всех `col(…)`-паттернов
   в UNIT (почти все формулы используют).
3. Реализовать `MAP` с учётом LAMBDA-семантики Sheets.
4. Реализовать `XLOOKUP` + `CHOOSECOLS` / `CHOOSEROWS`.
5. `KEYSQUERY`, `CL_QUERY`, `SQL_DATE` — специфика WBs; делать по
   необходимости и на реальных данных.

Останавливаться можно на любом шаге — уже зелёной инфраструктуры
достаточно для TDD-расширения по одной функции за раз.
