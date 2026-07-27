# mpu ps

Статус: черновик

## Назначение

Список Docker-контейнеров: без селектора — снапшот из локального кэша
контейнеров (без сети); с селектором — живой список с Portainer
выбранного сервера (дополнительно поле STATUS).

## CLI-контракт

`mpu ps [SELECTOR] [-f/--filter SUBSTR] [--json | --tsv]`

- SELECTOR: `sl-N` либо клиент-селектор (client_id / spreadsheet_id /
  title — `platform/selector.md`); расширения `dev:` и имя контейнера
  не поддерживаются (не exec-команда).
- `--filter/-f` — буквальная подстрока имени контейнера, действует в
  обоих режимах.
- `--json` / `--tsv` — машинные форматы; заданы оба → exit 2 (конфликт
  флагов; см. «Известные отклонения»).

## Ввод/вывод

**Без селектора (кэш)**: чтение `SELECT DISTINCT endpoint_name,
container_name, state, image FROM portainer_containers [WHERE
container_name LIKE '%<SUBSTR>%'] ORDER BY endpoint_name,
container_name` из кэш-БД. Пустой результат → stderr «(no containers in
cache — запусти `mpu init`)», exit 0. Иначе первой строкой stderr
«# кэш — запусти `mpu init` для обновления», затем данные:

- таблица `ENDPOINT  NAME  STATE  IMAGE` — колонки по ширине
  содержимого, разделитель — два пробела, выравнивание влево; NULL
  `endpoint_name` → `?`, NULL `state`/`image` → пусто;
- `--tsv`: `<endpoint>\t<name>\t<state>\t<image>`, по строке на
  контейнер, без шапки;
- `--json`: массив объектов `{"endpoint", "name", "state", "image"}`
  (в этом порядке ключей), indent=2, ensure_ascii=false, финальный
  перевод строки.

**С селектором (live)**: резолв сервера → Portainer-таргет + API-ключ
(`platform/selector.md`, `platform/exec-transport.md`), затем `GET
/api/endpoints/<id>/docker/containers/json?all=true`. Строка вывода:
`name` = первый элемент `Names` без ведущего `/`; `state`/`status`/
`image` — из `State`/`Status`/`Image` (не-строки → пусто). Фильтр
подстрокой по `name`; сортировка по `name`. Форматы:

- таблица `NAME  STATE  STATUS  IMAGE`; пустой список → stdout
  `(no containers)`, exit 0;
- `--tsv`: `<name>\t<state>\t<status>\t<image>`, без шапки;
- `--json`: массив `{"name", "state", "status", "image"}`, формат как в
  кэш-режиме.

Коды выхода: 0 — успех (включая пустые списки); 2 — ошибки
ввода/резолва/конфигурации; 1 — сетевые ошибки и ошибка кэш-БД.

## Побочные эффекты

Кэш-режим — только чтение кэш-БД, сети нет; данные — на момент
последнего `mpu init`. Live-режим — один HTTP GET, записи нет.

## Конфигурация

Portainer-доступ (`PORTAINER_API_KEY` и прочее) —
`platform/exec-transport.md`; собственных ключей у команды нет.

## Инварианты

- Кэш-режим детерминирован при неизменном кэше и не ходит в сеть.
- Вывод отсортирован: кэш — по (endpoint, name); live — по name.
- STATUS присутствует только в live-режиме: транзиентная строка статуса
  Docker в кэше не хранится.
- `--filter` не влияет на код выхода: ноль совпадений — успех.

## Граничные случаи и ошибки

- Кэш-БД или таблица отсутствуют → stderr «mpu ps: SQLite error:
  <детали> — запусти `mpu init`», exit 1.
- HTTP-ошибка Portainer → stderr «mpu ps: portainer error: <детали>»,
  exit 1.
- Сервер без Portainer-таргета → exit 2: «mpu ps: для sl-<N> не найден
  portainer-target (SQLite после `mpu init` или sl_<N>_portainer в
  ~/.config/mpu/.env)».
- `PORTAINER_API_KEY` не задан → exit 2: «mpu ps: PORTAINER_API_KEY не
  задан в ~/.config/mpu/.env».
- Ошибка резолва селектора → exit 2, тексты — `platform/selector.md`.

## Golden-примеры

Снять при переводе в «к реализации» на замороженном снапшоте кэша:
`mpu ps` (таблица + stderr-строка про кэш); `mpu ps --filter wb-loader`;
`mpu ps --json`; `mpu ps --tsv`; пустой кэш (stderr-строка, exit 0);
`mpu ps --help`. Live-режим — фикстура ответа containers/json +
проверка формы и кода выхода (содержимое недетерминировано).

## Известные отклонения

- **fix** — `--json` и `--tsv` вместе: в оригинале молча побеждает
  `--json`. Правильно — ошибка ввода exit 2 (конфликт флагов, как в
  остальных командах).
- **fix** — в кэш-режиме значение `--filter` в оригинале подставляется в
  LIKE-шаблон: `%` и `_` внутри значения работают как метасимволы, тогда
  как live-режим ищет буквальную подстроку. Правильно — буквальная
  подстрока в обоих режимах.

## Открытые вопросы

нет
