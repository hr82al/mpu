# Этап 3 — код без `Deno.*`, установка и сборка на Bun

Статус: к реализации после V6 (2026-10-07); зависимости разрешены владельцем
2026-10-07 (раздел «Зависимости»). План — `docs/plans/2026-10-06-bun-tslibs-objects-plan.md`,
«Порядок этапов» (вариант А); правило — `CLAUDE.md` mpu, «Код без привязки к
рантайму». Пробы — `mp/tmp/stage2-probes/log.md`.

## Кто и зачем

Разработчик хочет, чтобы `ts/` работал одинаково под Bun, Node и Deno: код
только на `node:*` и npm, тесты зелёные под каждым из трёх, бинари собирает
`bun build --compile`, установка — `bun install`. После этого библиотеки
`tslibs/` подключаются архивом штатно (этап 4).

## Опись (снято с `main` 2026-10-07)

496 вызовов `Deno.*` в 88 файлах кода (не тестов): `back/scripts` 114,
`back/src/runtime` 54, `backend` 29, `supervisor/src` 29, `code` 26, `line` 22,
`cli/main.ts` 17, `cli/src` 15, `worker` 12, `claudehook` 12, `invokelog` 12,
`mcp/main.ts` 10, `mpclone` 10, прочие — до 9 (полный список —
`mp/tmp/stage3-deno.txt`). Плюс 15 файлов `*_test.ts` под `deno test`
(Telegram на JSR `@mtcute/deno`, `web/src`).

## Порции

| Порция | Пути | Что |
|---|---|---|
| E1 | `back/src/runtime`, точки входа (`back/back.ts`, `back/worker.ts`, `back/task.ts`, `cli/main.ts`, `mcp/main.ts`, `complete/main.ts`, `supervisor/main.ts`, `handoff/`), `back/src/backend`, `supervisor/src`, `cli/src`, `mcp/src` | ввод-вывод процесса, сигналы, выход, аргументы, сервер строк и WebSocket, подпроцессы супервизора |
| E2 | прочие `back/src/*` (кроме `runtime`, `backend`, `telegram`, `init/telegram`) | файлы, окружение, подпроцессы доменов; `invokelog` — блокировка файла |
| E3 | `back/src/telegram`, `back/src/init/telegram*`, `back/src/http` | `@mtcute/deno` → `@mtcute/node`, wasm криптографии модулем; прокси HTTP без `Deno.createHttpClient`; 13 файлов `*_test.ts` → Vitest |
| E4 | `deno.jsonc`, `package.json`, `back/scripts`, `install.sh`, `web/`, `ts/CLAUDE.md`, `ts/docs/CLAUDE.md` (команды ячейки) | переключение инструментов на Bun (после E1–E3) |

E1–E3 идут параллельно в своих клонах (пути не пересекаются); каждая держит
гейты прежними (`deno fmt`, `deno lint`, `deno check`, `deno task test`,
`deno task vitest`, `deno task smoke`) — Deno понимает `node:*`. E4 — после
слияния E1–E3.

## Сценарии [S.n]

Для E1–E3 (порция P):

1. `rg -n 'Deno\.' <пути P>` (код и тесты) → пусто.
2. Голдены и случаи тестов путей P — те же; список листовых случаев полного
   Vitest до = после (кроме 13 файлов, переходящих в E3 из `deno test`).
3. Гейты зелёные (как выше); `deno task smoke` зелёный.
4. Тесты путей P зелёные под Node и Bun (`npx vitest run <пути>`,
   `bunx --bun vitest run <пути>`), если их код не тянет непереведённые пути
   других порций; иначе — перечень в отчёте.

E1:

5. Сервер строк: `Deno.serve` + `upgradeWebSocket` → `@hono/node-server` +
   `ws`; остановка — `closeAllConnections()` и `close()` (проба: без этого
   процесс под Deno не выходит). Голдены кадров и тесты сервера — те же.
6. `SIGTERM`/`SIGINT`, коды выхода, размер терминала, `isTerminal`, чтение
   `stdin` — то же наблюдаемое поведение (существующие тесты и smoke).

E2:

7. `invokelog`: ротация журнала сериализуется между процессами без
   `Deno.FsFile.lock` (`proper-lockfile`); два процесса, ротирующие одновременно, не теряют и не
   двоят запись; ожидание лока ≤ 500 мс, потом запись без ротации (как сейчас,
   `platform/invoke-log.md`).

E3:

8. Telegram — как в пробах: `@mtcute/node@0.31.0`, `NodeCryptoProvider` из
   `@mtcute/node/utils.js`, `initSync` на байтах wasm из модуля, который
   генерирует сборка; голдены команд `telegram *` — те же; 13 файлов `*_test.ts`
   → `*.test.ts`, список случаев тот же.
9. HTTP: один путь через `node:http(s)` с агентом прокси
   (`https-proxy-agent`): явный прокси → окружение (`HTTPS_PROXY`, `NO_PROXY`)
   → напрямую; одинаково под тремя (`platform/tslibs-http.md`, [S.6]–[S.7]).

E4:

