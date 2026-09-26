# mpu mp-init

Статус: M1 реализовано (`015edad3`); принято 2026-09-26 хостом по коду: тестов 2792, мутации 5 красных; живьём только пробы чтения (стенд не пересоздавался): метка `com.docker.compose.project.working_dir=$M` есть у контейнеров core — отбор сводки работает, с хвостовым `/` в пути — пусто (нормализация — M2); `psql` в `sl-0-pg` → `183`; `config --services` sl-0 содержит все сервисы override-файлов. Живой подъём — с разрешения владельца (вопрос 10). M2–M4 — к реализации. Прежде: к реализации — четыре порции (переработано хостом 2026-09-26: контракт
приведён к грамматике строки, противоречия инвариантов с разделом «Подъём с
нуля» сняты; полная проверка — автором по списку):

- **M1 — core с нуля**: сборка недостающих образов (шаг 3), сверка
  overrides (шаг 4), проверка миграций sl-N, сводка контейнеров после core;
  сценарии M1-1…M1-9.
- **M2 — курсы валют на свежем стенде** (раздел «После core — курсы
  валют»).
- **M3 — web**: инфра SW из local-stack, `--no-deps`, `SW_BACK_DEPS_TAG`,
  вход в Nexus (разделы «Шаг 5…»).
- **M4 — стенд ozon и финальная проверка ответом** (шаг 6, «Финал»).

Сценарии M2–M4 литералами — перед их постановкой. Живая приёмка любой
порции пересоздаёт стенд оператора (`--force-recreate`) — только с
разрешения владельца.

Ранее: реализовано — сверено 2026-09-10; сухой прогон снят голденом 2026-08-27.

## Назначение

Поднять локальный стенд целиком одной командой: docker-сеть и общий том,
проверка локально собранных образов, последовательный запуск core-стеков
SL backend (nats → sl-0 → sl-1 → nginx → dt-host) и web-стека поверх;
недостающие core-образы собирает (M1).
Гарантирует существование простаивающих cli-контейнеров
(`sl-N-cli`, `dt-host-cli`; имена сняты 2026-09-26), без которых не работают
`mpu make-schema` и `mpu copy-client`.

## CLI-контракт

`mpu ask mp-init [dry]` (путь правила `mp-init`, посев `ask`; вариант путь
правила не меняет — `dry` тоже через `ask`).

- `dry` — напечатать команды без выполнения мутаций; probe-команды
  (inspect сети/тома/образов, `compose config --services`) выполняются и в
  `dry` (read-only).

Коды выхода: 0 — успех (в т.ч. web-стек пропущен из-за отсутствия
каталога); 2 — каталог mp-config-local не найден; 1 — override не сходится
с compose, миграции упали или не завершились (M1); иначе при падении
docker-вызова (сборки, `up`) — его rc как есть.

## Ввод/вывод

