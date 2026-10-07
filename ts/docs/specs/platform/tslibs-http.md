# Порция H1 — транспорт HTTP библиотекой `tslibs/http`

Статус: черновик (2026-10-07) — после этапа 3: потребитель `ts/` уже на Bun (решение владельца 2026-10-07, план «Порядок этапов»).
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
   (договор пакета [S.1]–[S.4]); `release/mpu-http-0.1.0.tgz` закоммичен.
2. Тесты `back/src/http/*.test.ts` переехали в библиотеку; список листовых
   случаев до (в `ts/`) и после (в библиотеке) совпадает строка в строку.
3. В `ts/`: `rg -l 'http/mod\.ts' back cli mcp supervisor complete` → пусто;
   22 потребителя (список ниже) импортируют `@mpu/http`; `back/src/http/`
   удалён.
4. `ts/package.json` → `"@mpu/http": "file:../tslibs/http/release/mpu-http-0.1.0.tgz"`;
   `bun install` в `ts/` ставит архив штатно.
5. Гейты `ts/` (после этапа 3 — на Bun) зелёные, smoke собранного бинаря
   зелёный.
6. Вызов с явным прокси `http://127.0.0.1:<порт>` (локальный CONNECT-прокси
   в тесте) на `https://example.test/x` → прокси получил `CONNECT
   example.test:443`, ответ сервера дошёл; одинаково под тремя рантаймами.
7. Без явного прокси, `HTTPS_PROXY=http://127.0.0.1:<порт>` в окружении,
   адрес не из `NO_PROXY` → вызов идёт через прокси; адрес стенда
   (`isStandHost`) или из `NO_PROXY` → напрямую. Одинаково под тремя.
8. Пределы времени и отмена (`HEADERS_TIMEOUT_MS` 3000, `TOTAL_TIMEOUT_MS`
   10000, `signal`) — прежние тексты отказа дословно (существующие тесты).
9. Учётные данные в адресе прокси не попадают ни в текст ошибки, ни в журнал
   (`withoutCredentials`) — существующие тесты зелёные.
10. Живьём (хост после установки): `mpu kiten card id: <номер>`,
    `mpu telegram status dry` — тот же вывод, что до порции.

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
