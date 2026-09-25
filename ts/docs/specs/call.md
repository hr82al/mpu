# mpu ozon call · mpu wb call (и `call-ro`)

Статус: к реализации — три порции по получателям (после серии task), решения хоста
2026-09-25 ниже:

- **173a — `ozon call-ro` / `ozon call`** (Seller) и всё общее: реестр
  чтения, ключ кабинета из БД клиента, маскирование, `dry`, `end json`,
  журнал без тела ответа, право сети на `api-seller.ozon.ru`;
- **173b — `ozon perf call-ro` / `ozon perf call`**: OAuth
  `client_credentials`, токен в памяти сервера до истечения;
- **173c — `wb call-ro` / `wb call`**: таблица хостов и категорий, отбор
  токена из `public.wb_tokens`, `read_only` у `call-ro`.

Перед постановкой каждой — сценарии её получателя литералами (строка
вызова, stdout, stderr, код), как требует `checklists/statement-mpu.md` 1;
таблица «Граничные случаи» ниже — перечень, а не литералы.

## Назначение

Вызов API маркетплейса (Ozon Seller, Ozon Performance, Wildberries) под ключом
кабинета клиента **без выдачи ключа вызывающему**. Ключ находит и подставляет
сервер `mpu`, как уже находит креды PG для `sql-ro`: агент и человек передают
только кабинет, ручку и тело, а получают статус, заголовки квоты и тело ответа.

Зачем. Живые вопросы к API («что сейчас отдаёт ручка», «сколько квоты у
кабинета», «какой `Retry-After` приходит») сейчас требуют либо ключ в руках,
либо разовый скрипт, который читает ключ из БД клиента. Первое — утечка секрета
в контекст, второе закрывается политикой прав среды как добыча кредов.
Прецеденты обоих путей — проба квоты `/v1/finance/products/buyout` 25.09.2026:
ключ не должен был попасть ни в контекст агента, ни в аргументы процессов, и для
этого человеку пришлось запускать скрипт самому.

Две команды по правилу разделения чтения и записи (как `sql` / `sql-ro`):

- `call-ro` — только ручки из реестра чтения, политика `ro`, посев `allow`;
- `call` — любая ручка известного хоста, политика `rw`, посев `ask`.

## CLI-контракт

```
mpu ozon call-ro      target: <клиент> [cabinet: <Client-Id>] path: <путь> [body: <json>] [method: GET|POST] [timeout: <сек>] [end json]
mpu ozon perf call-ro target: <клиент> [cabinet: <Client-Id>] path: <путь> [body: <json>] [method: …] [timeout: …]
mpu wb call-ro        target: <клиент|sid> [cabinet: <sid>] url: <https://…> [body: <json>] [method: …] [timeout: …]
mpu ask ozon call …   (те же ключи; запись — через дверь `ask`; так же `ozon perf call`, `wb call`)
mpu ozon call-ro dry  … (печать запроса без секретов, без выхода в сеть)
```

Порядок слов — по грамматике строки: получатель-маркетплейс (`ozon`,
`ozon perf`, `wb`) → сообщение (`call-ro` | `call`) → варианты (`dry`) →
ключи → `end` → формат. Маркетплейс — объект, `call` — его сообщение
(решение владельца 2026-09-25, «решает получатель»): хост, авторизацию,
источник ключа, ключ адреса (`path:` против `url:`), заголовки квоты и
реестр чтения знает сам маркетплейс; следующие его сообщения (`ozon quota`,
`ozon endpoints`, `wb tokens`) — новые сообщения того же объекта, а не
команды-глаголы с развилкой по маркетплейсу внутри [D.1]. Ozon Performance —
отдельный получатель `ozon perf` (другой хост и OAuth `client_credentials`), а
не вариант `perf`: вариант, меняющий хост и авторизацию, — флаг поведения.
Путь правила — `ozon call-ro`, `ozon call`, `ozon perf call-ro`, `ozon perf
call`, `wb call-ro`, `wb call`: вариант путь правила не меняет
(`platform/variants.md`), поэтому чтение и запись — два сообщения, а не
вариант. Имена `ozon` и `wb` на корне свободны (снято 2026-09-25: `mpu ozon`
→ `mpu: не понимает ozon`); группы `ozon-loader`, `ozon-jobs`, `wb-loader`,
`wb-jobs` порция не трогает.

