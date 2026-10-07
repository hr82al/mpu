# Порция T1 — Telegram (MTProto и Bot API) библиотекой `tslibs/telegram`

Статус: к реализации после H1 (2026-10-07). Клиент уже на `@mtcute/node`, криптография — модулем `wasm_modules.ts`, тесты на Vitest (порция E3) — T1 выносит домен в пакет `tslibs/telegram`, зависящий от `@mpu/http`. Гибрид владельца 2026-10-07: TS-домены — пакеты в монолите.
H1 (`@mpu/http`). Договор пакета — `platform/tslibs-package.md`; поведение
команд — `platform/telegram-mtproto.md` и спеки `telegram-*` (не меняется).
План — этапы 3 и 4 одной порцией: домен уходит с `Deno.*` и выносится.

## Кто и зачем

Разработчик хочет, чтобы разговор с Telegram — сеанс MTProto от личного
аккаунта и вызовы Bot API — был библиотекой без привязки к рантайму, а команды
`mpu telegram …`, хук уведомлений и вопросы бота в `ts/` брали её архивом.

## Основания (пробы хоста 2026-10-07, `mp/tmp/stage2-probes`)

- `@mtcute/node@0.31.0` с хранилищем в памяти, `@mtcute/convert`,
  `@mtcute/markdown-parser` — соединение с Telegram под Node, Bun, Deno.
- Криптография: `NodeCryptoProvider` из `@mtcute/node/utils.js`, у которого
  `initialize` подменён на `initSync(байты)`; байты wasm (`mtcute-simd.wasm`,
  `mtcute.wasm` из `@mtcute/wasm`) — модулем, который генерирует сборка
  библиотеки. Проверено под тремя и в бинаре `bun build --compile`; без этого
  бинарь падает «Cannot find module '@mtcute/wasm/mtcute-simd.wasm'».
- Сеть Bot API — через `@mpu/http`.

## Граница (наблюдаемая)

Библиотека отвечает на то, что нужно командам от Telegram: открыть сеанс по
настройкам (строка сессии, `apiId`, `apiHash`, прокси), узнать себя, найти
адресата, отправить текст и файл, список диалогов, поиск, скачать вложение,
шаги входа, вызов метода Bot API. Всё, что зависит от слоя команд `mpu`
(`back/src/command/`, справка, ключи, печать, `kiten`, `kaiten`, `picture`), —
в `ts/`. Раскладку файлов и распутывание (сегодня `session.ts` импортирует
`cmd_file.ts`, а `errors.ts` — слой команд) проектирует исполнитель —
`.tmp/design-T1.md` до кода.

Факты распутывания (снято с `main` до E3, 2026-10-07; пересверить на `main` перед порцией): без зависимостей от слоя
команд — `chat`, `client`, `crypto`, `inbox`, `lookup`, `markdown`,
`media_file`, `message`, `message_file`, `peer`, `platform`, `search_reply`,
`send`, `search` (через `resolve`, `search_plan`); с зависимостью —
`errors`, `config`, `connection`, `client_refusal`, `resolve`, `search_plan`,
`plan`, `login`, `bot_config`, `session` (через `cmd_file`, `config`).

## Сценарии [S.n]

1. `tslibs/telegram`: `bun install && bun run gate` → зелёно под Bun, Node,
   Deno; `release/mpu-telegram-0.1.0.tgz` закоммичен; зависимость
   `"@mpu/http": "file:../http/release/mpu-http-<версия>.tgz"`.
2. Тесты переехавших модулей — в библиотеке; тесты команд — в `ts/`. Список
   листовых случаев `back/src/telegram` до = объединение списков после
   (библиотека + `ts/`), строка в строку.
3. `rg -n 'Deno\.|Bun\.' tslibs/telegram/src` → пусто; в `ts/` — ни одного
   импорта `@mtcute/*`, `deno.jsonc` без записей `@mtcute/*`.
4. `ts/package.json` → `"@mpu/telegram": "file:../tslibs/telegram/release/mpu-telegram-0.1.0.tgz"`;
   гейты `ts/` зелёные, `deno task smoke` зелёный.
5. Голдены команд `telegram send|ls|search|status|log|file|login` в `ts/` —
   без изменений и зелёные.
6. Бинарь `bun build --compile` пробного входа библиотеки (в её тестах или
   скрипте сборки) открывает криптографию без сети и без файла wasm рядом:
   `initSync` проходит, ошибки «Cannot find module» нет.
7. Отказ клиента Telegram (неверная сессия, `FLOOD_WAIT`, адресат не найден)
   — прежний текст отказа команды дословно (существующие голдены).
8. Секреты (строка сессии, `apiHash`, токен бота) не появляются ни в выводе,
   ни в тексте ошибки, ни в журнале — существующие тесты зелёные.
9. Живьём (хост после установки): `mpu telegram ls limit: 3`,
   `mpu telegram send chat: me text: проба-T1`, `mpu telegram search
   query: проба-T1` — вывод той же формы, что до порции; бот вопросов
   (`claude-hook`) шлёт сообщение в чат.

## Инварианты

- Наблюдаемое поведение команд не меняется.
- Библиотека не знает о слое команд `mpu`: ни импорта из `ts/`, ни текстов
  справки и ключей.

## Границы

- Самоописание `about`, конверт — этап 6.
- `botquestions` (ряд вопросов, XState) остаётся в `ts/`; берёт из
  библиотеки только вызов Bot API.
- Команды `mpu telegram` переписываются только импортами и вызовами
  поверхности библиотеки.

## Пункты чек-листа

`design.md`: 1 примитивы — сеанс (открыть, вызвать, закрыть) и вызов Bot API;
прочие операции выведены из них в библиотеке; 2 особые случаи — прокси есть /
нет, SIMD есть / нет — реализации, не ветки у вызывающего; 3–6 — по
design-T1 исполнителя; 7 основание проверкой — [S.2], [S.6]. `design-mpu.md`:
4 один источник — правила Bot API и конфигурации бота в одном месте
(библиотека); 7 границы модулей — `index.ts`; 8 внешнее — окружение и файлы
— параметрами; прочее — ничего.