Весь вывод — stderr: каждая docker-команда печатается перед запуском
(`$ <команда>`, shell-квотирование), вывод docker идёт напрямую в
терминал. Финальная строка: в `dry` — `dry-run: ничего не выполнено`;
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
   mp-dt-build-image`) — **заменено порцией M1**: недостающий образ
   собирается («Подъём с нуля», шаг 3; сценарии M1-1…M1-4).
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
5. **Web-стек поверх core** — действует до порции M3, она заменяет его
   разделами «Шаг 5, web…» и «Шаг 5, Nexus». (каталог local-stack = sibling
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

## Подъём с нуля — требования 2026-09-24

Сняты живым подъёмом на чистой машине 2026-09-24 (docker пуст, область только что развёрнута —
`mp-clone.md`). Прежний контракт падал на пяти местах подряд, и каждое место стенд проходил только
ручной правкой. Общее правило для всех пунктов: **каждый шаг идемпотентен** — сначала probe
«уже как надо?», мутация только при «нет»; повторный `mpu mp-init` на поднятом стенде пересоздаёт
стеки (`--force-recreate`, как раньше), но не собирает, не логинится, не мигрирует повторно то, что
уже на месте. Вариант `dry` печатает и эти шаги.

Изменения против разделов выше — по номерам шагов «Побочных эффектов».

**Шаг 3, образы — собирать недостающие, а не останавливаться.** Нет образа → собрать той же
командой, что build-алиас (`20-build.sh`), с `--load`; есть → пропуск. Набор: `mp-back:local`
(`Dockerfile.mp-back`, контекст — корень `mp`), `mp-pg:local` (`pg/Dockerfile`), `mp-dt:local`
(`Dockerfile.mp-data-transfer`), `sl-front-dev:local` (`Dockerfile.front --target dev`, контекст
`sl-front`). Сборка на чистой машине — ~10 минут; строка `собираю <образ>` до начала. Падение
сборки → exit rc сборки. Образ-ключ идемпотентности — наличие тега, без сравнения с исходниками
(пересборку по изменению зависимостей делает владелец явно).

**Шаг 4, overrides — сверка с compose до `up`.** Override на сервис, которого в compose уже нет,
роняет весь стек: `service "m-nats-listeners" has neither an image nor a build context specified`
(2026-09-24: слушатели sl-back слиты в `internal-api` / `i-internal-api`, override их ещё
перечислял). Перед `up` стека — `docker compose <те же -f без overrides> config --services` и
список сервисов override-файла; сервис override без пары в compose → отказ exit 1 с именем файла
и лишними сервисами (`override <файл>: нет в compose: m-nats-listeners`). Не фильтровать молча:
расхождение значит, что local-stack отстал, и чинить его надо в файле.

**Шаг 4, миграции — проверять, а не считать пройденными.** Контейнер `migrations` (compose sl-base)
завершается сам; `up -d` возвращает 0, даже если миграции упали. 2026-09-24 оба `sl-N-migrations`
вышли с кодом 1 (регрессия sl-back, MR sl-back!3410), а стенд работал на схеме из 74 миграций из
183 — и ничто этого не показало. После `up` стека sl-N: дождаться завершения
`docker wait <SERVER_NAME>-migrations` (таймаут 10 мин), код ≠ 0 → exit 1 с хвостом лога
(`docker logs --tail 30`) и строкой `миграции sl-N упали`. Код 0 → строка `sl-N: миграции ок,
<count(*)> в public.migrations`.

**Шаг 4, после core — сводка контейнеров.** Контейнер в `Restarting` или `Exited(≠0)` (кроме
`migrations`, проверенного выше) — предупреждение с именем и последней строкой лога; exit не
меняется. Живой случай: `sl-0-currencies-rates-parser` и `sl-1-currency-rates-sync` были в петле
`ERR_MODULE_NOT_FOUND src/currenciesRatesParser.js` — точки входа удалены из sl-back (98af83ebc),
compose mp-config-local их ещё запускает. Починено оверрайдами local-stack (`mp` ed4cea7): тем же
сервисам команда `node ./src/jobs.js`, контейнеры `sl-0-main-jobs` / `sl-1-instance-jobs`. Команда
чужой compose не чинит, но о петле молчать не должна.

**После core — курсы валют на свежем стенде.** `shared.currency_rates` пуста до расписания парсера.
Probe: `select count(*) from shared.currency_rates` на sl-0 = 0 → `node cli service:currenciesRatesParser
backfill` в `sl-0-cli` (~10 мин, публичный XML ЦБ; дни с `ECONNRESET` пропускаются — их догнать
`loadData --date-from D --date-to D`, список — по строкам `backfill: <дата> error` лога), затем
`node cli service:currencyRatesSync syncFullHistory` в `sl-N-cli` каждого инстанса (`syncFromMain`
берёт только последнюю неделю). Не пусто → пропуск. Живой замер 2026-09-24: 8178 строк, 1363 дня,
2023-01-01…2026-09-24, на sl-0 и sl-1 одинаково.

**Шаг 5, web — инфра SW из local-stack, а не из mp-config-local.** Web-стек (`local-stack/
docker-compose.yml`) держит `sw-back`/`sw-front` в внешней сети `local-stack-sw-db-net`, которую
создаёт `local-stack/infra/compose.sw-infra.yaml`. Прежний шаг поднимал `pg redis` из
`mp-config-local/compose.sw-back.yaml` (сеть `mp-config-local_ws_default`), и web падал
`network local-stack-sw-db-net declared as external, but could not be found`. Имена контейнеров у
обоих (`mp-sw-pg`, `redis-dev`) одинаковые, том `mp-sw-pg-vol` общий. Новый шаг:
- probe: `mp-sw-pg` / `redis-dev` существуют и подключены к `local-stack-sw-db-net` → пропуск;
- иначе существующие с этими именами — `docker rm -f` (данные в именованном томе, не теряются) и
  `docker compose` c env-файлами local-stack (`local-stack/stack`, функция `env_file_args`) `-f
  local-stack/infra/compose.sw-infra.yaml up -d`; без env-файлов compose падает `no port specified:
  5451:<empty>`.

**Шаг 5, web — не через зависимости `stack`.** `local-stack/stack up sw-back` тянет транзитивно
свои `mp-nats`, sl-0 и т.д. и падает `Conflict. The container name "/mp-nats" is already in use`:
у стенда mp-init эти роли уже заняты флотом mp-config-local. Web поднимать `docker compose -f
local-stack/docker-compose.yml up -d --no-deps --force-recreate sw-back sw-front sl-front` с
окружением процесса:
- `SW_BACK_SRC`, `SW_FRONT_SRC`, `SL_FRONT_SRC` — абсолютные пути к чекаутам;
- `SW_BACK_DEPS_TAG` = `sha256(Dockerfile.deps + package.json + package-lock.json + .npmrc)[:16]`
  по чекауту sw-back (формула `sw-back/.ci/build.yml`, в local-stack — `stack`, функция
  `sw_back_deps_tag`): sw-back собирается поверх `nexus.btlz-api.ru/base-images/sw-back-deps:<тег>`,
  потому что у общей учётки Nexus нет роли на npm (`npm-mcp-gateway` → 403), а на Docker-реестр
  есть. Нет такого тега в реестре (probe `docker manifest inspect`) → предупреждение `sw-back: нет
  образа зависимостей под этот lock (<тег>)`, sw-back не поднимается, sw-front/sl-front — да;
- `SW_BACK_INTERNAL_API_URL=http://internal-api:5100`: internal-api у флота mp-config-local —
  контейнер `sl-0-internal-api` с алиасом `internal-api`, а дефолт local-stack — `mp-internal-api`
  (свой флот). Значение берётся из `local-stack/.env`, если там задано.

