# Порция V6 — уборка после перевода тестов (этап 1)

Статус: к реализации (2026-10-07). Порции V1–V5 слиты (`main` `30dcda5b`):
Vitest — 411 файлов, 7504 случая; под `deno test` — 15 файлов (12
`back/src/telegram/*_test.ts`, `back/src/init/telegram_test.ts`,
`web/src/{tasks,vitest}_test.ts`). Спеки этапа — `platform/vitest.md`,
`platform/vitest-v2-v5.md`.

## Кто и зачем

Разработчик хочет, чтобы после параллельного перевода в тестах не осталось
нескольких копий одного помощника, правила `ts/CLAUDE.md` описывали
фактическое состояние, а полный прогон не краснел случайно.

## Сценарии [S.n]

1. Один модуль тестовых помощников `back/src/testing/`: стенд HTTP на петле
   (сегодня — `serveLoopback`/`listenLoopback` в `back/src/exec/testserve.ts`
   и `serveFetch` в `back/src/testing/http.ts`; с H2 — `@mpu/testing`), пойманная ошибка
   (`thrown`/`rejected` в `back/src/testing/thrown.ts`, с H2 `rejected` — в `@mpu/testing` и ручные
   `try/catch` + `assert(err instanceof …)` порций V2–V4), строки SQLite без
   прототипа (`plainRows` в `back/src/testing/cache.ts`, `plainRows` в
   `kaiten/kaiten.test.ts`, `aliasRowsOf` в `sheet/registry_cmd.test.ts`,
   `{ ...row }` в `kiten/cmd_refs.test.ts`, `plain()` в
   `init/cmd_init.test.ts`), область на время `describe` (`heldScope`,
   `fakeTimers` в `back/src/exec/testscope.ts`). У каждого вида — одна
   реализация; `back/src/exec/testscope.ts`, `back/src/exec/testserve.ts`
   удалены, вызывающие импортируют из `back/src/testing/`.
2. Помощник, импортирующий `vitest`, недостижим из `*_test.ts` (15 файлов
   `deno test` остаются зелёными).
3. Список листовых случаев полного `deno task vitest` до и после — один и тот
   же (7504 строки, junit), `deno task test` — тот же (15 файлов).
4. `ts/CLAUDE.md`: «Шаг 1 — гейты», «Команды», «TDD» — `deno task test`
   описан как раннер ровно 15 файлов (перечень и причина: JSR `@mtcute/deno`
   до этапа 3; раннер фронта), новый тест — только `*.test.ts`.
5. `deno.jsonc`: комментарии к правам задачи `test` (`--allow-run=…`), чьи
   сторожившие случаи ушли в Vitest, — пересмотрены: право без сторожа снято
   или назван его нынешний сторож.
6. `complete/src/tasks.test.ts`, «с правами задачи процесс спрашивает back:
   вариант не из снимка»: 10 полных `deno task vitest` подряд при нагрузке
   (load average ≥ 4) — без падения этого случая; поведение кода под тестом
   (ожидание `back` 150 мс) не меняется. Если без правки кода нельзя — вопрос
   в отчёте с причиной, а не правка.
7. Гейты зелёные: `deno fmt --check`, `deno lint`, `deno check .`,
   `deno task test`, `deno task vitest`, `deno task smoke`.

## Инварианты

- Ни один случай не потерян и не добавлен; проверки не ослаблены (каждая
  замена помощника — та же строгость; спорное — пара «зелёный / красный»).
- Код под тестом не меняется.

## Границы

- Перенос помощников в `tslibs/` — после этапа 3.
- 15 файлов `deno test` не переводятся.

## Пункты чек-листа

`design.md`: 1 примитивы — по одному помощнику на вид; 2 особые случаи — нет;
3 — `?.`/проверки в помощниках — по правилам модуля; 4 кто решает — помощник
своего вида; 5 — ничего; 6 голые данные — ничего; 7 основание проверкой —
[S.3] список случаев. `design-mpu.md`: 4 один источник — одна реализация на
вид; 7 границы модулей — `back/src/testing/`; прочее — ничего.
