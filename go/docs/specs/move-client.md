# mpu move-client / move-client-back

Статус: черновик

## Назначение

Перенос клиента между sl-серверами фермы и его реверс. Обе команды не
переносят данные сами: они ставят job переноса — запускают
`clientsTransfer createJob` в контейнере `mp-dt-cli` (очередь BullMQ,
реальный перенос исполняют отдельные воркеры). `move-client` после
успешной постановки записывает ход «source → target» в кэш-БД (таблица
`client_moves`, одна строка на клиента); `move-client-back` читает эту
запись, ставит обратный job и удаляет её.

## CLI-контракт

`mpu move-client SELECTOR [--target sl-N]`

- `SELECTOR` — селектор клиента (`platform/selector.md`, вторая ступень
  «единственный client_id»); source-сервер = результат резолва. Без
  аргумента — справка, exit 2.
- `--target` — сервер назначения, дефолт `sl-1`; обязан матчить `sl-N`.
- Пример из практики: `mpu move-client 1234 --target sl-4`.

`mpu move-client-back [SELECTOR|ls|rm] [SELECTOR]`

- первый аргумент — диспетчер: `ls` (и синоним `list`, и вызов вовсе без
  аргументов) — список записанных ходов; `rm <selector>` — удалить
  запись хода без переноса; иначе аргумент — селектор клиента для
  реверса.
- Селектор здесь: чистое целое число трактуется как client_id напрямую,
  минуя кэш (робастно к непрогретому кэшу); прочее — обычный резолв
  (`platform/selector.md`) с сужением до одного client_id.
- Реверс: по записи `source → target` клиент возвращается
  target → source; после успешной постановки job'а запись удаляется.

Коды выхода (обе команды): 0 — успех (для `move-client`/реверса —
успешная постановка job'а, не завершение переноса); 2 — ошибки резолва,
валидации аргументов, отсутствие/порча записи хода, нерезолвящийся
контейнер `mp-dt-cli`; иначе — rc `createJob` как есть.

## Ввод/вывод

stderr — прогресс: печать запускаемой команды
`$ node cli service:clientsTransfer createJob --source sl-<S> --target
sl-<T> --client-id <id> --destroy  (in mp-dt-cli)` и (у реверса) строка
с направлением возврата; вывод `createJob` стримится транспортом
(`platform/exec-transport.md`). stdout:

- `move-client-back ls` — таблица ходов, новые сверху: колонки
  client_id, «перенос (откуда → куда)», «когда» (локальное время
  `YYYY-MM-DD HH:MM:SS`); пусто → `нет записанных ходов`;
- `move-client-back rm` — строка об удалённой записи с её маршрутом.

## Побочные эффекты

- Запуск `node cli service:clientsTransfer createJob --source sl-<S>
  --target sl-<T> --client-id <id> --destroy` в контейнере `mp-dt-cli`
  через транспорт exec (`platform/exec-transport.md`). `--destroy`
  передаётся всегда: это move, copy-семантики у команды нет.
- Кэш-БД, таблица `client_moves` (PK `client_id`; колонки source,
  target, moved_at — unix-время записи): `move-client` — upsert строки
  после rc=0; реверс — DELETE строки после rc=0; `rm` — DELETE без
  переноса. `ls` — только чтение.

## Конфигурация

Транспорт до `mp-dt-cli` — `platform/exec-transport.md`; кэш-БД —
`platform/config.md`. Собственных настроек нет.

## Инварианты

- rc `createJob` ≠ 0 → состояние `client_moves` не меняется (ход не
  записывается / не удаляется), rc пробрасывается наверх.
- На клиента хранится не более одной записи хода — последней; успешный
  повторный `move-client` перезаписывает её.
- `move-client` никогда не ставит job с source == target.
- `ls` и `rm` не запускают перенос.
- Успех команды = job поставлен; фактическое завершение переноса
  команда не отслеживает.

## Граничные случаи и ошибки

- `--target` не вида `sl-N` → stderr `mpu move-client: bad --target
  '<значение>' (expected sl-N)`, exit 2.
- source == target → `mpu move-client: source и target оба sl-<N> —
  нечего переносить`, exit 2.
- Контейнер `mp-dt-cli` не резолвится → stderr текст ошибки резолва
  контейнера + список кандидатов, либо подсказка `запусти `mpu init`
  для обновления Portainer-кэша`, exit 2.
- Реверс без записи хода → `mpu move-client-back: нет записанного хода
  для client <id> (сначала `mpu move-client`, либо запусти `mpu
  init`)`, exit 2.
- Запись хода, где source или target не парсится как `sl-N` →
  `повреждённая запись хода: <source> → <target>`, exit 2.
- Запись, где source == target → `source и target записи оба sl-<N> —
  нечего возвращать`, exit 2.
- `rm` без селектора → ``rm` требует селектор (rm <selector>)`, exit 2.
- `rm` без записи хода → строка `нет записи хода для client <id>` в
  stderr, exit 0 (идемпотентно).
- Клиент с client_id/заголовком буквально `ls`/`rm`/`list` через
  `move-client-back` адресуем только числовым client_id (слова заняты
  диспетчером).
- Селектор `move-client-back`, резолвящийся без client_id → `selector
  '<значение>' не указывает на конкретного клиента` (+ кандидаты),
  exit 2; несколько client_id → `selector matches N clients — narrow
  it down`, exit 2.

## Golden-примеры

Снять при переводе в «к реализации»: `mpu move-client --help`;
`mpu move-client-back --help`; `mpu move-client-back ls` (чтение
кэш-БД, без мутаций); `mpu move-client <id> --target sl-<source>`
(ошибка source == target); `mpu move-client-back rm` без селектора.

## Известные отклонения

- **fix** — при отсутствующей таблице `client_moves` (кэш-БД без
  `mpu init`) успешный `move-client` пропускает запись хода молча
  (след только в журнале вызовов): job уже поставлен, но реверс станет
  невозможен без предупреждения. Правильное поведение: явное
  предупреждение в stderr (код выхода остаётся 0 — постановка job'а
  удалась). `last_move`/`ls`/`rm` при отсутствии таблицы ведут себя как
  «записей нет» — это сохранить.

## Открытые вопросы

нет