Ключи:

| Ключ | У кого | Обязателен | Смысл |
|---|---|---|---|
| `target:` | все | да | селектор клиента по `platform/selector.md`; у WB допустим sid кабинета — он и так резолвится в клиента |
| `cabinet:` | все | если у клиента больше одного кабинета | Ozon — `seller_client_id`; WB — sid. Один кабинет у клиента — ключ можно опустить |
| `path:` | `ozon`, `ozon perf` | да | путь ручки, начинается с `/`; хост задан получателем: `ozon` — `api-seller.ozon.ru`, `ozon perf` — `api-performance.ozon.ru` |
| `url:` | `wb` | да | полный адрес с запросом; хост обязан быть в таблице хостов WB (ниже) |
| `body:` | все | нет | JSON-текст тела. Ozon Seller без `body:` шлёт `{}` |
| `method:` | все | нет | `GET` или `POST`. По умолчанию: `ozon` — `POST`; `ozon perf` и `wb` — `POST` при заданном `body:`, иначе `GET` |
| `timeout:` | все | нет | секунды, по умолчанию 60, не больше 300 |

Вариант: `dry` (печать запроса со скрытыми секретами, без сети и без чтения ключа сверх
проверки, что он есть).

Таблица хостов WB → категория токена (по `sl-back/src/wb/wbFetchNew/wbFetchNew.constants.js`):

| Хост | Категория |
|---|---|
| `content-api.wildberries.ru` | `content` |
| `statistics-api.wildberries.ru` | `statistics` |
| `finance-api.wildberries.ru` | `finance` |
| `seller-analytics-api.wildberries.ru` | `analytics` |
| `advert-api.wildberries.ru` | `adverts` |
| `marketplace-api.wildberries.ru` | `marketplace` |
| `discounts-prices-api.wildberries.ru` | `prices` |
| `supplies-api.wildberries.ru` | `supplies` |
| `feedbacks-api.wildberries.ru` | `questions` |
| `documents-api.wildberries.ru` | `documents` |
| `common-api.wildberries.ru` | любая |

## Ввод/вывод

Без формата — текст. Первая строка — `HTTP <статус> <МЕТОД> <хост><путь>`,
затем по строке на каждый присланный заголовок квоты (имя в нижнем регистре,
как пришло): у Ozon `ratelimit-remaining`, `retry-after`; у WB
`x-ratelimit-remaining`, `x-ratelimit-retry`, `x-ratelimit-limit`,
`x-ratelimit-reset`, `retry-after`. Затем пустая строка и тело: JSON — с
отступами, иначе как есть.

`end json` — одна строка:

```json
{"status":429,"method":"POST","url":"https://api-seller.ozon.ru/v1/finance/products/buyout","ms":402,"headers":{"ratelimit-remaining":"0","retry-after":"1"},"body":{"code":8,"message":"You have reached request rate limit per second"}}
```

`body` — разобранный JSON или строка, если ответ не JSON; `headers` — только
заголовки квоты.

Коды выхода:

| Код | Когда |
|---|---|
| 0 | маркетплейс ответил 2xx |
| 1 | маркетплейс ответил не 2xx (тело и заголовки всё равно печатаются), таймаут, сетевая ошибка |
| 2 | ошибка ввода или конфигурации: нет кабинета, кабинетов больше одного без `cabinet:`, хост не из таблицы, ручки нет в реестре чтения (`call-ro`), нет токена нужной категории, `body:` — не JSON, `timeout:` вне 1…300 |

Отказы (stderr, код 2), полный набор:

```
mpu ozon call-ro: у клиента 54 кабинетов Ozon 3 — укажи cabinet: 2129958 | 1539401 | 870282
mpu ozon call-ro: у клиента 54 нет кабинета Ozon 999
mpu ozon call-ro: ручки POST /v1/product/import нет в списке чтения — запись: mpu ask ozon call …
mpu wb call-ro: хост example.com не из API Wildberries
mpu wb call-ro: у кабинета 5f1c… нет действующего токена категории statistics
mpu ozon perf call-ro: у кабинета 2129958 нет ключей Performance API
mpu ozon call-ro: body: не JSON — Unexpected token } at position 11
```

