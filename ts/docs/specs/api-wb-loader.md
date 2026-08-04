# mpu api wb-loader-*

Статус: черновик

## Назначение

Три частотные команды управления загрузчиками wb-loader-app через admin-прокси
sl-back (обвязка — `platform/slback-http.md`, контракт неймспейса — `api.md`):
`wb-loader-blocked` — блокировки по всей ферме; `wb-loader-status` — состояние
одного загрузчика (read-only); `wb-loader-resume` — показать/снять (мутация).

## CLI-контракт

### Загрузчики и причины блокировок

Загрузчик (`Loader`) — per-sid конечный автомат wb-loader-app; ровно 25,
список закрыт. Формы имени: camelCase (`LoaderName`) — фильтры blocked/resume;
kebab-слаг (`LoaderEntity`) — сегмент URL для status; слаг = имя без префикса
`wb`, слова через дефис в нижнем регистре (`wbAdvFullstats` →
`adv-fullstats`). Имена, в порядке реестра: wbCards, wbOrders, wbSales,
wbReports, wbAnalytics, wbFeedbacks, wbAdvertsDetailed, wbSearchTexts,
wbSupplies, wbAnalyticsStocks, wbAcceptanceReports, wbPrices, wbPaidStorage,
wbSellerInfo, wbAdvBudget, wbFbsWarehouses, wbFbsStocks, wbAdvUpd,
wbAdvFullstats, wbAdvNormqueryStats, wbAdvNormqueryStatsByDates,
wbSearchClustersBids, wbTariffsBox, wbTariffsPallet, wbTariffsCommissions.

Причины (`BlockedReason`), закрытый список, порядок реестра. Operational
(восстанавливаются сами): no_token, cards_not_loaded, cards_filter_not_ready,
adverts_detailed_not_loaded, fbs_warehouses_not_loaded, feature_disabled,
endpoint_forbidden. Permanent (нужен resume): invalid_token, payment_required,
response_parse_error, dto_mapping_error, db_write_error, unexpected_http_status,
network_error, paid_storage_recreate_limit, not_using, unknown_error.

Неизвестный loader → exit 2 `неизвестный loader '<значение>'`; подсказка:
другая форма той же сущности → `используй kebab-слаг: <слаг>` / `используй
camelCase-имя: <имя>`, иначе `один из: <допустимые через запятую+пробел>`
(camelCase — порядок реестра, kebab — по алфавиту). Неизвестный reason →
exit 2 `неизвестный reason '<значение>'`, подсказка `один из: <17 причин>`.
Валидация локальная, до сети; `--help` каждой команды включает
справку-приложение (карта форм, группы причин, сценарий разлока).

### Резолв цели (status, resume)

- Прямой sid-режим (`DirectSID`): задан `--sid` ИЛИ селектор сам — полный WB
  sid (UUID-форма: hex-группы 8-4-4-4-12); sid берётся как есть, резолв
  клиента не выполняется, наличие sid в кэше не требуется.
- Иначе — резолв по локальному кэшу (`platform/selector.md`, без сети):
  client_id + его sid (значения `sids` кандидатов, дедуп, порядок сохранён).
  Выбор одного sid: названный селектором (точно, иначе однозначная
  подстрока) → единственный → ошибка: ноль → exit 2 `не удалось определить
  sid клиента (кэш пуст?)`, подсказка `укажи --sid <sid> или обнови кэш: mpu
  update`; несколько → exit 2 `у клиента несколько WB sid (<n>)`, подсказка
  `укажи --sid <sid>`, следом строки `  --sid <sid>`.
- Ошибка базового резолва → exit 2: её текст, подсказка `уточни селектор или
  передай --client-id <id>`, кандидаты; неоднозначный client_id → exit 2
  `не удалось однозначно определить client_id из '<селектор>'`, подсказка
  `передай --client-id <id> (или селектор клиента, не sl-N)`.
- `client_id` в stdout-JSON: число (однозначен) / массив чисел по
  возрастанию (у sid несколько клиентов в кэше) / null (ни одного). В прямом
  режиме — из `--client-id`, иначе best-effort обратный поиск по кэшу (сбой —
  пусто, не ошибка). В stderr — числа через запятую либо `?`.

### mpu api wb-loader-blocked

`wb-loader-blocked [--loader ИМЯ] [--reason ПРИЧИНА] [--only-permanent]
[--sid SID] [--server wb-N] [--print/-p]`

