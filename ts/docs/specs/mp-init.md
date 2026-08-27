# mpu mp-init

Статус: к реализации (заморожена 2026-08-27; сухой прогон снят голденом на
живом стенде. 2026-08-28: отсутствующий env-файл проверен — compose отвечает
`couldn't find env file: <путь>` и кодом 1, то есть базовый env пропущенным
быть не может)

## Назначение

Поднять локальный стенд целиком одной командой: docker-сеть и общий том,
проверка локально собранных образов, последовательный запуск core-стеков
SL backend (nats → sl-0 → sl-1 → nginx → dt-host) и web-стека поверх.
Гарантирует существование простаивающих cli-контейнеров
(`mp-sl-N-cli`, `dt-host-cli`), без которых не работают
`mpu make-schema` и `mpu copy-client`. Образы не собирает.

## CLI-контракт

`mpu mp-init [--dry-run|-n]`

- `--dry-run` / `-n` — напечатать команды без выполнения мутаций;
  probe-команды (inspect сети/тома/образов) выполняются и в dry-run
  (read-only).

Коды выхода: 0 — успех (в т.ч. web-стек пропущен из-за отсутствия
каталога); 2 — каталог mp-config-local не найден; 1 — отсутствуют
обязательные образы (не в dry-run); иначе при падении docker-вызова —
его rc как есть.

## Ввод/вывод

Весь вывод — stderr: каждая docker-команда печатается перед запуском
(`$ <команда>`, shell-квотирование), вывод docker идёт напрямую в
терминал. Финальная строка: в dry-run `dry-run: ничего не выполнено`;
с web-стеком `mp-init: поднят core (nats/sl-0/sl-1/nginx/dt-host) +
web (sw-front/sw-back/sl-front)`; без него `mp-init: core поднят —
nats, sl-0, sl-1, nginx, dt-host`. stdout пуст.

## Побочные эффекты

Порядок шагов фиксирован; любой мутирующий docker-вызов с rc≠0 →
fail-fast (сообщение + exit rc), последующие шаги не выполняются.

1. **Сеть** `mp-shared-net`: если `docker network inspect` её не видит —
   `docker network create --driver=bridge mp-shared-net
   --subnet=178.20.0.0/16`.
2. **Том** `mp-back-node-modules` (external-том compose): если
   `docker volume inspect` его не видит — `docker volume create
   mp-back-node-modules`.
3. **Образы core**: `docker image inspect` для `mp-back:local`,
   `mp-pg:local`, `mp-dt:local`. Отсутствующие → сообщение с парами
   «образ → build-алиас» (`mp-back:local → sl-build-image`,
   `mp-pg:local → mp-pg-build-image`, `mp-dt:local →
   mp-dt-build-image`) и подсказкой собрать их в mp-config-local;
   обычный прогон — exit 1, dry-run — префикс `warning:` и продолжение.
4. **Core-стеки**, строго в порядке кортежа, каждый —
   `docker compose <env-файлы> <compose-файлы> up -d --force-recreate`
   (cwd = каталог mp-config-local, все пути абсолютные):
   | Стек | `--env-file` (по порядку) | `-f` (по порядку) |
   | --- | --- | --- |
   | mp-nats | .sl-base.env, .env | compose.mp-nats.yaml |
   | sl-0 | .sl-base.env, .env, .sl-0.base.env, .sl-0.env | compose.sl-base.yaml, compose.sl-pg.yaml, compose.sl-main.yaml + overrides |
   | sl-1 | .sl-base.env, .env, .sl-1.base.env, .sl-1.env | compose.sl-base.yaml, compose.sl-pg.yaml, compose.pgbouncer.yaml, compose.sl-instance.yaml + overrides |
   | mp-nginx | .shared.env, .env | compose.mp-nginx.yaml |
   | dt-host | .sl-base.env, .env, .sl-dt.base.env, .sl-dt.env | compose.sl-dt-host.yaml |
   Опциональные env-файлы (`.env`, `.sl-0.env`, `.sl-1.env`,
   `.sl-dt.env`) включаются в argv только если существуют на диске.
   Overrides — файлы `overrides/sl-base.observability-off.yaml` +
   `overrides/sl-{main,instance}.observability-off.yaml` из каталога
   local-stack, добавляются после основных `-f` и только если
   существуют. `--remove-orphans` не передаётся никогда (снёс бы
   контейнеры соседних стеков того же compose-проекта). Ошибка стека →
   `mpu mp-init: стек '<name>' упал (rc=<N>); остальные не поднимаю`.
