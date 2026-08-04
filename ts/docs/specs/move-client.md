# mpu move-client

Статус: черновик

## Назначение

Перенос клиента между sl-серверами фермы. Команда не переносит данные
сама: она ставит job переноса — запускает `clientsTransfer createJob` в
контейнере `mp-dt-cli` (очередь BullMQ, реальный перенос исполняют
отдельные воркеры) — и после успешной постановки записывает ход
«source → target» в журнал переносов (кэш-БД, таблица `client_moves`,
одна строка на клиента). Журнал и транспорт постановки job'а — общий
механизм с обратной командой `mpu move-client-back`
(`specs/move-client-back.md`): описаны здесь, реверс на них ссылается.

## CLI-контракт

`mpu move-client SELECTOR [--target sl-N]`

- `SELECTOR` — селектор клиента (`platform/selector.md`, вторая ступень
  «единственный client_id»); source-сервер = результат резолва. Без
  аргумента — справка, exit 2.
- `--target` — сервер назначения, дефолт `sl-1`; обязан матчить `sl-N`.
- Пример из практики: `mpu move-client 1234 --target sl-4`.

Коды выхода: 0 — успешная постановка job'а (не завершение переноса);
2 — ошибки резолва, валидации аргументов, нерезолвящийся контейнер
`mp-dt-cli`; иначе — rc `createJob` как есть.

## Ввод/вывод

stderr — прогресс: печать запускаемой команды
`$ node cli service:clientsTransfer createJob --source sl-<S> --target
sl-<T> --client-id <id> --destroy  (in mp-dt-cli)`; вывод `createJob`
стримится транспортом (`platform/exec-transport.md`). Собственного
stdout у команды нет.

## Побочные эффекты

- Запуск `node cli service:clientsTransfer createJob --source sl-<S>
  --target sl-<T> --client-id <id> --destroy` в контейнере `mp-dt-cli`
  через транспорт exec (`platform/exec-transport.md`). `--destroy`
  передаётся всегда: это move, copy-семантики у команды нет. Команда и
  транспорт общие с реверсом (`specs/move-client-back.md`).
- Кэш-БД, таблица `client_moves` (PK `client_id`; колонки source,
  target, moved_at — unix-время записи): upsert строки хода после rc=0.
  Читает и удаляет записи `mpu move-client-back`.

## Конфигурация

Транспорт до `mp-dt-cli` — `platform/exec-transport.md`; кэш-БД —
`platform/env-file.md`. Собственных настроек нет.

## Инварианты

- rc `createJob` ≠ 0 → ход не записывается, rc пробрасывается наверх.
- На клиента хранится не более одной записи хода — последней; успешный
  повторный `move-client` перезаписывает её.
- Job с source == target не ставится никогда.
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

## Golden-примеры

Снять при переводе в «к реализации»: `mpu move-client --help`;
`mpu move-client <id> --target sl-<source>` (ошибка source == target).

## Известные отклонения

- **fix** — при отсутствующей таблице `client_moves` (кэш-БД без
  `mpu init`) успешный `move-client` пропускает запись хода молча
  (след только в журнале вызовов): job уже поставлен, но реверс станет
  невозможен без предупреждения. Правильное поведение: явное
  предупреждение в stderr (код выхода остаётся 0 — постановка job'а
  удалась).

## Открытые вопросы

нет
