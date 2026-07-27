# mpu copy-dev

Статус: черновик

## Назначение

Скопировать данные с dev-стенда в локальный стенд. Два режима:

- без аргумента — вся БД воркспейсов dev → локальный `mp-sw-pg`;
- `copy-dev <client_id>` — схема `schema_<id>` + public/токен-строки
  клиента с dev sl-PG → локальные sl-1/sl-0 (машинерия копии — та же,
  что у `specs/copy-client.md`, шаги 1–4).

## CLI-контракт

`mpu copy-dev [CLIENT_ID]`

- `CLIENT_ID` — целое число, трактуется как client_id напрямую: резолв
  селектора не выполняется, кэш не читается (dev-клиенты в кэше
  отсутствуют). Нецелый аргумент → usage-ошибка, exit 2.
- Без аргумента — режим полной БД воркспейсов. Флагов нет.
- Примеры из практики: `mpu copy-dev`, `mpu copy-dev 776`.

Коды выхода: 0 — успех; 2 — ошибка конфигурации подключений или
невалидный аргумент; 1 — падение `pg_dump`/`pg_restore`.

## Ввод/вывод

stderr — прогресс (как в `specs/copy-client.md`: печать команд,
live-стрим вывода инструментов, heartbeat раз в 10 секунд, счётчики
строк). stdout — одно финальное summary:

- режим клиента:
  `✓ client <id>: схема + public-строки → sl-1, токен-строки → sl-0.
  Данные готовы (пересчёт не нужен). При залипшем кэше: docker exec
  redis-dev redis-cli -a some-redis-password FLUSHALL` (одной строкой);
- режим полной БД:
  `✓ workspaces скопирована в локальный mp-sw-pg. Перезапусти api
  (`sw-back-up`) — entrypoint накатит prisma migrate deploy.`

## Побочные эффекты

Режим клиента — шаги 1–4 `specs/copy-client.md` (дамп/восстановление
схемы, роль `client_<id>`, public-строки → sl-1, токен-строки → sl-0),
источник — dev sl-PG вместо прод-инстанса. Шагов 5–6 (Redis-кэш main,
проводка sw-front) в `copy-dev` нет.

Режим полной БД: `pg_dump -Fc --verbose --no-owner --no-acl -f <tmp>`
всей dev-БД воркспейсов, затем `pg_restore --verbose --clean
--if-exists --no-owner --no-acl <tmp>` в локальный `mp-sw-pg`
(существующие объекты локальной БД сносятся перед восстановлением).
Временный файл удаляется при любом исходе. Пароли — через окружение
процессов, не в argv.

## Конфигурация

Env-файл (`platform/config.md`):

- dev sl-PG (источник режима клиента): `DEV_PG_HOST` (192.168.150.40),
  `DEV_PG_PORT` (5434), `DEV_PG_DB` (`mp_sl_1_dev`); пользователь
  `DEV_PG_USER` → `PG_MAIN_USER_NAME`, пароль `DEV_PG_PASSWORD` →
  `PG_PASSWORD` (обязательны);
- dev-БД воркспейсов (источник режима полной БД):
  `DEV_WORKSPACES_HOST` (192.168.150.41), `DEV_WORKSPACES_PORT` (5432),
  `DEV_WORKSPACES_DB` (`workspaces`); `DEV_WORKSPACES_USER` /
  `DEV_WORKSPACES_PASSWORD` обязательны, fallback'ов нет;
- локальные target'ы (sl-1 / sl-0 / воркспейсы) — как в
  `specs/copy-client.md`, host всегда `127.0.0.1`.

## Инварианты

- Dev-стенд не мутируется; запись — только в локальные контейнеры
  (host target'ов зашит `127.0.0.1`).
- Режим клиента идемпотентен (см. `specs/copy-client.md`).
- Режим полной БД детерминирован по источнику: локальная БД воркспейсов
  после прогона эквивалентна dev-снимку на момент дампа.

## Граничные случаи и ошибки

- Не заданы креды dev sl-PG → stderr `mpu copy-dev: dev PG user: не
  задано DEV_PG_USER/PG_MAIN_USER_NAME в ~/.config/mpu/.env` (или
  `dev PG password: не задано DEV_PG_PASSWORD/PG_PASSWORD`), exit 2.
- Не заданы креды dev-воркспейсов → stderr `mpu copy-dev: dev
  workspaces creds: задайте DEV_WORKSPACES_USER/DEV_WORKSPACES_PASSWORD
  в ~/.config/mpu/.env`, exit 2.
- `pg_dump`/`pg_restore` rc≠0 → `pg_dump workspaces failed (exit <rc>,
  <N>s)` (аналогично для restore и для `schema_<id>`), exit 1.
- `copy-dev <id>` с client_id, которого нет на dev → дамп пустой схемы
  завершается ошибкой `pg_dump` (схемы нет) → exit 1.
- Режим полной БД поверх живых локальных данных — данные заменяются
  без подтверждения (это назначение команды, не дефект).

## Golden-примеры

Снять при переводе в «к реализации»: `mpu copy-dev --help`; ошибка
конфигурации при снятых `DEV_WORKSPACES_*` (exit 2); прогон
`copy-dev <id>` на dev-клиенте (stdout summary).

## Известные отклонения

нет

## Открытые вопросы

нет
