# mpu copy-client

Статус: к реализации (заморожена 2026-08-28; открытый вопрос снят замером на
стенде, ловушка версий pg_restore записана отдельным разделом)

## Назначение

Скопировать клиента с прод-инстанса в локальный стенд: схема
`schema_<id>` и public-строки → локальный sl-1, токен-строки → локальный
sl-0, Redis-кэш клиентов main, вход в локальный sw-front. Прод читается
только (pg_dump + SELECT); пишется исключительно в локальные контейнеры.
Единственный санкционированный мост прод → локаль.

## CLI-контракт

`mpu copy-client SELECTOR`

- `SELECTOR` — селектор клиента (client_id / substring spreadsheet_id /
  substring заголовка / `sl-N`); резолв и вторая ступень «единственный
  client_id» — `platform/selector.md` (тексты ошибок оттуда, exit 2).
- Без аргумента — справка, exit 2. Флагов нет.
- Примеры из практики: `mpu copy-client 776`,
  `mpu copy-client "название магазина"`.

Коды выхода: 0 — успех (включая сбой best-effort шагов, см. ниже);
2 — ошибка резолва или конфигурации подключений; 1 — падение
`pg_dump`/`pg_restore`.

## Ввод/вывод

stderr — прогресс: заголовок операции, состояние схемы на target
(есть/нет), каждая внешняя команда печатается перед запуском
(`$ <argv>`), вывод `pg_dump`/`pg_restore --verbose` стримится живьём
построчно, раз в 10 секунд до завершения инструмента печатается
heartbeat-строка с прошедшим временем, по таблицам — счётчики
перенесённых строк. stdout — только финальное summary:

```
✓ client <id>: схема + public-строки → sl-1, токен-строки → sl-0.
✓ вход: http://sw.localhost/login → client_<id>@local.host / 123123
  (workspace <id>; если раздел просит активировать подписку — добавь
  <id> в BILLING_MOCK_ACCESS_WORKSPACE_IDS фронта и пересоздай sw-front)
```

Строки про вход печатаются только при успешной проводке sw-front.

## Побочные эффекты

Порядок шагов фиксирован. Шаги 1–4 обязательны (сбой = ошибка команды),
5–6 — best-effort (сбой печатает предупреждение, код выхода не меняет).

1. **Схема → локальный sl-1.** `pg_dump -h <host> -p <port> -U <user>
   -d <db> -Fc --verbose -n schema_<id> --no-owner --no-privileges
   -f <tmp>` с источника (пароль — через окружение процесса, не в argv);
   на target `DROP SCHEMA IF EXISTS schema_<id> CASCADE`, затем
   `pg_restore -h … -p … -U … -d … --verbose --no-owner
   --no-privileges <tmp>`. Дамп несёт `CREATE SCHEMA` — схема создаётся,
   если её не было. Временный файл удаляется при любом исходе. Перед
   дампом best-effort замер масштаба схемы на источнике (счёт и размер
   таблиц из `pg_tables`) для прогресс-строки.
2. **Роль клиента на локальном sl-1.** Если в `pg_roles` нет
   `client_<id>` — `CREATE ROLE client_<id> LOGIN` (с
   `PASSWORD '<PG_CLIENT_USER_PASSWORD>'`, если переменная задана);
   затем всегда `GRANT USAGE ON SCHEMA schema_<id>`, `GRANT ALL
   PRIVILEGES ON ALL TABLES IN SCHEMA` и `… ON ALL SEQUENCES IN SCHEMA`
   этой роли и `ALTER ROLE client_<id> SET search_path TO
   schema_<id>, shared` (перезаписывает прежнее значение).
3. **Public-строки → локальный sl-1.** В сессии target
   `SET session_replication_role = replica` (FK/триггеры off — порядок
   таблиц не влияет). Замена строк = DELETE по фильтру на target + COPY
   потока `SELECT *` с источника:
   - `clients` по `id = <client_id>`; после копии
     `UPDATE public.clients SET server = 'sl-1' WHERE id = <client_id>`;
   - по `client_id`: `wb_tokens`, `clients_wb_cabinets`,
     `clients_modules`, `data_loader_info`, `data_processor_info`,
     `ozon_loader_info`, `ozon_loader_info_v2`, `wb_loader_info`,
     `wb_loader_info_v2`, `wb_loader_nm_ids_data`, `spreadsheets`;
   - дети `spreadsheets` — `spreadsheets_sheets`,
     `spreadsheets_sheets_values`, `spreadsheets_datasets`,
     `spreadsheets_datasets_values`, `spreadsheets_loader_data` — по
     множеству `spreadsheet_id` клиента: SELECT по множеству источника,
     DELETE по объединению множеств источника и target (сносит
     осиротевшие строки старой локальной копии); пустое множество →
     предикат `false`. Один commit на весь посев.
4. **Токен-строки → локальный sl-0.** Тот же механизм (replica-режим,
   DELETE + COPY): `clients` (с тем же `UPDATE … server = 'sl-1'`),
   `wb_tokens`, `clients_wb_cabinets`.
5. **Redis-кэш клиентов main (best-effort).** `docker exec -i
   mp-sl-0-redis redis-cli -x SET sl-main:clients:<id>`, stdin — JSON
   строки клиента (`SELECT row_to_json(c) FROM public.clients c WHERE
   id = <id>` на локальном sl-0). Нет строки → строка-предупреждение и
   пропуск.