**Шаг 5, Nexus — вход в Docker-реестр.** Pull `sw-back-deps` требует `docker login
nexus.btlz-api.ru`. Probe: в `~/.docker/config.json` есть `auths["nexus.btlz-api.ru"]` → пропуск.
Нет, но в `local-stack/.env` есть `NPM_AUTH` (base64 `логин:пароль`, README local-stack, раздел
«Nexus») → `docker login nexus.btlz-api.ru -u <логин> --password-stdin`; пароль — только stdin,
не печатать ни в dry, ни в логе. Нет ни того, ни другого → предупреждение с путём к README, sw-back
не поднимается.

**Шаг 6 (новый), стенд вертикали ozon.** `local-stack/ozon` — отдельный compose-проект (`ozon-*`,
порты вне коллизий). Есть чекаут `<корень>/ozon` → поднять идемпотентно:
1. `docker compose -f local-stack/ozon/docker-compose.yml up -d pg redis clickhouse verdaccio dev`.
2. `@sw-back/workspace-access` в Verdaccio стенда — ровно той версии, что в `ozon/pnpm-lock.yaml`
   (2026-09-24: lock 0.4.0, чекаут sw-back уже 0.6.1). Probe: `npm view @sw-back/workspace-access@<v>
   --registry http://verdaccio:4873` в `ozon-dev`. Нет → исходники пакета из коммита sw-back, где
   `packages/workspace-access/package.json` имеет эту версию (`git log -S'"version": "<v>"'`),
   `git archive` → `docker cp` в `ozon-dev` → `npx -y -p typescript@5 tsc -p tsconfig.json`
   (ошибки `Cannot find module '@nestjs/common'` ожидаемы, на эмит не влияют; проверить, что
   `dist/` не пуст) → `npm publish --registry http://verdaccio:4873
   --//verdaccio:4873/:_authToken=local-stand`. Хеш в lock совпал с собранным (проверено: frozen
   install прошёл).
3. `node_modules` нет → в `ozon-dev`: `corepack enable --install-directory /tmp/bin`, `pnpm install
   --config.@sw-back:registry=http://verdaccio:4873` (CI=1 → frozen), `pnpm --filter "./packages/*"
   run build`, `pnpm --filter @ozon/datacore build`, `pnpm --filter @ozon/ingest build`.
4. `--profile migrate run --rm migrate` (dbmate сам идемпотентен).
5. `up -d datacore datacore-worker ingest front`.
Проверка: `curl localhost:5200/health` → 200, `localhost:3100/ozon/app/...` → 200 (фронт собран с
`basePath=/ozon/app`, корень отдаёт 404 — это не ошибка).

