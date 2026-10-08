# Порция EX1 — запуск процессов и удалённое исполнение пакетами `tslibs/subprocess`, `tslibs/exec`

Статус: к реализации после SB1 (2026-10-08). Решение владельца 2026-10-08:
после чистых клиентов продолжать пакеты по связности. Договор пакета —
`platform/tslibs-package.md`; поведение — `platform/exec-transport.md`,
`platform/line-executor.md` (не меняется).

## Кто и зачем

Разработчик хочет, чтобы запуск локального процесса и исполнение команды в
контейнере (Portainer exec по WebSocket, кадры, `tar` для переноса файла,
экранирование `shell`) или на хосте по `ssh` были библиотеками без привязки к
рантайму и к слою команд; выбор цели (селектор, кэш контейнеров, env-файл)
остаётся в `ts/`.

## Граница (наблюдаемая, снято с `main` 2026-10-08)

- `tslibs/subprocess` ← `back/src/subprocess/` целиком (`mod.ts`, 213 строк,
  только `node:*`); потребителей в `ts/` — 11.
- `tslibs/exec` ← из `back/src/exec/`: `frames.ts`, `ws.ts`, `shell.ts`,
  `tar.ts`, `portainer.ts`, `ssh.ts` и их тесты. Связи со слоем команд
  (распутывает исполнитель, `.tmp/design-EX1.md` до кода):
  - `RemoteOutput` (`command/mod.ts`) — приёмник вывода; пакет объявляет свой
    интерфейс той же формы, `ts/` передаёт свой объект как есть;
  - `DomainError` в `ws.ts`, `portainer.ts` — пакет бросает свой класс,
    перевод на границе `ts/` (как в T1, KA1);
  - `ExecTarget` (`target.ts`) — пакет принимает разрешённую цель
    (адрес, доступ Portainer, контейнер / хост ssh) данными; разрешение цели
    — в `ts/`;
  - `ssh.ts` → `startProgram` — из `@mpu/subprocess`.
- В `ts/` остаются `target.ts`, `place.ts`, `containers.ts` (селектор,
  `CacheReader`, `EnvFile`, `UsageError`) и `mod.ts` как фасад.

## Сценарии [S.n]

1. `tslibs/subprocess` и `tslibs/exec`: в каждом `bun install && bun run
   gate` → зелёно под Bun, Node, Deno, `check:release` зелёный; архивы
   `release/mpu-subprocess-0.1.0.tgz`, `release/mpu-exec-0.1.0.tgz`
   закоммичены; `@mpu/http`, `@mpu/portainer`, `@mpu/subprocess` у
   `tslibs/exec` — необязательные `peerDependencies` плюс `devDependencies`
   архивом; тестовые помощники — `@mpu/testing`.
2. Списки листовых случаев `back/src/subprocess` и `back/src/exec` до =
   объединение после (пакеты + `ts/`), строка в строку; сверх — только
   новые случаи перевода отказа на границе.
3. `rg -n 'Deno\.|Bun\.' tslibs/subprocess/src tslibs/exec/src` → пусто; в
   пакетах нет импорта из `ts/`.
4. `ts/package.json` — оба архива; `cd ts && rm -rf node_modules/@mpu && bun
   install --frozen-lockfile` проходит; гейты `ts/` и `bun run smoke`
   зелёные.
5. Голдены команд `ssh`, `run-js`, `node cli`, `health`, `ps`, `copy-shared`,
   `move-client`, `mp-init`, `make-schema` — без изменений и зелёные.
6. Отмена строки во время удалённого исполнения (`platform/line-cancel.md`)
   — существующие тесты зелёные под тремя рантаймами: отмена закрывает
   канал, процесс в контейнере получает сигнал.
7. Медленный читатель притормаживает удалённую команду (обещание `out`) —
   существующие тесты зелёные.
8. Живьём (хост после установки): `mpu ssh target: sl-1 cmd: uptime`
   (Portainer exec), `mpu ps`, `mpu health target: sl-1` — вывод той же
   формы, что до порции.

## Инварианты

- Наблюдаемое поведение команд не меняется.
- Пакеты не знают о слое команд: ни импорта из `ts/`, ни селектора, ни
  кэш-БД, ни env-файла.

## Границы

- Разрешение цели (`target`, `place`, `containers`) — в `ts/`.
- Самоописание `about`, конверт — этап 6.

## Пункты чек-листа

`design.md`: 1 примитивы — запустить процесс; открыть канал исполнения
(Portainer / ssh) и передать байты; перенос файла выведен (`tar` через
канал); 2 особые случаи — Portainer / ssh — две реализации канала, не ветка
у вызывающего; 7 основание проверкой — [S.2], [S.4], [S.6]. `design-mpu.md`:
4 один источник — протокол кадров и exec Portainer в пакете; 7 границы
модулей — `index.ts`; 8 внешнее — цель и доступ данными; прочее — ничего.