6. **Вход в sw-front (best-effort).** Кабинеты клиента с локального
   sl-1: `SELECT c.sid::text, w.name, w.trade_mark FROM
   public.clients_wb_cabinets c LEFT JOIN schema_<id>.wb_cabinets w ON
   w.sid::text = c.sid::text WHERE c.client_id = <id> ORDER BY c.sid`
   (пустые имена → `client <id>`). Посев в локальную БД воркспейсов
   идемпотентными upsert'ами (`ON CONFLICT … DO UPDATE`):
   - `users`: email `client_<id>@local.host`, пароль `123123` в виде
     bcrypt-хэша (cost 10; годится фиксированный
     `$2b$10$cxMCZzMdmIdDRmb18yA2w.JzCc.JPHz8oRp/660kaEDh/xrkSsCnS`),
     `is_email_verified = true`;
   - `workspaces`: `id = <client_id>`, владелец — этот user,
     `marketplace = 'Wildberries'`, `is_active = true`;
   - на каждый sid: `wb_cabinets` (`status = 'ACTIVE'`,
     `marketplace = 'wildberries'`), `workspaces_wb_cabinets`
     (`DO NOTHING`), `subscriptions` (`is_paid = true`,
     `status = 'ACTIVE'`, `paid_from = CURRENT_DATE`, `paid_to = +365
     дней`, `sku_active_limit = 100000`, `is_active = true`);
   - затем сброс кэша sw-back: `docker exec redis-dev redis-cli -a
     some-redis-password FLUSHALL` (best-effort внутри best-effort).

## Конфигурация

Env-файл (`platform/env-file.md`):

- источник (прод-инстанс `sl-N`): host `pg_<N>`; `PG_PORT` (5432);
  `PG_MY_USER_NAME` → `PG_MAIN_USER_NAME`; `PG_MY_USER_PASSWORD` →
  `PG_MAIN_USER_PASSWORD`; `PG_DB_NAME` (`wb`);
- локальные target'ы — host всегда `127.0.0.1` (не настраивается):
  sl-1 — порт `PG_LOCAL_PORT` (5441); sl-0 — `PG_LOCAL_MAIN_PORT`
  (5440); оба: `PG_DB_NAME` (`wb`), `PG_MAIN_USER_NAME`
  (`wb_plus_db_admin`), пароль `PG_MAIN_USER_PASSWORD` → `PG_PASSWORD`
  (обязателен);
- локальная БД воркспейсов: `LOCAL_WORKSPACES_PORT` (5451),
  `LOCAL_WORKSPACES_DB` (`workspaces`), `LOCAL_WORKSPACES_USER`
  (`workspacesapp`), `LOCAL_WORKSPACES_PASSWORD` (`postgres`);
- `PG_CLIENT_USER_PASSWORD` — пароль создаваемой роли `client_<id>`
  (не задан — роль без пароля).

## Инварианты

- Назначение записи — только физически локальные адреса: host target'ов
  зашит `127.0.0.1`, прод-хост как назначение недостижим никакой
  комбинацией параметров.
- Источник не мутируется ни на одном шаге.
- Повторный вызов идемпотентен: DROP+restore, DELETE+COPY и upsert'ы
  дают эквивалентное состояние, дублей не появляется.
- Сбой шагов 5–6 не меняет код выхода: копия схемы и строк уже готова,
  проводка догоняется повторным запуском.
- Пароли не попадают ни в печатаемые команды, ни в вывод.
- Строка summary в stdout печатается только после успешных шагов 1–4.

## Граничные случаи и ошибки

- Селектор указал только сервер / без client_id / >1 client_id →
  exit 2, тексты второй ступени `platform/selector.md`.
- Конфигурация подключений неполна → stderr
  `mpu copy-client: <текст ошибки конфигурации>`, exit 2 (тексты —
  «Конфигурация» + `platform/env-file.md`).
- `pg_dump`/`pg_restore` завершился ненулевым rc → stderr
  `pg_dump schema_<id> failed (exit <rc>, <N>s)` (или `pg_restore …`),
  exit 1.
- Проверка существования схемы на target упала исключением → состояние
  считается «схемы нет», копия продолжается.
- Проводка sw-front упала → stderr `mpu copy-client: WARN проводка
  sw-front не удалась (<причина>); копия в sl-1 готова`, exit 0.
- Redis (`mp-sl-0-redis` / `redis-dev`) недоступен → предупреждение,
  продолжение, exit 0.

## Golden-примеры

Снять при переводе в «к реализации» (happy path — на локальном стенде,
не на проде): `mpu copy-client --help`; резолв-ошибка
(`mpu copy-client 999999999` — nothing matched); полный прогон на
синтетическом клиенте локального стенда (stdout summary + счётчики).

## Известные ловушки окружения

Не дефект реализации, но воспроизводится на каждом прогоне и выглядит как
дефект: **`pg_restore` новее сервера-приёмника завершает копирование кодом 1
при полностью восстановленной схеме**. Замер 2026-08-28: прод PostgreSQL
16.15, локальный 16.10, клиентские утилиты на хосте 17.11; дамп несёт
`SET transaction_timeout = 0`, которого PostgreSQL 16 не знает, отсюда
`errors ignored on restore: 1` и ненулевой код, хотя 162 таблицы схемы созданы
и заполнены.

Контракт от этого не меняется: ненулевой код `pg_restore` остаётся отказом —
классифицировать чужие ошибки по тексту команда не должна. Но сообщение обязано
называть последнюю ошибку `pg_restore`, иначе оператор видит «failed» и не
знает, что данные на месте. Обход — снимать дамп утилитой той же мажорной
версии, что у приёмника.

## Известные отклонения

нет

## Открытые вопросы

нет.

- ~~Повторный прогон при существующей роли `client_<id>`~~ — снято 2026-08-28
  замером: команда роль **не создаёт вовсе**. После копирования клиента 5175 на
  стенде роли `client_5175` нет (есть только `client_54` от прежних потоков), а
  восстановление идёт с `--no-owner --no-privileges` именно затем, чтобы от
  ролей не зависеть. Вопрос относился к другой команде.
