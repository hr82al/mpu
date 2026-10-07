# Тесты на Vitest — порции V2–V5 (этап 1 перехода)

Статус: к реализации (2026-10-07). Основа, правила перевода и выбор раннера по
имени файла — `platform/vitest.md` (порция V1, реализовано); здесь — что
добавляют четыре параллельные порции. План —
`docs/plans/2026-10-06-bun-tslibs-objects-plan.md`, этап 1.

## Кто и зачем

Разработчик mpu хочет закончить перевод тестов: все `*_test.ts` — на Vitest,
ни один случай не потерян, этап 1 закрыт. Порции идут одновременно в своих
клонах и не пересекаются по путям.

## Порции и пути

| Порция | Каталоги | Файлов |
|---|---|---|
| V2 | `back/src/kiten`, `back/src/line`, `back/src/telegram` | 90 |
| V3 | `back/src/backend`, `back/src/kaiten`, `back/src/sheet`, `back/src/claudehook`, `back/src/code`, `back/src/registry`, `back/src/api`; помощник `back/src/backend/testback.ts` | 101 |
| V4 | `back/src/sql`, `back/src/botquestions`, `back/src/init`, `back/src/nodecli`, `cli/src`, `back/src/copy`, `supervisor/src`, `back/src/task`, `back/src/exec`, `back/src/search`, `back/src/logs`, `back/src/invokelog`, `back/src/mpinit`; помощник `back/src/task/teststand.ts` | 85 |
| V5 | все прочие `*_test.ts` вне путей V2–V4 (в т. ч. `mcp/src`, `complete/src`, `handoff`, `back/scripts`, `web/src/*_test.ts`); `Deno.*` в 8 файлах `back/src/objects` (V1); `back/scripts/smoke.ts` | 142 |

## Сценарии [S.n] — для каждой порции P

`N_P` — число листовых случаев путей P, снятое junit `deno test <пути P>` с
`main` до правок; литерал — в отчёт.

1. `deno task vitest <пути P>` → зелёно, ` Tests  N_P passed (N_P)`.
2. Список листовых случаев путей P до (junit `deno test`, «тест > шаг») и после
   (junit Vitest, «describe > it») совпадает строка в строку, кроме
   переименований из [S.7].
3. `rg -c 'Deno\.test|@std/assert|@std/testing' <пути P>` → пусто; `*_test.ts`
   в путях P нет, файлы названы `*.test.ts`.
4. `rg -c 'Deno\.' <файлы *.test.ts порции>` → пусто: вызовы `Deno.*` в самих
   тестах переведены на `node:*` (`node:fs/promises`, `node:os`, `node:path`,
   `process.env`, `node:child_process`); код под тестом не меняется.
   Исключение до этапа 3 (решение хоста 2026-10-07): тест подменяет или
   строит объект рантайма, которым пользуется код под тестом, — перевод
   опустошил бы проверку. Такие места перечисляются в отчёте поимённо; на
   2026-10-07: `backend/prompt.test.ts` (подмена `Deno.open`),
   `registry/contract.test.ts` (перехват `Deno.stdout/stderr`),
   `backend/socket.test.ts` (`Deno.serve` + `Deno.upgradeWebSocket`),
   `api/schema_golden.test.ts` (`new Deno.errors.NotCapable`).
5. `deno task test` (оставшиеся `*_test.ts`) → зелёно; число файлов = до минус
   файлы P.
6. Для каждого вида утверждения или помощника `@std/*`, которого нет в таблице
   `.tmp/stage1/design-V1.md` (хост кладёт её в клон вместе со скриптом
   перевода V1 `.tmp/stage1/translate.ts`), — пара «зелёный / красный»
   вход до и после в `.tmp/design-<P>.md`.
7. Тест с опцией `permissions` (`back/src/messages/read_test.ts`,
   `supervisor/src/install_test.ts` и др.) — опция уходит; имя, обещающее
   проверку прав, меняется на проверяемое: `шаг не трогает окружение, файлы и
   сеть и повторяется` → `шаг повторяется`. Иные переименования — только с
   записью «было → стало» в отчёте.
8. Помощник `testback.ts` (V3) и `teststand.ts` (V4) — на `node:assert/strict`;
   старые `*_test.ts`, которые его зовут, зелёные под `deno task test`.
9. Только V5, последней по слиянию: `*_test.ts` вне `web/` остались только
   у файлов, чей код под тестом грузит JSR-пакет `@mtcute/deno` (на npm его
   нет; Vite карту `imports` не читает) — 12 файлов `back/src/telegram`
   (`client_refusal`, `cmd_login`, `connection`, `crypto`, `login_client`,
   `lookup`, `markdown`, `media_file`, `search`, `send`, `session`,
   `session_port`); они переходят на Vitest в порции этапа 3, где Telegram
   уходит на `@mtcute/node`. `@std/assert`, `@std/testing` остаются в
   `deno.jsonc` только для них; гейт и «Команды» в `ts/CLAUDE.md` — `deno task
   test` с этой оговоркой; `back/scripts/smoke.ts` — на
   `node:assert/strict`, `deno task smoke` зелёный.
10. Гейты порции зелёные: `deno fmt --check`, `deno lint`, `deno check .`,
    `deno task test`, `deno task vitest`, `deno task smoke`.

11. Предел времени случая и хука у Vitest снят (`testTimeout: 0`,
    `hookTimeout: 0` в корневом `vitest.config.ts`), как у `deno test`: под
    нагрузкой 5 с давали ложные красные, а брошенный по пределу случай
    продолжал исполняться и портил следующий. Частных пределов в тестах нет.

## Инварианты

- Ни один случай не исполняется двумя раннерами и ни один — ни одним.
- Порция правит только свои пути (и свой помощник); чужие пути — ни строки.
- Каждый переведённый случай краснеет на тех же данных, что и до перевода.

## Границы

- Код под тестом с `Deno.*` не переписывается (этап 3).
- Biome, `bun:test`, прогон под Bun и Node — не в этих порциях.
- `web/` и его раннер (`web:test`, `*.test.tsx`) не трогаются.
- Правила `ts/CLAUDE.md` правит только V5 ([S.9]).

## Свойства решения

- Порядок слияния порций любой (V5 — последней); после каждой дерево зелёное.

## Пункты чек-листа

`design.md`: 1 примитивы — те же, что у V1 (раннер по имени, таблица
перевода); 2 особые случаи — помощники закреплены за одной порцией; 3–6 —
ничего (логики нет); 7 основание проверкой — [S.2], [S.6].
`design-mpu.md`: 4 один источник — помощник один на оба раннера
(`node:assert/strict`); 6 права Deno — уходят из тестов по решению владельца;
прочее — ничего.
