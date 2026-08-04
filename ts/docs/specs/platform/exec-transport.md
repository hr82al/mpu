# platform/exec-transport — выполнение команд в контейнерах

Статус: черновик (адаптирована 2026-08-04 под один бинарь: транспорт
исполняется с машины пользователя, пути env-файла и ssh-ключей — его
окружение)

## Назначение

Единый транспорт удалённого выполнения: доставить shell-команду в
контейнер фермы (`mp-sl-N-cli` либо точное имя), стримить stdout/stderr
и вернуть код выхода 1:1. Бэкенды взаимоисключающие — Portainer (HTTP +
WebSocket) и ssh + `docker exec`, выбор per-server. Поверх — detach и
кэш контейнеров. Потребители: `ssh`, `run-js`, `ps`, `health`.

## CLI-контракт

нет (платформенная возможность).

## Ввод/вывод

Вход: таргет — номер сервера (контейнер `mp-sl-N-cli`; опционально
флаг dev-стенда) либо точное имя контейнера; команда (argv-список либо
единственная строка); stdin (байты); override транспорта; режим захвата
(вывод буферизуется вызывающему — для параллельного fan-out).
Результат: поток stdout/stderr + код выхода.

**Выбор транспорта для сервера N** (без override):

- Portainer доступен ⇔ есть Portainer-таргет сервера (см. «Кэш
  контейнеров») И env `PORTAINER_API_KEY`.
- ssh доступен ⇔ env `sl_<N>` (IP) И `PG_MY_USER_NAME`.
- Доступны оба → Portainer (единственный путь до всей фермы). Ни один →
  exit 2, stderr: `<команда>: для sl-<N> не задано ни sl_<N>
  (+PG_MY_USER_NAME) ни sl_<N>_portainer (+PORTAINER_API_KEY)`.
- Override вне `ssh|portainer` → exit 2, stderr:
  `<команда>: --via должен быть ssh|portainer, получено '<значение>'`.
- dev-таргет: всегда ssh + docker на dev-ноду (env `DEV_NODE_HOST` /
  `DEV_NODE_USER`, встроенные дефолты — «Открытые вопросы»); override
  игнорируется. Таргет-контейнер: всегда Portainer; нет API-ключа →
  exit 2 `<команда>: PORTAINER_API_KEY не задан в ~/.config/mpu/.env`.

**Команда → shell-строка** (одинаково для обоих транспортов): один
элемент — как есть (пайпы, редиректы, `VAR=x cmd` исполняет удалённый
шелл); несколько — каждый элемент квотируется для POSIX-shell и
склеивается пробелами (спецсимволы внутри аргумента атомарны).

**ssh-путь**: локальный процесс `ssh -i ~/.ssh/id_rsa <user>@<ip>
<remote>`, где `<remote>` = `docker exec -i mp-sl-<N>-cli sh -c
<shell-строка, POSIX-квотированная>`; stdin процесса = переданные
байты; код выхода = код ssh-процесса (доносит код удалённой команды).

**Portainer-путь** (граница дословно):

1. Все HTTP-вызовы — заголовок `X-API-Key: <ключ>`; проверка TLS
   выключена, если env `PORTAINER_VERIFY_TLS` ≠ `true` (без учёта
   регистра); системные HTTP-прокси игнорируются; docker-пути — префикс
   `<base_url>/api/endpoints/<endpoint_id>/docker`.
2. stdin непустой → до exec'а `PUT /containers/<имя>/archive?path=/tmp`,
   тело — tar с одним файлом `__MPU_PSSH_STDIN` (mode 0644),
   `Content-Type: application/x-tar`; к shell-строке добавляется
   ` < /tmp/__MPU_PSSH_STDIN`.
3. Exec-команда всегда обёрнута: `["sh", "-c", "echo $$ >
   /tmp/__MPU_PSSH_PID; exec sh -c <shell-строка, квотированная>"]` —
   pidfile хранит PID команды для kill при Ctrl+C.
4. `POST /containers/<имя>/exec`, JSON `{"AttachStdout": true,
   "AttachStderr": true, "Tty": true, "Cmd": [...]}` → ответ с `Id`.