**Финал — сквозная проверка ответом, а не живостью контейнера.** `curl` c таймаутом: `http://sw.
localhost` → 200, `http://sw.localhost/api/metrics` → 200, `http://sl-dev.localhost` → 200, ozon — как
выше. Не 200 → предупреждение с адресом и кодом. `sl-0` `/api/health` сразу после старта отвечает
503 при `database: ok` из-за эвристики памяти (heap 96 % на старте) — не считать отказом, смотреть
`checks.database`.

**Не делать.** Не накатывать миграции sl-back из стороннего кода, не править compose
mp-config-local и не задавать `known_hosts` / личность git — это решения владельца (см. `mp-clone.md`).

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
- `dry` не выполняет ни одной мутации (create/build/up/stop/login);
  probe'ы выполняются в обоих режимах.
- Образ собирается только при отсутствии его тега (M1); есть тег —
  пропуск, без сравнения с исходниками.
- Отсутствие web-части (каталог, web-образ) не считается ошибкой core.

## Граничные случаи и ошибки

- Каталог mp-config-local не найден → stderr `mpu mp-init: каталог
  mp-config-local не найден: <путь>; попробуй: задай
  MPU_MP_CONFIG_LOCAL=<путь>`, exit 2.
- Обязательный образ отсутствует: реальный прогон — сборка (M1); `dry` —
  строка сборки печатается, команды всех стеков — дальше.
- Создание сети/тома с rc≠0 → сообщение + exit rc.
- Стоп-шаг конфликтующих контейнеров в dry-run печатает stop-команду со
  ВСЕМ списком конфликтов и комментарием `# только запущенные`; в
  реальном прогоне список фильтруется по фактически запущенным.
- Любой `up` с rc≠0 → fail-fast, следующие стеки не поднимаются,
  exit = rc docker.


## Сценарии M1 (core с нуля)

Стенд: порт docker подменён (записывает команды, отвечает по «Дано»);
каталоги `M=/home/operator/mr/mp/mp-config-local`,
`L=/home/operator/mr/mp/local-stack`, `P=/home/operator/mr/mp` — как в
голдене `dry-run.stdout`. Весь вывод — stderr.

| # | Дано | Строка | stderr (фрагмент; прочее — как в голдене) | код |
|---|---|---|---|---|
| M1-1 | нет `mp-back:local` | `mpu ask mp-init dry` | до строк стеков: `собираю mp-back:local\n$ docker build --load -t mp-back:local -f $M/Dockerfile.mp-back $P\n`; сборки нет | 0 |
| M1-2 | то же | `mpu ask mp-init` | `собираю mp-back:local`, сборка выполнена, затем стеки | 0 |
| M1-3 | сборка `mp-pg:local` падает rc 17 | `mpu ask mp-init` | `mpu mp-init: сборка mp-pg:local упала (rc=17)\n`; стеки не поднимаются | 17 |
| M1-4 | все образы есть | `mpu ask mp-init dry` | строк `собираю` нет | 0 |
| M1-5 | в `$L/overrides/sl-main.observability-off.yaml` сервис `m-nats-listeners`, в compose sl-0 его нет (`config --services` без него) | `mpu ask mp-init dry` | `mpu mp-init: override $L/overrides/sl-main.observability-off.yaml: нет в compose: m-nats-listeners\n`; стеки с sl-0 не поднимаются (и в `dry` — печать обрывается) | 1 |
| M1-6 | `docker wait sl-0-migrations` → 1, `docker logs --tail 30` → `Error: relation x` | `mpu ask mp-init` | `миграции sl-0 упали\n` и хвост лога; sl-1 не поднимается | 1 |
| M1-7 | `docker wait sl-0-migrations` → 0, `count(*)` → 183 | `mpu ask mp-init` | `sl-0: миграции ок, 183 в public.migrations\n` | 0 |
| M1-8 | после core `sl-0-currencies-rates-parser` в `Restarting`, последняя строка лога `ERR_MODULE_NOT_FOUND` | `mpu ask mp-init` | `warning: sl-0-currencies-rates-parser: Restarting — ERR_MODULE_NOT_FOUND\n` | 0 |
| M1-9 | `docker wait` не отвечает 10 мин (часы — порт) | `mpu ask mp-init` | `миграции sl-0: нет завершения за 10 мин\n` | 1 |