- `POST /admin/wb-loader/blocked-loaders/v1/find`, тело `{"filter": {…}}`; в
  filter — только заданные `sid`, `loader` (camelCase), `reason`,
  `only_permanent: true`; пустой `{}` — вся ферма. Ответ — JSON-объект; `data`
  и `errors` — массивы (отсутствующие → пустые); элемент с непустым строковым
  `server` (`wb-N`/`wb-main`) принадлежит инстансу, без него — вне подсчётов.
- `--server` — клиентский постфильтр: `data` и `errors` фильтруются по
  равенству `server` после ответа; в тело запроса не входит.
- Кэш wb-серверов (`WbServersCache`,
  `$XDG_CONFIG_HOME/mpu/.wb-loader-servers.json`): после каждого успешного
  сетевого вызова перезаписывается отсортированным JSON-массивом уникальных
  `server` полного (до фильтра) ответа (data + errors); атомарная запись,
  best-effort; пустое множество файл не трогает; нужен автодополнению.
- stderr: `# <N> blocked loader(s) across <M> server(s); <K> server error(s)`
  (+ ` (filtered by server=<значение>)` при `--server`); N/K — размеры
  отфильтрованных массивов, M — различные `server` отфильтрованного `data`
  (errors не входят). stdout: `{"data": […], "errors": […]}` после фильтра.
- HTTP 403 → exit 1 `find запрещён (HTTP 403)`, подсказка `у TOKEN_EMAIL
  должна быть роль support_read или выше`; прочий сбой запроса → exit 1
  `find не удался: <ошибка>`; тело ответа — extra-строкой.

### mpu api wb-loader-status

`wb-loader-status SELECTOR LOADER [--sid SID] [--client-id ID] [--print/-p]`
— read-only; LOADER — kebab-слаг.

- `GET /admin/wb-loader/loaders/<sid>/<loader>/v1/status`; подстановки в путь
  URL-экранируются; ответ не валидируется (любой JSON).
- stderr `# client <cid> sid <sid> loader <loader>`; stdout
  `{"client_id": …, "sid": "…", "loader": "…", "status": <ответ>}`.
- Сбой запроса → exit 1 `status не удался: <ошибка>` + extra.

### mpu api wb-loader-resume

`wb-loader-resume SELECTOR [LOADER] [--sid SID] [--all] [--client-id ID]
[--print/-p]` — LOADER camelCase; `--all` вместе с LOADER → exit 2
`--all и позиционный loader взаимоисключающи`, подсказка `оставь что-то одно`.

- SHOW-режим (нет LOADER и нет `--all`) — read-only: по каждому целевому sid
  `POST /admin/wb-loader/blocked-loaders/v1/find`, тело
  `{"filter": {"sid": "<sid>"}}` → `data` = блокировки; resume не вызывается.
  Целевые sid: прямой режим — один; клиент с несколькими sid, из которых
  селектор не называет ни один, — все sid клиента (не ошибка); иначе один.
  Один sid: stderr `# client <cid> sid <sid>: <n> blocked loader(s)`, stdout
  `{"client_id": …, "sid": "…", "blocked": […]}`; несколько: stderr `# client
  <cid>: <всего> blocked loader(s) across <k> sid`, stdout `{"client_id": …,
  "sids": [{"sid": "…", "blocked": […]}, …]}`.
- MUTATE-режим (LOADER или `--all`): ровно один целевой sid;
  `POST /admin/wb-loader/blocked-loaders/v1/resume`, тело `{"filter":
  {"sid": "<sid>"[, "loader": "<имя>"]}}` — `loader` отсутствует при `--all`;
  ответ обязан быть JSON-объектом (`{resumed, items}`). stderr `# client
  <cid> sid <sid>: resumed <resumed>`; stdout `{"client_id": …, "sid": "…",
  "filter": {…}, "result": {…}}`. HTTP 403 → exit 1 `resume запрещён (HTTP
  403)`, подсказка `у TOKEN_EMAIL должна быть роль support_write или выше`;
  прочий сбой → exit 1 `resume не удался: <ошибка>`; тело — extra.
- `operator` в тело не кладётся: sl-back подставляет его из сессии
  `TOKEN_EMAIL`; клиент подделать его не может.

### --print/-p (все три команды)

