# CLAUDE.md — `@mpu/exec`

Исполнение команды в контейнере фермы без привязки к рантайму и к слою
команд: Portainer exec по WebSocket (свой кодек кадров RFC 6455, доставка
stdin архивом tar, код выхода 1:1, kill по pidfile при Ctrl+C, уборка) или
локальный `ssh` с `docker exec`; одна shell-строка на оба пути. Потребитель —
`ts/` монорепозитория mpu (`ssh`, `run-js`, `node cli`, `move-client`;
shell-строка — `copy-shared`, `mp-init`, `run-js`; локальный подпроцесс —
`make-schema`), ставит пакет архивом из `release/`; выбор цели (селектор,
кэш контейнеров, env-файл) — у потребителя.

Спеки — в `ts/docs/specs/` mpu (сессии библиотеки не видны): договор пакета
`platform/tslibs-package.md`, сама библиотека `platform/tslibs-exec.md`,
поведение — `platform/exec-transport.md`, `platform/line-cancel.md`. Ссылки
на спеки в комментариях кода — от `ts/docs/specs/`.

## Команды

```bash
bun install                       # пакеты
VITEST_MAX_FORKS=2 bun run gate   # biome → tsc → тесты Bun, Node, Deno → check:release
bun run build                     # dist/index.js и *.d.ts
bun run release                   # release/mpu-exec-<версия>.tgz
bun run check:release             # сборка и упаковка = архив в release/
```

Рантаймы гейт гонит по одному. Поменялись исходники или `package.json` —
`bun run release` и архив в тот же коммит, иначе `check:release` красный.
Любое изменение `dist/` — новая версия: `version` в `package.json` и новый
архив в `release/` одним коммитом, прежний архив удаляется; потребитель
переходит своей правкой `package.json`.

## Раскладка

- `index.ts` — поверхность: оба пути (`runOverPortainer`,
  `detachOverPortainer`, `runOverSsh`, `detachOverSsh`, `spawnProcess`), цели
  данными (`PortainerTarget`, `SshTarget`) и аргументы Portainer-пути
  (`PortainerRun`, `PortainerDetach`), приёмник вывода `RemoteSink`,
  подменяемые границы (`HttpCall`, `OpenChannel`, `RunProcess`, `OnInterrupt`),
  `quoteArg`/`shellCommand`, отказ `ExecError`. Кодек кадров и `tarFile`
  наружу не выходят.
- `src/` — устройство и тесты `*.test.ts` рядом с кодом. Помощники тестов —
  из `@mpu/testing`.
- `src/testdata/exec-transport/` — копии golden-ответов Portainer из канала
  спецификаций `ts/docs/specs/fixtures/exec-transport/`. Сверить их с каналом
  библиотека не может — он вне её папки, а близнеца в `ts/` у этих копий нет
  (тест Portainer-пути живёт только здесь). Поэтому смену эталона в канале не
  заметит ни один тест: копия обновляется вручную тем же коммитом, что и
  канал.
  Biome их не трогает (`biome.json`, `files.includes`).
- `release/` — архивы версий, коммитятся; `dist/` — нет.

## Правила кода

Действуют правила `ts/CLAUDE.md` mpu; главное из них:

- Ничего специфичного для рантайма: ни `Deno.*`, ни `Bun.*` — только `node:*`
  и npm. Сокет — `node:net`/`node:tls`, подпроцесс — `@mpu/subprocess`.
  Тесты — Vitest, зелёные под Bun, Node и Deno.
- Слой команд `mpu` библиотеке не известен: ни импорта из `ts/`, ни
  селектора, ни кэш-БД, ни env-файла. Цель приходит разрешённой. Отказ
  транспорта — `ExecError`; отказ ОС у `ssh` проходит как есть; коды выхода
  и перевод в ошибки команд — у потребителя.
- Порядок шагов Portainer-пути — контракт границы (pidfile тем же exec'ом,
  уборка всегда); медленный читатель притормаживает удалённую команду
  (обещание `RemoteSink.out`), а не копится в памяти.
- Функция ≤ 40 строк, вложенность ≤ 3; ранние выходы. JSDoc на каждом
  экспорте; комментарий объясняет «почему».
- Строгий TypeScript, без `any`; `as` и `!` — с обоснованием рядом.
- Никакой работы при импорте.
- Синхронизация сном (`setTimeout`) в тестах запрещена: паузы и сроки —
  параметрами (`delay`, `killAfterMs`, `pingIntervalMs`). Сети наружу в
  тестах нет — только петля и подменённые каналы.

## Порядок изменения

Гейт зелёный → разбор итогового диффа субагентом со свежим контекстом (не
автор) по чек-листам `../../ts/docs/checklists/review.md` + `review-mpu.md`
(сессию библиотеки запускают с `--add-dir` на этот каталог; копий нет) →
исправление найденного → гейт зелёный повторно → коммит. Ядро чек-листов:
объект держит свою память (запись + свободные функции над ней — не объект);
особый случай — отдельная реализация, а не ветка по виду; позднее связывание
и один null-объект на модуль вместо проверок `typeof`/`instanceof`/`null`;
голые данные (строка-код, булев флаг, кортеж) — протоколом.

## Зависимости

Версии точные, без `^`; `bun.lock` коммитится. Своих рантайм-зависимостей
нет. Библиотеки `mpu` — необязательные `peerDependencies` (чтобы `bun` не
искал их в реестре) плюс `devDependencies` архивом для своей установки:
вложенный путь `file:` архива `bun` разрешает от корня потребителя, и прямая
зависимость там не ставилась бы (проба T1). Потребитель ставит их сам — копия
на граф одна.

- `@mpu/http` — HTTP-вызовы Portainer (доставка архива, создание и опрос
  exec'а): пределы времени, выключаемая проверка TLS. Архив
  `../http/release/`.
- `@mpu/portainer` — тип доступа `PortainerAccess` (адрес, ключ, проверка
  TLS) в цели Portainer-пути. Архив `../portainer/release/`.
- `@mpu/subprocess` — локальный `ssh` и `spawnProcess`: отказ запуска кодом
  ОС, код по сигналу. Архив `../subprocess/release/`.
- `@mpu/testing` (dev) — стенд на петле (`listenLoopback`) для тестов
  WebSocket; архив `../testing/release/`. Входа `./testing` у пакета нет.
- `vitest` 3.2.4 — тесты под тремя рантаймами; `@biomejs/biome` — формат и
  линт; `typescript`, `@types/node` — проверка типов и `.d.ts` сборки.