Решения хоста по вопросам исполнителя M1 (2026-09-26): (1) M1 собирает
только три core-образа, `sl-front-dev:local` до M3 — предупреждение; (2)
команды сборки — литералы build-алиасов (`mp-pg` — `-f $M/pg/Dockerfile
$M/pg`, `mp-dt` — `-f $M/Dockerfile.mp-data-transfer $P`), перед каждой —
`собираю <образ>`, в `dry` — обе строки; (3) `count(*)` — проба без печати
`$`: `docker exec sl-N-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
-tAc "select count(*) from public.migrations"'`, rc ≠ 0 → `sl-N: миграции ок,
? в public.migrations`, код не меняется; (4) сводка — только контейнеры
compose-проектов каталога mp-config-local (`docker ps -a --filter
label=com.docker.compose.project.working_dir=$M --format
'{{.Names}}\t{{.Status}}'`), `Exited (0)` и `*-migrations` отбрасываются;
после dt-host, до web; (5) в `dry` `wait`, `count` и сводка не выполняются,
`config --services` — проба, выполняется; (6) сервисы override-файла — узкий
разбор строк (ключи с отступом 2 под `services:`, комментарии и пустые
строки пропускаются), без новой зависимости; живые файлы — фикстура
`fixtures/mp-init/overrides/*.yaml`; (7) голден M1-1 —
`fixtures/mp-init/dry-run-no-image.stdout` (положил хост). Отказы — с
префиксом `mpu mp-init: ` (M1-6, M1-9 тоже).

Литералы строк `собираю`, `миграции … упали`, `warning:` — спецификатора
по форме живых сообщений команды; голден `dry-run.stdout` дополняется
исполнителем при M1-1 (фикстура другой машины — строка сборки только в
сценарии «нет образа»).

## Сценарии M2 (курсы валют на свежем стенде)

Шаг — после core (и сводки M1), до web. Проба — без печати `$`:
`docker exec sl-0-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc
"select count(*) from shared.currency_rates"'` (снято 2026-09-26 на живом
стенде: `8178`, даты 2023-01-01…2026-09-24, на sl-0 и sl-1 одинаково).
Первым пунктом порции — путь `MPU_MP_CONFIG_LOCAL` нормализуется (хвостовой
`/` снимается): иначе метка compose в сводке M1 не совпадает (снято:
`working_dir=$M/` — пусто).

| # | Дано | Строка | stderr (фрагмент) | код |
|---|---|---|---|---|
| M2-1 | проба → `0` | `mpu ask mp-init` | `курсы валют пусты — заполняю (~10 мин)\n$ docker exec sl-0-cli node cli service:currenciesRatesParser backfill\n$ docker exec sl-1-cli node cli service:currencyRatesSync syncFullHistory\n` | 0 |
| M2-2 | проба → `8178` | `mpu ask mp-init` | `курсы валют: 8178 строк — пропуск\n`; команд заполнения нет | 0 |
| M2-3 | проба → `0` | `mpu ask mp-init dry` | те же три строки `$ …`, ничего не выполнено; строка `курсы валют пусты — заполняю` печатается | 0 |
| M2-4 | backfill → rc 1 | `mpu ask mp-init` | `mpu mp-init: курсы валют — backfill упал (rc=1); web не поднимаю\n` | 1 |
| M2-5 | backfill 0, в его выводе строки `backfill: 2024-03-05 error ECONNRESET`, `backfill: 2024-03-06 error ECONNRESET` | `mpu ask mp-init` | `warning: курсы валют — пропущены дни 2024-03-05, 2024-03-06: догнать mpu … loadData --date-from D --date-to D\n` (одна строка на все дни; команда `node cli service:currenciesRatesParser loadData --date-from D --date-to D` в `sl-0-cli`) | 0 |
| M2-6 | проба → rc ≠ 0 (`sl-0-pg` недоступен) | `mpu ask mp-init` | `warning: курсы валют — проба не удалась, шаг пропущен\n` | 0 |
| M2-7 | инстансов sl-N в кортеже core два (sl-0 main, sl-1) | M2-1 | `syncFullHistory` — в `sl-1-cli` (у каждого инстанса, не у main) | 0 |
| M2-8 | `MPU_MP_CONFIG_LOCAL=/x/mp-config-local/` | `mpu ask mp-init` | сводка M1 отбирает по `working_dir=/x/mp-config-local` (без `/`) | 0 |

Sync — только у инстансов (`sl-1-cli`): sl-0 (main) заполняет таблицу
backfill-ом сам, `syncFromMain`/`syncFullHistory` тянут с main.

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

До реализации раздела «Подъём с нуля — требования 2026-09-24» команда на чистой машине не
поднимает стенд: стоп на отсутствующих образах, падение sl-0 на устаревшем override, web без сети
`local-stack-sw-db-net`, недомигрированная схема без сигнала.

## Открытые вопросы

нет