5. Стрим — WebSocket
   `GET /api/websocket/exec?id=<Id>&endpointId=<endpoint_id>`: HTTP/1.1
   Upgrade-handshake (`Upgrade: websocket`, `Connection: Upgrade`,
   `Sec-WebSocket-Version: 13`, случайный ключ, `X-API-Key`); ответ не
   `101` → ошибка транспорта, exit 1. Данные при `Tty=true` — сырой
   поток (stdout и stderr слиты) в stdout; входящий ping → pong; в idle
   каждые 30 с шлётся ping; TCP-keepalive включён; Close/EOF завершает.
6. Код выхода: `GET /exec/<Id>/json` → `ExitCode`. `ExitCode` = null
   (exec ещё выполняется) → повторный опрос с паузами суммарно до 2
   секунд; всё ещё null → предупреждение в stderr, код выхода 1.
7. Ctrl+C во время стрима: stderr `mpu: Ctrl+C → killing remote
   process...`; вторым exec'ом — прочитать PID из pidfile (пусто →
   выход 0), `kill -INT`, пауза 1 с, `kill -KILL`; ошибки глотаются.
   Локальный код выхода после прерывания — не контракт.
8. Всегда (и после ошибок/Ctrl+C) — завершающий exec `rm -f
   /tmp/__MPU_PSSH_PID` (+ `/tmp/__MPU_PSSH_STDIN`, если был stdin);
   best-effort, ошибки на код выхода не влияют.

**Логи контейнера** (потребители — `health`, legacy-режим `logs`):
`GET /containers/<имя>/logs?stdout=<bool>&stderr=<bool>&tail=<N>&
follow=false&timestamps=<bool>[&since=<unix-ts>]`. Тело — мультиплекс
Docker (контейнеры без TTY): кадры с 8-байтным заголовком — байт 0 —
тип потока (0=stdin, 1=stdout, 2=stderr), байты 4–7 — длина payload
(big-endian uint32), далее payload. Первый байт кадра вне {0,1,2} →
поток без фрейминга (TTY-контейнер), весь ответ трактуется как stdout.

**Список контейнеров**:
`GET /api/endpoints/<id>/docker/containers/json?all=true` → JSON-массив
объектов Docker: `Names` (имена с ведущим `/`), `Id`, `State`, `Status`,
`Image`. Список endpoint'ов: `GET /api/endpoints` (`Id`, `Name`).

**Фоновый запуск (detach)**: вход — таргет, тело скрипта (ESM), detach
id (8 hex-символов); скрипт `/tmp/mpu-run-<id>.mjs`, лог
`/tmp/mpu-run-<id>.log`. Результат — код запуска + путь лога;
завершения никто не ждёт, процесс переживает разрыв соединения.
Portainer: upload скрипта tar'ом в `/tmp`, затем exec (`Tty=false`)
`["sh", "-c", "nohup node <скрипт> > <лог> 2>&1 < /dev/null &"]`. ssh:
`docker exec -i <контейнер> sh -c 'cat > <скрипт>'` со скриптом на
stdin (ненулевой код прерывает запуск), затем `docker exec -d
<контейнер> sh -c 'node <скрипт> > <лог> 2>&1 < /dev/null'`.

**Кэш контейнеров** — таблица `portainer_containers` в кэш-БД: колонки
`portainer_url` TEXT NOT NULL, `endpoint_id` INTEGER NOT NULL,
`endpoint_name` TEXT, `container_id` TEXT NOT NULL, `container_name`
TEXT NOT NULL, `server_number` INTEGER, `state` TEXT, `image` TEXT,
`discovered_at` INTEGER NOT NULL; PK `(portainer_url, endpoint_id,
container_id)`. Наполнение — `mpu init` (отдельная спека): обход всех
endpoint'ов и всех контейнеров каждого (`?all=true`), upsert по PK;
`server_number` — только для имён `mp-sl-<N>-cli` (ведущий `/`
допустим), включая N=0. Чтения:

- Portainer-таргет сервера N: строка кэша с `server_number = N` →
  `(portainer_url, endpoint_id)`; нет строки → env-fallback
  `sl_<N>_portainer=<base_url>/<endpoint_id>` (endpoint_id — после
  последнего `/`; нечисловой или пустая база → таргета нет).
- Точное имя: `SELECT DISTINCT portainer_url, endpoint_id,
  endpoint_name, container_name FROM portainer_containers WHERE
  container_name = ?`; 1 строка → таргет; 0 → «не найден»; >1 →
  неоднозначность со списком кандидатов. Реплики сервиса на одном
  endpoint'е схлопываются DISTINCT'ом; одно имя на разных endpoint'ах —
  честная неоднозначность (контракт, не дефект).