9a. Остатки E1–E3, которые держали права собранных бинарей Deno (E2,
    2026-10-07): `Deno.Command` → `node:child_process` в 11 файлах
    (`exec/ssh`, `copy/tools`, `copy/cmd_copy_shared`, `task/orchestra/system`,
    `worker/launch`, `gitlab/git`, `d2miro/env`, `code/git`,
    `claudehook/window`, `mpinit/docker`, `mpclone/ports`);
    `Deno.makeTempFileSync` в `copy/tools`; лок ротации журнала
    (`invokelog/file.ts`) — `proper-lockfile` вместо `Deno.FsFile.lock` (под
    Deno его `graceful-fs` упирался в `--allow-env`); переменные `ws`
    (`WS_NO_BUFFER_UTIL`, `WS_NO_UTF_8_VALIDATE`), `DEBUG` у
    `https-proxy-agent`, скрытый ввод (`setRawMode`) — права снимаются вместе
    с `deno compile`. После E4 `rg -n 'Deno\.' ts/` — пусто, кроме голденов
    анализатора кода.
9b. E3 (принято хостом 2026-10-07): генератор `back/src/telegram/wasm_modules.ts`
    — в `back/scripts` вместе со сборкой (до E4 модуль закоммичен, сверку с
    пакетом держит `crypto.test.ts`); `--include *.wasm` и сами `.wasm` у
    `compile:*` снимаются; `telegram/bot.test.ts` — локальный сервер на петле →
    `serveFetch` из `back/src/testing/http.ts` (дубль остался после слияния с
    V6). Известные отклонения пути HTTP от прежнего `fetch` (вердикт
    preserve — голденов нет, поведение команд то же): нет `User-Agent` и
    `accept-encoding`; текст сетевого отказа `connect ECONNREFUSED …` вместо
    `error sending request … (os error 111)`; `NO_PROXY` без CIDR; модель
    устройства сессии Telegram — `Node.js/…`.
10. `bun install && bun run gate` в `ts/` → Biome, `tsc --noEmit`, Vitest под
    Bun, Node и Deno, сборка — зелёно; `deno.jsonc` и `deno.lock` удалены,
    `bun.lock` закоммичен.
11. Семь бинарей (`mpu`, `mpu-back`, `mpu-worker`, `mpu-mcp`, `mpu-complete`,
    `mpu-supervisor`, `mpu-task`) — `bun build --compile`; smoke собранных
    бинарей (без проверок прав Deno) зелёный; старт `mpu --version` — замер
    до/после (сегодня 24.7 мс).
12. `install.sh` ставит бинари Bun, идемпотентен; `mpu --version`,
    `mpu kiten ls limit: 1`, хук Claude Code — работают (живьём — хост).
13. Ячейка передачи работы: команды `bun run handoff …` вместо `deno task
    handoff …` в `ts/CLAUDE.md` и `ts/docs/CLAUDE.md`.
14. `web/`: сборка и тесты фронта через Bun (`vite`, `vitest`), `deno test`
    больше не нужен ни для чего.
15. Случаи, чувствительные ко времени под нагрузкой (этап 1, V6):
    `complete/src/tasks.test.ts` «с правами задачи процесс спрашивает back»
    (дополнение ждёт `back` 150 мс; ответ `back` без нагрузки 54–78 мс, время —
    в `line/keys.ts` и `registry/mod.ts`) и `back/src/backend/permission.test.ts`
    «15 (D.8)». После перехода на Bun — замер времени ответа `back` и 10 полных
    прогонов подряд при нагрузке; краснеют — вопрос владельцу (предел ожидания
    дополнения — поведение для пользователя).

## Зависимости — разрешены владельцем 2026-10-07

| Пакет | Зачем | Основание |
|---|---|---|
| `@hono/node-server` | сервер Hono на `node:http` | проба: одинаково под тремя |
| `ws` | WebSocket сервера строк | проба: одинаково под тремя |
| `socks-proxy-agent` | прокси `socks5`/`socks5h` для Bot API (обещание `telegram-log.md`) | решение владельца 2026-10-07 |
| `https-proxy-agent` | прокси для `node:https` | проба: одинаково под тремя; `undici` под Bun ломается |
| `@mtcute/node`, `@mtcute/convert`, `@mtcute/markdown-parser`, `@mtcute/wasm` (npm) | MTProto | проба: соединение под тремя |
| `proper-lockfile` | блокировка ротации журнала вызовов вместо `Deno.FsFile.lock` (flock нет в Node) | решение владельца 2026-10-07 |
| `@types/node` | типы `node:*` для `tsc` | — |
| `@biomejs/biome` | формат и линт (решено) | — |

## Инварианты

- Наблюдаемое поведение команд, хуков, MCP и бинарей не меняется (кроме
  прокси окружения под Node — [S.9]).
- Прод не трогается; живые проверки — хост.

## Границы

- Вынос библиотек в `tslibs/` — этап 4.
- Самоописание `about`, конверт, XState, снятие языка — этап 6.

## Пункты чек-листа

`design.md`: 1 примитивы — замены по таблице опиcи, один путь HTTP; 2 особые
случаи — прокси есть/нет, SIMD есть/нет — реализации; 3–6 — по design-артефактам
порций; 7 основание проверкой — [S.2], [S.4], [S.7]. `design-mpu.md`: 6 права
Deno — уходят в E4 вместе с `deno compile`; 8 внешнее — окружение и файлы —
параметрами; прочее — ничего.
