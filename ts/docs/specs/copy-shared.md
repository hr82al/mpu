# mpu copy-shared

Статус: к реализации (заморожена 2026-08-28; механизм сверен с рабочей
версией — см. «Назначение»)

## Назначение

Скопировать 18 общих справочных таблиц (PG-схема `shared`) с сервера,
выбранного селектором, в локальный dev-PG (127.0.0.1:5441): каждая
таблица очищается и наполняется заново. Источник — только чтение;
структура целевых таблиц не меняется.

## CLI-контракт

`mpu copy-shared SELECTOR`

- `SELECTOR` — базовый резолв `platform/selector.md`; используется
  только номер сервера: и `sl-N`, и client_id/таблица/title дают один и
  тот же результат (до конкретного клиента селектор не сужается).
- Без аргументов — справка, exit 2.
- Других флагов нет; режима «без очистки» нет.

## Ввод/вывод

Перед запуском в stderr печатается полная локальная команда:
`$ <argv, shell-квотированный>`. Далее stdout/stderr переносящего
процесса стримятся как есть; его код выхода становится кодом выхода
mpu.

**Локальная команда (граница дословно)**: процесс

```
docker compose --env-file <dir>/.sl-base.env [--env-file <dir>/.env]
  --env-file <dir>/.sl-dt.base.env [--env-file <dir>/.sl-dt.env]
  -f <dir>/compose.sl-dt-host.yaml exec -i[t] cli sh -c '<inner>'
```

где `<dir>` — каталог mp-config-local; env-файлы подаются абсолютными
путями в этом порядке, причём `.env` и `.sl-dt.env` — только если
существуют на диске (`.sl-base.env` и `.sl-dt.base.env` подаются
всегда); `-it` вместо `-i` — только когда stdin процесса — терминал.

**Inner-команда (дословно)**:

```
node src/pgDataTransfer.js transferTablesViaPsql --s-host=<pg_N>
  --s-port=5432 --t-port 5441 --schema shared --clear-tables
  --tables <t1> <t2> … <t18>
```

`<pg_N>` — адрес source-PG из env-ключа `pg_<N>` резолвнутого сервера.

**Список таблиц** — фиксированный, в этом порядке: `currency_rates`,
`mp_stats_wb_conversions`, `mp_stats_wb_subjects_cards_ratings`,
`mp_stats_wb_subjects_buyouts_percents`,
`mp_manager_wb_adverts_conversions_search`,
`mp_manager_wb_adverts_conversions_auto`, `mp_manager_wb_conversions`,
`wb_subjects`, `wb_tariffs_box`, `wb_tariffs_commissions`,
`wb_warehouses_okrug_names`, `wb_storages_priority`,
`wb_calendar_promotions`, `wb_tariffs_pallet`, `ozon_categories`,
`ozon_localization_coefficients`, `ozon_actions`,
`ozon_size_attributes_priority`.

**SQL-семантика переноса**: по каждой таблице — `TRUNCATE` (без
`CASCADE`) в целевой БД, затем копирование всех строк с source
(source — только чтение). DDL не выполняется: новые колонки приезжают
миграциями, не этой командой. FK-ссылка на shared-таблицу в целевой
БД → перенос падает ошибкой, зависимые данные не удаляются.

## Побочные эффекты

Деструктивно для локального dev-PG: 18 таблиц схемы `shared`
перезаписываются целиком. Source-PG не мутируется. Сеть: чтение
source-PG изнутри локального контейнера переноса; резолв селектора —
чтение кэш-БД.

## Конфигурация

Env-файл (контракт — `platform/env-file.md`): `pg_<N>` — адрес source-PG
резолвнутого сервера. Env `MPU_MP_CONFIG_LOCAL` — каталог
mp-config-local (default `<HOME>/mr/mp/mp-config-local`). Целевой
адрес 127.0.0.1:5441 фиксирован (см. «Известные отклонения»).

## Инварианты

- Идемпотентность: повторный запуск с тем же селектором приводит
  целевые таблицы к тому же состоянию (очистка перед наполнением).
- Список и порядок таблиц фиксированы и не зависят от селектора.
- Source-PG используется только на чтение.
- Селектор влияет ровно на одно: адрес source-PG.
- Код выхода переносящего процесса доносится 1:1.

## Граничные случаи и ошибки

- Селектор не резолвится / неоднозначен → тексты и кандидаты
  `platform/selector.md`, exit 2.
- Нет `pg_<N>` для резолвнутого сервера → stderr `mpu copy-shared:
  pg_<N> not found in ~/.config/mpu/.env`, exit 2.
- Каталог mp-config-local не найден → stderr `mpu copy-shared:
  mp-config-local dir not found: <путь> (override via
  MPU_MP_CONFIG_LOCAL=...)`, exit 2.
- Compose-файл не найден → stderr `mpu copy-shared: compose file not
  found: <путь>`, exit 2.
- Контейнер переноса не запущен / перенос упал (в т.ч. на
  FK-конфликте) → код выхода дочернего процесса как есть, без
  дополнительных сообщений.

## Golden-примеры

Кандидаты — снять при переводе в «к реализации» (перенос НЕ запускать —
мутирует локальный dev-PG; только безопасные ветки):

- `mpu copy-shared --help` — структура справки;
- `MPU_MP_CONFIG_LOCAL=<пустой каталог> mpu copy-shared sl-1` —
  ошибка отсутствия compose-файла (exit 2);
- вызов с сервером без `pg_<N>` в синтетическом конфиге — ошибка
  конфигурации (exit 2);
- эталон stderr-строки `$ docker compose …` (без запуска docker) —
  через фиктивный каталог с пустым compose-файлом.

## Известные отклонения

- **preserve** — целевой адрес 127.0.0.1:5441 и каталог
  `~/mr/mp/mp-config-local` (с override только через env) фиксированы.
  Причина: команда — часть локального dev-стенда с фиксированной
  топологией портов; настраиваемый target провоцирует запуск очистки
  против чужой БД.

## Открытые вопросы

нет