Список кабинетов в отказе — только идентификаторы и имена, никогда не ключи.

`dry`:

```
POST https://api-seller.ozon.ru/v1/finance/products/buyout
client-id: 2129958
api-key: ***
content-type: application/json

{"date_from":"2026-09-10","date_to":"2026-09-10"}
```

## Побочные эффекты

- Один HTTP-запрос к маркетплейсу. Повторов нет ни на 429, ни на 5xx: ответ
  маркетплейса и есть результат, решение о повторе — у вызывающего [D.2].
- **Расход квоты кабинета клиента.** Каждый вызов тратит ту же квоту, что и
  загрузчики клиента (у `/v1/finance/products/buyout` — порядка единиц вызовов в
  час на кабинет). Это внешний эффект и у `call-ro`.
- `ozon perf`: обмен `client_credentials` на токен (`POST
  https://api-performance.ozon.ru/api/client/token`) — ещё один вызов;
  полученный токен держится в памяти сервера до истечения и в БД не пишется.
- Чтение ключа: read-only сессия к PG сервера клиента (как `sql-ro`,
  `platform/readonly-default.md`). Источники: Ozon — `schema_<client>.ozon_api_keys`
  (`seller_client_id`, `seller_api_key`, `performance_client_id`,
  `performance_client_secret`); WB — `public.wb_tokens` сервера клиента (поля
  сняты 2026-09-25: `client_id`, `sid`, `token`, `exp`, `is_valid`, категории
  `content`, `analytics`, `prices`, `marketplace`, `statistics`, `adverts`,
  `questions`, `recommendations`, `returns`, `finance`, `supplies`,
  `documents`, `read_only`, `test_environment`, `acc`, `for`), отбор как у
  загрузчика: `client_id` и `sid`; `is_valid = true`; `exp` пуст или в
  будущем; `acc` пуст, или не 2, 3, 4, или `acc = 4` при `"for" =
  'asid:932c176a-5085-5c6f-bc33-4e84cdf58d7e'` (идентификатор сервиса
  загрузчика; снято 2026-09-25 — на клиенте 54 у 26 токенов `acc = 4` с этим
  `for`, у 11 — `acc = 1`); нужная категория — `true`.
- Журнал вызовов: строка вызова и статус, размер тела, заголовки квоты; **тело
  ответа в журнал не пишется** [D.3].
- `call`, запись: изменение данных кабинета у маркетплейса — то, что делает
  вызванная ручка. На стенде не проверяется: у маркетплейсов нет песочницы для
  наших кабинетов; **не проверено** и проверено быть не может, кроме как на
  тестовом кабинете с разрешения владельца.

## Конфигурация

- Адреса и креды PG серверов клиентов — `platform/env-file.md`, как у `sql-ro`.
- Для WB — `WB_CLIENT_SECRET` и `WB_USER_AGENT` из `~/.config/mpu/.env`, если
  заданы: заголовки `X-Client-Secret` и `User-Agent`, как у `sl-back`
  (`wbFetchNew.base.service.js:75-76`). Не заданы — запрос без них.