Печатает curl-сниппет (`CurlSnippet`) в stdout и копирует в системный буфер
(best-effort): строка `TOKEN=$(mpu api get-token)`, затем `curl -sS -X
<METHOD> "<база><путь>" -H "authorization: Bearer $TOKEN"`
(+ ` -H 'content-type: application/json' -d '<тело>'` при теле). Сети и записи
файлов нет; резолв селектора/sid — по локальному кэшу; из env нужен только
базовый URL (нет → exit 1 с его ошибкой). blocked: тело `{"filter": …}` без
`--server`; при `--server` — строка `# затем клиентский фильтр: .data[] |
select(.server == "<значение>")`. status: curl GET без `-d`. resume: SHOW →
curl на find по каждому целевому sid; MUTATE → curl на resume.

## Ввод/вывод

stdout — JSON (indent 2, unicode как есть); stderr — строки-резюме с
префиксом `# ` и ошибки `mpu api <команда>: <причина>[; попробуй:
<подсказка>]` (+ extra-строка). Exit: 0 — успех (и пустые результаты); 2 —
ввод/резолв; 1 — сеть, HTTP-ошибки, невалидная форма ответа, отсутствие env.

## Побочные эффекты

find (blocked, resume-SHOW) и status — чтение прод-состояния wb-loader-app;
resume-MUTATE — реальная прод-мутация (роль support_write). Файлы: токен-кэш
(`platform/slback-http.md`); кэш wb-серверов — только `wb-loader-blocked` без
`--print`. `--print` — только stdout и буфер обмена.

## Конфигурация

Env — целиком `platform/slback-http.md`; своих env-переменных нет. Файлы
состояния — под `$XDG_CONFIG_HOME/mpu/`. Кэш клиентов/sid —
`platform/selector.md` (наполняется `mpu search` / `mpu update`).

## Инварианты

- Валидация loader/reason/конфликта флагов — строго до сети; `--server`
  никогда не попадает в тело запроса.
- Кэш wb-серверов пишется из полного ответа до фильтра и только при успешном
  сетевом вызове; его сбой не влияет на результат.
- SHOW-режим resume не выполняет мутирующих запросов ни при каких входах;
  `--print` не выполняет ничего; перепутанная форма имени загрузчика всегда
  даёт подсказку с правильной.

## Граничные случаи и ошибки

- `--server` без совпадений → `{"data": [], "errors": []}`, stderr
  `# 0 blocked loader(s) across 0 server(s); …`, exit 0.
- resume-SHOW: клиент с 3 sid, ни один не назван → три find, все в одном
  ответе (`sids`); `--sid` вне кэша → запрос уходит как есть, `client_id` = null.
- Ответ find не объект (в т.ч. пустое тело 2xx) → exit 1 `find response:
  ожидался JSON-объект…`; `data`/`errors` не массив → exit 1 `find.data: …` /
  `find.errors: ожидался JSON-массив…`; resume — `resume response: ожидался
  JSON-объект…` (хвост — тип полученного значения, обозначение свободно).

## Golden-примеры

Кандидаты (снять при переводе в «к реализации»; `--print` и ошибки ввода —
без сети, sid — синтетический UUID): `--help` всех трёх; `wb-loader-blocked
--print` (пустой фильтр); `wb-loader-blocked --loader wbCards --reason
unknown_error --only-permanent --sid <uuid> --server wb-3 --print` (сборка
фильтра + комментарий постфильтра); `wb-loader-status <uuid> cards --print`
(curl GET прямого режима); `wb-loader-resume <uuid> --print` и `… wbCards
--print` (SHOW- и MUTATE-curl); `wb-loader-status <uuid> wbCards` (ошибка
формы, exit 2); `wb-loader-resume <uuid> wbCards --all` (конфликт, exit 2).

## Известные отклонения

- **fix** — `client_id` в stdout-JSON `wb-loader-status` — строка
  (`"123"`/`"?"`), в прямом режиме без `--client-id` кэш не спрашивается; у
  `wb-loader-resume` то же поле — число / массив / null. Правильное
  поведение — единый контракт раздела «Резолв цели» у обеих команд.

## Открытые вопросы

- Реакция sl-back на `--only-permanent` вместе с operational-`--reason` не
  наблюдалась (тело валидирует серверная схема, локальной проверки нет);
  зафиксировать при переводе спеки в «к реализации».
