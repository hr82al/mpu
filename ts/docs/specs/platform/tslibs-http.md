# Порция H1 — транспорт HTTP библиотекой `tslibs/http`

Статус: к реализации после E4 (2026-10-07). Транспорт уже на `node:http(s)` с прокси (порция E3, `platform/node-runtime.md` [S.9], `back/src/http/route.ts`) — H1 только выносит готовый модуль в пакет; `ts/` к этому моменту на Bun и ставит архив `file:…tgz` штатно. Гибрид владельца 2026-10-07: TS-домены — пакеты `tslibs/<домен>` в монолите.
Договор пакета — `platform/tslibs-package.md`; транспорт — `platform/loki-http.md`
(поведение не меняется, кроме [S.6]–[S.8]). План — этап 4, первая библиотека:
`http` нужен Kaiten, GitLab, Loki, Portainer, Sheets, sl-back, Telegram,
вопросам бота — это основа остальных доменов.

## Кто и зачем

Разработчик хочет, чтобы транспорт HTTP был отдельной библиотекой без привязки
к рантайму, а 22 потребителя в `ts/` брали его архивом.

## Основания (пробы хоста 2026-10-07, `mp/tmp/stage2-probes`)

- `node:https` + `https-proxy-agent@7.0.6` через локальный CONNECT-прокси →
  `200` под Node 24.21, Bun 1.4.2, Deno 2.9.7, туннель открыт.
- `undici` + `ProxyAgent` под Bun ломается (Bun подменяет `undici` своим) —
  не годится.
- Сейчас путь `fetch` берёт прокси через `Deno.createHttpClient`, а прокси
  окружения `fetch` понимают по-разному: Deno и Bun читают `HTTPS_PROXY`, Node
  — нет. Отсюда один путь на `node:http`/`node:https` для всех вызовов.

## Сценарии [S.n]

1. `tslibs/http`: `bun install && bun run gate` → зелёно под Bun, Node, Deno
   (договор пакета [S.1]–[S.4]); `release/mpu-http-0.1.0.tgz` закоммичен, в нём
   только `package/package.json` и `package/dist/…`.
2. Тесты `back/src/http/*.test.ts` (`credentials`, `multipart`, `proxy`,
   `redirect`, `signal`, `stand`) переехали в библиотеку; список листовых
   случаев до (в `ts/`) = после (в библиотеке), строка в строку.
3. В `ts/`: `rg -l 'http/mod\.ts' back cli mcp supervisor complete` → пусто;
   все потребители (список ниже, на 2026-10-07 — 24 файла) импортируют
   `@mpu/http`; `back/src/http/` удалён.
4. `ts/package.json` → `"@mpu/http": "file:../tslibs/http/release/mpu-http-0.1.0.tgz"`;
   `bun install` в `ts/` ставит архив штатно.
5. Гейты `ts/` (на Bun после E4) зелёные; smoke собранных бинарей зелёный.
6. Поведение транспорта не меняется: прокси явный → окружение → напрямую,
   socks5, редиректы как у `fetch`, пределы времени, маска учётных данных —
   существующие тесты зелёные в библиотеке.
7. Живьём (хост после установки): `mpu kiten card --id <номер>` (или старой
   формой, пока диспетчер не переведён), `mpu telegram status dry` — тот же
   вывод, что до порции.

## Потребители в `ts/` (снято с `main` 2026-10-07)

`botquestions/bot_api.ts`, `exec/portainer.ts`, `gitlab/http.ts`,
`health/run.ts`, `init/cmd_init.ts` (+ тест), `kaiten/cards.ts`,
`kaiten/http.ts`, `kaiten/warmup.ts`, `loki/mod.ts`, `portainer/mod.ts` (+ тест),
`ps/run.ts`, `search/x10_http.ts`, `sheet/webapp.ts`, `slback/client.ts`,
`telegram/bot_call.ts`, `telegram/bot_config.ts`, `telegram/bot.ts`,
`telegram/connection.ts`, `telegram/login.ts`, `telegram/proxy.ts`,
`update/cmd_update.ts`, `update/sync.ts` (пути от `back/src/`).

## Инварианты

- Ни `Deno.*`, ни `Bun.*`, ни `fetch` с параметрами рантайма в библиотеке.
- Поведение для потребителя прежнее, кроме прокси окружения под Node ([S.7]).

## Границы

- Самоописание `about` — этап 6.
- Код потребителей меняется только строкой импорта (и `bot_config.ts` —
  список схем прокси, если он завязан на `Deno.createHttpClient`).

## Пункты чек-листа

`design.md`: 1 примитивы — один запрос через `node:http(s)` с агентом;
`httpGet`/`httpGetBytes`/`httpSend` выведены из него; 2 особые случаи — прямой
вызов и вызов через прокси — агент или его отсутствие (одна реализация на
вид), не ветка по рантайму; 3 — `Deno.HttpClient | undefined` уходит вместе с
путём `fetch`; 4–6 — ничего; 7 основание проверкой — [S.6], [S.7] на локальном
прокси. `design-mpu.md`: 4 один источник — выбор прокси в одном месте
(явный → окружение → напрямую); 8 внешнее — окружение передаётся
параметром, не читается по месту; прочее — ничего.