- Реестр чтения — данные модуля `call` (`reads.ts`), не файл конфигурации:
  новая ручка чтения — строка в реестре и ревью, как у `wbGateway.registry.js`.
  Посев (снят хостом 2026-09-25 из кода загрузчиков вертикали `ozon` и
  `sl-back`), строка — `<МЕТОД> <хост><путь>`, `{}` — один сегмент пути:

  ```
  GET  api-seller.ozon.ru/v1/actions
  POST api-seller.ozon.ru/v1/actions/products
  POST api-seller.ozon.ru/v1/actions/candidates
  POST api-seller.ozon.ru/v1/analytics/data
  POST api-seller.ozon.ru/v1/analytics/product-queries/details
  POST api-seller.ozon.ru/v1/analytics/stocks
  POST api-seller.ozon.ru/v1/finance/accrual/by-day
  POST api-seller.ozon.ru/v1/finance/accrual/types
  POST api-seller.ozon.ru/v1/finance/cash-flow-statement/list
  POST api-seller.ozon.ru/v1/finance/products/buyout
  POST api-seller.ozon.ru/v3/posting/fbo/list
  POST api-seller.ozon.ru/v3/posting/fbs/list
  POST api-seller.ozon.ru/v1/product/action/timer/status
  POST api-seller.ozon.ru/v4/product/info/attributes
  POST api-seller.ozon.ru/v4/product/info/stocks
  POST api-seller.ozon.ru/v3/product/list
  POST api-seller.ozon.ru/v3/product/info/list
  POST api-seller.ozon.ru/v1/report/postings/create
  POST api-seller.ozon.ru/v1/report/info
  POST api-seller.ozon.ru/v1/returns/list
  POST api-seller.ozon.ru/v1/roles
  POST api-seller.ozon.ru/v1/seller/info
  GET  api-performance.ozon.ru/api/client/campaign
  GET  api-performance.ozon.ru/api/client/statistics/daily/json
  GET  api-performance.ozon.ru/api/client/statistics/report
  GET  api-performance.ozon.ru/api/client/statistics/{}
  GET  api-performance.ozon.ru/api/client/statistics/all_sku_promo/orders/generate/json
  POST api-performance.ozon.ru/api/client/statistic/products/generate/json
  POST api-performance.ozon.ru/api/client/statistics/json
  GET  common-api.wildberries.ru/api/v1/seller-info
  GET  statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod
  ```

  `report/postings/create`, `statistic(s)/…/generate/json` и
  `statistics/json` — заказ отчёта: данных кабинета не меняют. GET-ручки WB
  сверх двух строк прокси `wbGateway` добавляются по одной с ревью.

## Инварианты

- Ключ, секрет и выданный bearer не появляются в stdout, stderr, журнале
  вызовов, аргументах процессов, окружении дочерних процессов и в тексте отказа.
  Если тело ответа маркетплейса содержит ключ (эхо ошибки), он заменяется на
  `***` до печати.
- `call-ro` не отправляет запрос, которого нет в реестре чтения: отказ
  случается до чтения ключа.
- `wb call-ro` берёт токен с `read_only = true`, если такой есть у кабинета в
  нужной категории: тогда запись запрещает сам WB. Иначе — обычный токен
  категории.
- Один вызов строки — ровно один запрос к маркетплейсу (у `ozon perf` — плюс обмен
  токена, если токена в памяти нет или он истёк).
- Хост запроса — только из таблицы хостов получателя; `url:` с другим хостом
  отказывается до чтения ключа.

## Граничные случаи и ошибки

| Дано | Ожидается |
|---|---|
| `target: 54`, у клиента один кабинет Ozon | вызов под ним, `cabinet:` не нужен |
| `target: 54`, кабинетов три, `cabinet:` нет | код 2, отказ со списком Client-Id |
| `target: 54 cabinet: 999`, такого нет | код 2, «нет кабинета Ozon 999» |
| `ozon call-ro path: /v1/product/import` | код 2 до чтения ключа, подсказка `mpu ask ozon call …` |
| `ozon call` без `ask` | отказ двери `ask` с готовой строкой (`platform/ask-door.md`) |
| `wb call-ro url: https://statistics-api.wildberries.ru/…`, у кабинета нет токена `statistics` | код 2 |
| у кабинета есть токены `statistics` с `read_only` и без | `call-ro` — с `read_only`; `call` — без |
| маркетплейс ответил 429 с `retry-after: 1` | код 1, заголовки и тело напечатаны, повтора нет |
| маркетплейс ответил 200 не-JSON | код 0, тело как есть; `end json` — `"body"` строкой |
| таймаут | код 1, `mpu ozon call-ro: нет ответа за 60 с` |
| `ozon perf`, ключей Performance у кабинета нет | код 2 |
| `ozon perf`, обмен токена вернул 401 | код 1, статус и тело обмена, секрет замаскирован |
| `dry` | код 0, запрос напечатан, ключ `***`, в сеть ничего не ушло |
| тело ответа содержит строку ключа | ключ заменён на `***` |
| `body:` задан у `GET` | код 2: тело у `GET` не отправляется |

## Сценарии 173a (`ozon call-ro` / `ozon call`)

