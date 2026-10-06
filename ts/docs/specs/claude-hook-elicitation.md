# mpu claude-hook elicitation

Статус: реализовано — порция R3; принято 2026-10-06 хостом. (серия R, порция R3; постановка —
`telegram-relay-r3-statement.md`, сценарии `[S.n]`)

## Назначение

Claude Code перед показом формы MCP-сервера зовёт хук `Elicitation`; пока хук
работает, терминальная форма **закрыта** (снято 2026-10-06: «running
Elicitation hook»). Команда задаёт форму владельцу в Telegram и отдаёт
Claude Code ответ; кнопка `В терминале` отпускает форму в терминал.

## CLI-контракт

```
mpu claude-hook elicitation
```

Как у прочих строк-хуков (`claude-hook-permission-request.md`): вход —
stdin, исполняет ядро, посев `allow` строкой `platform/policy.md`, тулом MCP
не публикуется, код всегда 0 (строка — в общем списке строк-хуков клиента),
ожидание — вне предела строк, срок 3540 с при сроке хука 3600 с.

## Ввод

Живые payload'ы — `fixtures/telegram-relay/r3/live-elicitation-mpu.json` (форма mpu, без полей) и `live-elicitation-fields.json` (форма с полями `enum` + `enumNames`, `boolean`, `string`, `integer`, `required`; снято 2026-10-06):
`mcp_server_name`, `message`, `mode` (`form` | `url`), `requested_schema`.

| Случай | Поведение |
|---|---|
| stdin не JSON-объект / нет `mcp_server_name` или `message` | без решения: `вход не разобран: …` |
| `mcp_server_name` = `mpu` | без решения сразу, причина `форма mpu — вопрос уже в чате` [S13] (`platform/ask-telegram.md`) |
| `mode` = `url` | без решения; в чат — уведомление без кнопок `📝 <сервер>` / `<message>` / `<url, если есть в payload>` [S14] |
| `mode` = `form` | вопрос (ниже) |

## Форма → вопрос

- Заголовок: `📝 <mcp_server_name>` + «откуда» (сессия, проект, окно — как
  R1b); вид — срочный.
- Схема без свойств → один шаг: текст `message`, кнопки `Accept` ·
  `Decline` / `В терминале` [S9].
- Свойства — по шагу на свойство, в порядке схемы; текст шага —
  `<message>` на первом, далее `<title или имя свойства>`:
  - `boolean` → `Да` / `Нет`;
  - `string` с `enum` → кнопки значений (подписи — `enumNames`, если есть);
  - обязательность — из `required`: необязательное поле на своём шаге
    получает кнопку `Пропустить` (значение не передаётся);
  - `string`, `number`, `integer` без `enum` → свой текст (число — разбор,
    не число → `нужно число`, шаг остаётся);
  - иной тип (объект, массив) → вся форма: только `Decline` / `В терминале`.
- На каждом шаге есть `Decline` и `В терминале`.

## Ответ → решение

| Исход | stdout |
|---|---|
| все шаги отвечены | `{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"accept","content":{<имя>:<значение>,…}}}` (снято: сервер получил `{"action":"accept","content":{"env":"dev","force":false,"note":"из хука","count":2}}` дословно — `live-elicitation-accept-delivered.json`) |
| `Accept` (форма без полей) | `{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"accept","content":{}}}` |
| `Decline` | `{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"decline"}}` |
| `В терминале` | stdout пуст, stderr `mpu claude-hook elicitation: без решения — ответ в терминале`; сообщение `↪ ответ в терминале` [S12] |
| срок, обрыв, бот недоступен | без решения, причины как у `permission-request` |

Значения: `boolean` — `true`/`false`; число — числом; строка — как есть.

## Установка

`install.sh` — запись `{"matcher":"","hooks":[{"type":"command","command":"mpu claude-hook elicitation","timeout":3600}]}`
в `hooks.Elicitation`, по правилам R1 (вывод `install: claude хук
elicitation: вписано` / `без изменений`). Голден —
`fixtures/telegram-relay/r3/settings-fragment-elicitation.json`.

## Инварианты

- Без ответа владельца — без решения (форма остаётся за терминалом).
- Форма mpu не задаётся дважды.

## Пункты чек-листа

`design.md`: 2 — вид поля схемы (boolean / enum / текст / прочее) — своя
реализация шага, не ветка; 3 — неизвестный тип — объект «только отказ или
терминал»; 7 — «хук держит форму закрытой» — снято живьём.
`design-mpu.md`: 4 — срок из одной константы с R1b; 9 — payload'ы сняты (форма
mpu и форма с полями), доставка `accept` с `content` до сервера — снята.