5. **Web-стек поверх core** (каталог local-stack = sibling
   mp-config-local: `<родитель>/local-stack`; отсутствует → строка
   `каталог local-stack не найден: <путь>; web-стек пропущен`, шаг
   пропускается целиком, exit 0):
   - образ `sl-front-dev:local` отсутствует → `warning: нет
     web-образов: sl-front-dev:local → sl-front-build-dev-image`,
     продолжение;
   - БД-зависимости sw-back: `docker compose --env-file
     .sw-back.base.env -f compose.sw-back.yaml up -d --force-recreate
     pg redis` (cwd = mp-config-local);
   - стоп конфликтующих контейнеров `mp-sw-api`, `nextjs-dev`,
     `mp-sl-front-dev`: в реальном прогоне `docker stop` только реально
     запущенных (probe `docker inspect -f {{.State.Running}}`), rc не
     проверяется; никого нет — команда не выполняется;
   - `docker compose -f <local-stack>/docker-compose.yml up -d
     --force-recreate` (cwd = local-stack).

## Конфигурация

Каталог mp-config-local: `~/mr/mp/mp-config-local`, override —
переменная окружения процесса `MPU_MP_CONFIG_LOCAL` (не env-файл).
Других настроек нет.

## Инварианты

- Порядок запуска core — упорядоченная последовательность
  nats → sl-0 → sl-1 → nginx → dt-host; compose-зависимостей между
  стеками нет, корректность держится на порядке и fail-fast — порядок
  закрепить тестом.
- Сеть/том создаются только при отсутствии (идемпотентно); стеки
  пересоздаются всегда (`--force-recreate`).
- dry-run не выполняет ни одной мутации (create/up/stop); probe'ы
  выполняются в обоих режимах.
- Образы никогда не собираются командой.
- Отсутствие web-части (каталог, web-образ) не считается ошибкой core.

## Граничные случаи и ошибки

- Каталог mp-config-local не найден → stderr `mpu mp-init: каталог
  mp-config-local не найден: <путь>; попробуй: задай
  MPU_MP_CONFIG_LOCAL=<путь>`, exit 2.
- Обязательный образ отсутствует: реальный прогон → exit 1; dry-run →
  warning, команды всех стеков печатаются дальше.
- Создание сети/тома с rc≠0 → сообщение + exit rc.
- Стоп-шаг конфликтующих контейнеров в dry-run печатает stop-команду со
  ВСЕМ списком конфликтов и комментарием `# только запущенные`; в
  реальном прогоне список фильтруется по фактически запущенным.
- Любой `up` с rc≠0 → fail-fast, следующие стеки не поднимаются,
  exit = rc docker.

## Golden-примеры

`fixtures/mp-init/dry-run.stdout` — `mpu mp-init --dry-run`, снято 2026-08-27 с
рабочей версии на этой машине. Восемь строк: пять `docker compose … up -d
--force-recreate` (nats, sl-0, sl-1, nginx, dt-host), поднятие БД-зависимостей
sw-back, `docker stop` конфликтующих контейнеров с комментарием
`# только запущенные` и compose web-стека. Домашний каталог в фикстуре
заменён на ASCII (`/home/operator`) намеренно: кириллический путь shell берёт в
кавычки, и побайтовая сверка ловила бы квотирование, а не контракт. В фикстуре
нет `.sl-dt.env` — на стенде этого опционального файла нет; порядок строк — часть контракта: web поднимается после core, а
конфликтующие контейнеры гасятся до него.

## Известные отклонения

нет

## Открытые вопросы

нет