Стенд: транспорт HTTP подменён заглушкой (записывает запросы, отвечает по
таблице «Дано»); БД клиента — стенд `sql-ro` с таблицей
`schema_<client>.ozon_api_keys`: у клиента 54 одна строка
`(seller_client_id 2129958, seller_api_key 'k-54-seller', name 'cool_flaps')`,
у клиента 55 три — `2129958`, `1539401`, `870282` с ключами `k-55-a`, `k-55-b`,
`k-55-c`. Ответ заглушки по умолчанию — `200`, заголовок
`ratelimit-remaining: 7`, тело `{"name":"cool_flaps","id":2129958}`. Ключи
нигде не печатаются — проверка во всех сценариях (stdout, stderr, `refusal`,
журнал).

| # | Дано | Строка | stdout | stderr | код |
|---|---|---|---|---|---|
| A1 | — | `mpu ozon call-ro target: 54 path: /v1/seller/info` | `HTTP 200 POST api-seller.ozon.ru/v1/seller/info\nratelimit-remaining: 7\n\n{\n  "name": "cool_flaps",\n  "id": 2129958\n}\n` | | 0 |
| A2 | — | то же, `end json` | `{"status":200,"method":"POST","url":"https://api-seller.ozon.ru/v1/seller/info","ms":<мс>,"headers":{"ratelimit-remaining":"7"},"body":{"name":"cool_flaps","id":2129958}}\n` | | 0 |
| A3 | заглушка видит запрос | A1 | запрос: `POST https://api-seller.ozon.ru/v1/seller/info`, заголовки `client-id: 2129958`, `api-key: k-54-seller`, `content-type: application/json`, тело `{}` | | |
| A4 | — | `mpu ozon call-ro target: 55 path: /v1/seller/info` | | `mpu ozon call-ro: у клиента 55 кабинетов Ozon 3 — укажи cabinet: 2129958 \| 1539401 \| 870282\n`; запроса нет | 2 |
| A5 | — | `mpu ozon call-ro target: 55 cabinet: 1539401 path: /v1/seller/info` | как A1 | | 0; ключ запроса `k-55-b` |
| A6 | — | `mpu ozon call-ro target: 55 cabinet: 999 path: /v1/seller/info` | | `mpu ozon call-ro: у клиента 55 нет кабинета Ozon 999\n` | 2 |
| A7 | — | `mpu ozon call-ro target: 54 path: /v1/product/import` | | `mpu ozon call-ro: ручки POST /v1/product/import нет в списке чтения — запись: mpu ask ozon call target: 54 path: /v1/product/import\n`, `refusal.hint` `["ask","ozon","call","target:","54","path:","/v1/product/import"]`; ключ не читался, запроса нет | 2 |
| A8 | — | `mpu ozon call target: 54 path: /v1/product/import` | | отказ двери `ask` (`platform/ask-door.md`): `mpu ozon call: требует подтверждения — вызывай mpu ask ozon call target: 54 path: /v1/product/import\n` | 2 |
| A9 | — | `mpu ask ozon call target: 54 path: /v1/product/import body: {"items":[]}`, ответ `y` | `HTTP 200 POST api-seller.ozon.ru/v1/product/import\nratelimit-remaining: 7\n\n{…тело заглушки…}\n` | `выполнить mpu ozon call target: 54 path: /v1/product/import body: {"items":[]}? [y/N] ` | 0 |
| A10 | заглушка: `429`, `ratelimit-remaining: 0`, `retry-after: 1`, тело `{"code":8,"message":"You have reached request rate limit per second"}` | A1 | `HTTP 429 POST api-seller.ozon.ru/v1/seller/info\nratelimit-remaining: 0\nretry-after: 1\n\n{\n  "code": 8,\n  "message": "You have reached request rate limit per second"\n}\n` | | 1; запрос один |
| A11 | заглушка: `200`, тело `ok` (`text/plain`) | A1 | `HTTP 200 POST api-seller.ozon.ru/v1/seller/info\nratelimit-remaining: 7\n\nok\n` | | 0 |
| A12 | заглушка молчит | `mpu ozon call-ro target: 54 path: /v1/seller/info timeout: 1` | | `mpu ozon call-ro: нет ответа за 1 с\n` | 1 |
| A13 | — | `mpu ozon call-ro dry target: 54 path: /v1/seller/info` | `POST https://api-seller.ozon.ru/v1/seller/info\nclient-id: 2129958\napi-key: ***\ncontent-type: application/json\n\n{}\n` | | 0; запроса нет |
| A14 | заглушка отвечает телом `{"message":"bad key k-54-seller"}` | A1 | тело с `"bad key ***"` | | 0 |
| A15 | — | `mpu ozon call-ro target: 54 path: /v1/seller/info body: {"a":}` | | `mpu ozon call-ro: body: не JSON — <сообщение разборщика>\n` | 2 |
| A16 | — | `mpu ozon call-ro target: 54 path: /v1/actions body: {}` (`GET` по реестру) | | `mpu ozon call-ro: тело у GET не отправляется — убери body:\n` | 2 |
| A17 | после A1 | `mpu log limit: 1` | запись со строкой `$ mpu ozon call-ro target: 54 path: /v1/seller/info`, без секции `out`, `--- end … exit=0 …` | | 0 |
| A18 | — | `mpu ozon call-ro target: 54 path: /v1/seller/info timeout: 301` | | `mpu ozon call-ro: timeout: 1…300, получено 301\n` | 2 |
| A19 | — | `mpu policy` | среди правил `{"path":"ozon call-ro","verdict":"allow"}` и `{"path":"ozon call","verdict":"ask"}` | | 0 |
| A20 | — | `mpu ozon messages`; `mpu ask ozon messages` | первая: `call-ro\t<однострока>\n` (и `perf`, когда будет 173b); вторая: `call\t<однострока>\n` | | 0 |