- Подстрока: `SELECT DISTINCT container_name FROM portainer_containers
  WHERE container_name LIKE '%<фильтр>%' ORDER BY container_name`.
- Номера инстанс-серверов: различные `server_number` NOT NULL и > 0,
  по возрастанию.
- Ошибка кэш-БД (нет файла/таблицы) в этих чтениях → пустой результат;
  наверх всплывает ошибкой уровня команды («… запусти `mpu init`»).

## Побочные эффекты

Реальное выполнение произвольного кода в живом контейнере (прод или
dev) со всем его окружением. Временные файлы в `/tmp` контейнера:
`__MPU_PSSH_STDIN` и `__MPU_PSSH_PID` подчищаются best-effort;
`mpu-run-<id>.mjs` / `.log` остаются намеренно (лог читают позже; живут
до рестарта контейнера). Сеть — только Portainer API либо ssh таргета.
Кэш контейнеров транспорт не пишет.

## Конфигурация

Env-файл (контракт — `platform/env-file.md`): `PORTAINER_API_KEY`,
`PORTAINER_VERIFY_TLS`, `sl_<N>`, `PG_MY_USER_NAME`,
`sl_<N>_portainer`, `DEV_NODE_HOST`, `DEV_NODE_USER`. ssh-ключ —
`~/.ssh/id_rsa`, без настройки. Кэш-БД — bootstrap схемы: `init.md`.

## Инварианты

- Код выхода удалённой команды доходит 1:1 и никогда не схлопывается в
  0 — на обоих транспортах.
- Одна и та же тройка (таргет, команда, stdin) порождает одинаковую
  удалённую shell-строку независимо от транспорта.
- Контейнер по точному имени никогда не исполняется по ssh.
- Интерактивный exec (`Tty=true`) отдаёт stdout+stderr одним потоком;
  раздельные потоки есть только у логов (8-байтный фрейминг).
- Секреты (API-ключ, содержимое env-файла) не попадают ни в вывод, ни
  в тексты ошибок.

## Граничные случаи и ошибки

- Пустой stdin → tar-upload не выполняется, редирект не добавляется.
- WS-handshake ≠ 101 → ошибка транспорта со статус-строкой ответа,
  exit 1.
- Ctrl+C: удалённый процесс убивается явно (разрыв WS Docker'ом не
  замечается); ssh-путь отдельного kill не делает — только разрыв
  ssh-сессии.
- Fallback `sl_<N>_portainer` с битым значением (нет `/`, нечисловой
  id) → таргета нет; сервер считается недоступным по Portainer.

## Golden-примеры

Снять при переводе в «к реализации» (вместе со спеками `ssh`/`run-js`):
эхо-команда на сервере (exit 0); `sh -c 'exit 7'` (наследование кода);
вызов при пустом конфиге (exit 2). Фикстуры ответов Portainer:
create-exec, inspect-exec (включая `ExitCode: null`), containers/json,
endpoints, лог с 8-байтным фреймингом.

## Известные отклонения

- **fix** — тексты транспортных ошибок (`--via`, отсутствие конфига,
  отсутствие API-ключа) в оригинале всегда с префиксом `mpu ssh:`, даже
  при вызове из `mpu run-js`. Правильно — префикс вызвавшей команды.
- **fix** — null `ExitCode` в оригинале немедленно трактуется как код
  1: медленно завершающийся exec может быть ошибочно объявлен упавшим.
  Правильно — ограниченный повторный опрос (п. 6), затем 1.
- **fix** — Portainer-путь фонового запуска в оригинале добавляет к
  launch-команде `echo "mpu: detached, log=<путь>"`, печатаемый в
  stdout, — дублирует статусную строку CLI и отсутствует на ssh-пути.
  Правильно — launch без echo, статус печатает CLI (см. `run-js.md`).
- **preserve** — `Tty=true` сливает stdout и stderr удалённой команды в
  один поток. Причина: без TTY Node в контейнере буферизует вывод
  пакетами ~16 КБ, построчный стрим невозможен — осознанный trade-off.

## Открытые вопросы

- Значения встроенных дефолтов `DEV_NODE_HOST` / `DEV_NODE_USER` в
  черновик не включены (внутренние адреса); при переводе в
  «к реализации» внести значения либо сделать переменные обязательными.