Тексты отказов A4, A6, A7, A12, A15, A16, A18 — литералы спецификатора по
форме живых отказов; однострока и справка — по `platform/registry.md`
(«Что говорит справка»), голден снимает исполнитель, замораживает хост. Живой
ответ Ozon (форма тела A1) снимает хост при приёмке первым вызовом на
тестовом кабинете 2129958.

## Golden-примеры

Сняты живой пробой 25.09.2026 на тестовом кабинете 2129958 с хоста
`ozon-dev` (`mp/tmp/ozon-backfill-nfr/quota-probe.jsonl`), в форме вывода
этой спеки:

```
$ mpu ozon call-ro target: 54 cabinet: 2129958 path: /v1/finance/products/buyout body: {"date_from":"2026-09-10","date_to":"2026-09-10"}
HTTP 200 POST api-seller.ozon.ru/v1/finance/products/buyout
ratelimit-remaining: 0

<тело ответа: 2 строки выкупа — проба тело не сохраняла, форму снимает реализующая сессия>
```

```
$ mpu ozon call-ro target: 54 cabinet: 2129958 path: /v1/finance/products/buyout body: {"date_from":"2026-09-10","date_to":"2026-09-10"}
HTTP 429 POST api-seller.ozon.ru/v1/finance/products/buyout
ratelimit-remaining: 0
retry-after: 1

{
  "code": 8,
  "message": "You have reached request rate limit per second"
}
```

Для WB и `ozon perf` — **догадка** по коду `sl-back` (`wbFetchNew.base.service.js:105-108`,
`ozonFetchService.js:399-425`); снимает реализующая сессия первым живым
вызовом на тестовом кабинете, хост сверяет.

## Известные отклонения

- `ai-tools/bin/ozon-api` (прежний путь) берёт креды из локального файла
  тестовых кабинетов, печатает тело в stdout и статус в stderr, без заголовков
  квоты. **fix**: `call` берёт креды из БД клиента и печатает заголовки квоты в
  результате. Сам `ozon-api` остаётся для кабинетов без клиента в БД.
- Прокси `wbGateway` (`sl-back`) требует, чтобы вызывающий прислал токен сам.
  **fix**: здесь токен подставляет сервер `mpu`. Реестр чтения переиспользует
  его строки.

## Решено хостом 2026-09-25 (владелец может пересмотреть — `mpu/docs/owner-questions.md`)

1. **Посев `call-ro` — `allow`** по правилу «`ro` → `allow`» (`platform/policy.md`,
   «Посев»); сужение по цели — правилом владельца (`ask:`/`deny:` на путь).
2. **Кабинеты вертикали `ozon` на стендах** — не в этой порции; следующим шагом
   селектор `dev-ozon:<контур>`, тот же получатель `ozon`.
3. **Журнал без тела ответа** — в этой порции: признак команды «stdout в журнал
   не писать» рядом с `logsArguments` (`platform/invoke-log.md` дополняется
   этой порцией; сценарий: после `mpu ozon call-ro …` запись `mpu log limit: 1`
   без секции `out`, с `--- end … exit=…`).
4. **Выход в сеть** — прямой с машины `mpu` (проба 25.09 с этого хоста: 200 и
   429 с заголовками квоты); транспорт через `ssh` — вариантом позже, если
   замер покажет разницу по IP.

## Пункты чек-листа

Универсальный `checklists/design.md`:

1. Примитивы — изменил: три примитива получателя-маркетплейса — «найти
   ключ кабинета», «разрешить ли запрос», «выполнить запрос»; разбор ответа,
   маскирование и печать выведены один раз над результатом.
2. Особые случаи → получатели — изменил: Ozon Seller, Ozon Performance и WB —
   три реализации одного протокола; «чтение / запись» — две реализации
   допуска запроса (реестр чтения и «любой запрос известного хоста»), а не флаг
   [D.1].
3. Проверка на `null` — изменил: «кабинет не найден», «кабинетов несколько»,
   «нет токена категории» — объекты-отказы с текстом из раздела «Ввод/вывод», а
   не `undefined` у места вызова.
4. Кто решает — изменил: хост и категорию токена решает получатель-маркетплейс;
   чтение или нет — объект допуска; политику — её владелец, команда только
   объявляет `ro`/`rw`.
5. Память приватна — изменил: ключ — приватная память объекта «ключ кабинета»,
   наружу он отвечает только на «подписать запрос» и «замаскировать текст»;
   значения ключа нет ни в одном возвращаемом результате.
6. Голые данные → протокол — изменил: строка реестра `<МЕТОД> <хост><путь>`
   разбирается в объект-правило с методом «подходит ли запрос»; категория WB —
   literal union из таблицы хостов.
7. Основание проверкой — изменил: «ключ не печатается» держится на тесте, который
   гоняет все пути вывода (текст, `json`, `dry`, отказы, журнал, эхо ключа в теле
   ответа) с известным фиктивным ключом и ищет его в выводе; «`call-ro` не
   ходит в сеть вне реестра» — на тесте с транспортом, который падает при
   любом вызове.

Специфика `checklists/design-mpu.md`:

1. Команда — сообщение объекту — изменил: `ozon`, `ozon perf`, `wb` —
   получатели-маркетплейсы (группы дерева), `call-ro`/`call` — их сообщения
   со своей справкой и ключами; прежний черновик (`call ozon`) держал
   развилку по маркетплейсу внутри команды-глагола.
2. Вид метода — реализация — изменил: `call` и `call-ro` — два объекта с разными
   объектами допуска и политикой `rw`/`ro`, не флаг `readOnly`.
3. Решение политики у владельца — ничего: команда только объявляет `ro`/`rw`,
   посев и сужение по цели — владелец политики.
4. Один факт — один источник — изменил: таблица хостов WB — единственный
   источник для проверки `url:`, выбора категории и справки; реестр чтения —
   единственный источник для допуска и для подсказки в отказе.
5. Величина — из результата работы — изменил: `ms` — время запроса к
   маркетплейсу, без обмена токена; размер тела в журнале — байты полученного
   ответа.
6. Права Deno — изменил: новое право сети на хосты Ozon и WB из таблиц
   получателей; тест, который краснеет от его снятия, — вызов через
   настоящий `fetch` на локальную заглушку под именем разрешённого хоста.
7. Границы модулей — изменил: модуль `call/` с поверхностью `mod.ts`, получатели
   `ozon.ts`, `ozonPerf.ts`, `wb.ts`, реестр `reads.ts`.
8. Внешнее — переданной ссылкой — изменил: `fetch`, часы (истечение bearer) и
   сессия PG приходят параметрами получателя.
9. Голден — снятый — изменил: примеры Ozon Seller сняты живой пробой 25.09;
   WB и `ozon perf` — помечены «догадка», снимает реализующая сессия.
10. Пропускаемая проверка — ничего: живые вызовы в тестах не используются,
    пропускаемых наборов нет.
