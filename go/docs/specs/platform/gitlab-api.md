# platform/gitlab-api — клиент GitLab MR API

Статус: черновик

## Назначение

Платформенный атом команд над GitLab merge-request'ами (`mr-read.md`,
`mr-write.md`): авторизация, резолв MR-адреса, эндпоинты REST API v4,
разбор unified diff и position-механика инлайн-комментариев (самая
хрупкая часть — дословно).

## CLI-контракт

нет (платформенная возможность; синтаксис MR-селектора — ниже).

## Ввод/вывод

### Резолв MR-адреса

Вход: строка-селектор MR (или её отсутствие) + текущий каталог.
Выход: `(project, iid)`; project — путь `group/repo`. Шаги:

1. Селектор задан — разбор, формы:
   - голое число → iid; project остаётся неопределённым;
   - `http(s)://…` → `host[:port]` URL обязан совпадать с `host[:port]`
     `GITLAB_BASE_URL`, иначе ошибка
     `хост MR-URL '<host>' != '<ожидаемый>' (GITLAB_BASE_URL)`; путь
     обязан содержать `/-/merge_requests/<iid>` (project — путь до
     маркера без крайних `/`; iid — первый сегмент после маркера,
     только цифры; хвост пути и query игнорируются), иначе
     `не удалось разобрать MR-URL '<селектор>'`;
   - строка с `!` → `group/repo!iid` (разделитель — последний `!`);
     пустой project или нечисловой iid → `ожидается 'group/repo!iid',
     получено '<селектор>'`;
   - прочее → `не удалось разобрать MR '<селектор>'; формы: URL |
     'group/repo!iid' | iid`.
2. project не определён → `git remote get-url origin` в cwd; формы
   `ssh://[user@]host[:port]/path`, scp (`git@host:path.git`),
   `https://host/path`; project = путь без крайних `/` и суффикса
   `.git`. Хост (без порта) ≠ хосту `GITLAB_BASE_URL` → `git remote
   смотрит на '<host>', а не на '<ожидаемый>' — укажи MR через --mr`;
   git не найден → `git не найден в PATH — укажи MR через --mr`; git
   упал → `<stderr git без крайних пробелов> — укажи MR через --mr`;
   remote не разобрался → `не удалось разобрать git remote '<url>'`.
3. iid не определён → текущая ветка `git rev-parse --abbrev-ref HEAD`;
   вывод `HEAD` (detached) → `detached HEAD — не определить ветку,
   укажи MR через --mr`; затем GET открытых MR ветки (эндпоинт ниже):
   0 MR → `нет открытого MR ветки '<branch>' в <project> — укажи --mr`;
   больше одного → `несколько открытых MR ветки '<branch>':
   <project>!<iid> <title>; … — укажи --mr`; ровно один → его iid.

### HTTP-клиент

База `<GITLAB_BASE_URL>/api/v4`; заголовки `PRIVATE-TOKEN:
<GLAB_TOKEN>` и `Accept: application/json`; таймаут 30 s (connect
10 s); системные proxy-переменные (`HTTP_PROXY`/…) игнорируются —
хост внутренний. Пагинированные GET: `per_page=100`, `page=1,2,…`
до первой страницы короче 100 элементов.

Эндпоинты (`{p}` — URL-encoded project: `grp/repo` → `grp%2Frepo`;
`…` — префикс `/projects/{p}/merge_requests/{iid}`):

| Запрос | Назначение |
| --- | --- |
| GET `/projects/{p}/merge_requests/{iid}` | шапка MR + diff_refs |
| GET `/projects/{p}/merge_requests?source_branch=<b>&state=opened` | открытые MR ветки (пагинировано) |
| GET `…/changes?access_raw_diffs=true` | файлы MR с полным diff, один ответ без пагинации |
| GET `…/discussions` | треды MR (пагинировано) |
| POST `…/discussions` | новый тред: form-поле `body` + position-ключи (инлайн) |
| POST `…/discussions/{id}/notes` | ответ в тред: form-поле `body` |
| PUT `…/notes/{note_id}` | заменить тело ноты: form-поле `body` |
| DELETE `…/notes/{note_id}` | удалить ноту |
| PUT `…/discussions/{id}?resolved=true\|false` | резолв треда (query-параметр) |
| PUT `/projects/{p}/merge_requests/{iid}` | заменить описание: form-поле `description` |
| POST `/projects/{p}/merge_requests` | создать MR: form `source_branch`, `target_branch`, `title`, `description` (только непустое) |

Diff файлов — ТОЛЬКО из `/changes?access_raw_diffs=true`, не из
`/diffs`: тот в крупных MR отдаёт часть файлов свёрнутыми
(`collapsed: true`, пустой `diff`), теряя дифф и привязку комментария.

Тела запросов — `application/x-www-form-urlencoded`. Не-2xx-ответ или
сетевой сбой → ошибка API с сообщением
`gitlab <METHOD> <path> -> <status>: <тело ответа до 300 символов>`;
у сетевого сбоя status = 0, вместо тела — текст сбоя.

### Данные ответов

MR: project (из адресации — API в этом виде его не отдаёт), iid,
title, state, source_branch, target_branch, web_url, автор (name,
username), description, diff_refs `{base_sha, start_sha, head_sha}`.
Любой SHA пуст или отсутствует → diff_refs отсутствует целиком
(частичного не бывает; у MR без коммитов diff_refs нет).

Файл MR: old_path, new_path, diff (unified), флаги new_file /
renamed_file / deleted_file. Статус одной буквой, в порядке проверки:
A (new_file), D (deleted_file), R (renamed_file), M (иначе).

Дискуссия: id (40-hex) + ноты. Нота: id (целое), body, автор (name,
username), created_at, updated_at, system, resolvable, resolved, type,
position `{old_path, new_path, old_line, new_line}` либо отсутствует.
Дискуссия resolvable ⇔ есть хотя бы одна resolvable-нота; resolved ⇔
resolvable-ноты есть И все они resolved (general-тред без них: оба
false); позиция дискуссии = position первой ноты, у которой она есть.

Системные ноты (system=true) исключаются на входе всегда: нота
отбрасывается, тред из одних системных нот выпадает целиком; все
потребители (списки, матчинг, ответы, резолв) видят очищенные треды.

### Разбор unified diff

Вход — текст поля `diff` одного файла, построчно: всё до первого
hunk-заголовка `@@ -A[,B] +C[,D] @@` пропускается (заголовок ставит
счётчики old=A, new=C); строка, начинающаяся с `\`
(`\ No newline at end of file`), пропускается; `+…` → added (номер
только на new-стороне, new++); `-…` → removed (номер только на
old-стороне, old++); любая другая, включая полностью пустую (контекст
без ведущего пробела), → context (номера на обеих сторонах, оба++).
Пустой diff (binary-файл) → ноль строк.

Стороны адресации: `new` — правая колонка диффа GitLab, `old` —
левая; removed не адресуется new-стороной, added — old-стороной.
«Комментируемые диапазоны» стороны — непрерывные диапазоны её
номеров, текстом `10-12, 240` (одиночный номер без тире).

### Position инлайн-комментария

Form-ключи POST `…/discussions`; всегда: `position[position_type]=text`,
`position[base_sha]`, `position[start_sha]`, `position[head_sha]` (SHA
из diff_refs MR), `position[old_path]`, `position[new_path]` (оба пути
всегда — закрывает rename). Номера — по типу целевой строки: added →
только `position[new_line]`; removed → только `position[old_line]`;
context → оба (GitLab требует обе для неизменённой строки).

### Матчинг дискуссии по селектору

Вход — строка DISCUSSION, без учёта регистра: точное совпадение id →
она; длина < 6 → `префикс id дискуссии короче 6 символов: '<ref>'`;
нет тредов с таким префиксом id → `дискуссия '<ref>' не найдена в
этом MR`; несколько → `префикс '<ref>' неоднозначен: <первые 12
символов каждого id через запятую>`.

### Ошибки на уровне команды

Подкоманды `mr` печатают ошибки в stderr строкой `mpu mr <подкоманда>:
<сообщение>`, exit 1 (валидация аргументов до сети — exit 2, см.
командные спеки). API-ошибка: `gitlab error: <сообщение атома>`; при
401 добавляется `; проверь GLAB_TOKEN в <путь env-файла>`, при 404 —
`; проверь --mr (URL | 'group/repo!iid' | iid)`. Нет GLAB_TOKEN →
exit 1, ошибка env-слоя с путём env-файла (`platform/config.md`).

## Побочные эффекты

HTTP к `GITLAB_BASE_URL`; локальные git-подпроцессы
(`git remote get-url origin`, `git rev-parse --abbrev-ref HEAD`)
только при неполном селекторе. Ни записи в БД/файлы, ни кэша.

## Конфигурация

`GLAB_TOKEN` — обязателен (personal access token со scope `api`);
`GITLAB_BASE_URL` — опционален, дефолт `https://gitlab.btlz-api.ru`.
Оба — env-слой (`platform/config.md`).

## Инварианты

- Position и тела запросов — всегда form-urlencoded, никогда JSON-боди.
- `position[old_path]` и `position[new_path]` присутствуют всегда;
  added несёт только new_line, removed — только old_line, context — обе.
- Системные ноты не достигают ни одного потребителя атома.
- Diff файлов всегда берётся из `/changes?access_raw_diffs=true`.
- MR-URL с хостом, отличным от `GITLAB_BASE_URL`, отклоняется всегда,
  даже структурно валидный.
- Резолв не мутирует состояние; сеть в нём — только поиск открытых MR;
  полный селектор (URL, `group/repo!iid`) не запускает git вовсе.
- Токен не попадает ни в сообщения ошибок, ни в вывод.

## Граничные случаи и ошибки

- URL с хвостом после iid (`…/merge_requests/123/diffs?tab=x`) →
  project и iid извлечены, хвост игнорируется.
- scp-remote `git@host:group/repo.git` → project `group/repo`.
- ssh-remote с портом: порт в сверке хоста не участвует.

## Golden-примеры

Фикстуры в `fixtures/mr/` — обезличенные ответы живого инстанса, снять
при переводе в «к реализации»: шапка MR с diff_refs и без; `/changes` с
added/removed/context-строками, rename и binary; `/discussions` с
инлайн-, general- и системными тредами; position-наборы трёх типов строк.

## Известные отклонения

- **preserve** — position передаётся только form-urlencoded скобочными
  ключами. Причина: инсталляция GitLab молча игнорирует position,
  переданный вложенным JSON-объектом, — комментарий создаётся, но БЕЗ
  привязки к строке; «исправление» на JSON ломает инлайн незаметно.

## Открытые вопросы

- Атом обслуживает и `glab-status` (глобальный список моих MR, ветки,
  содержащие коммит); эти эндпоинты фиксируются при снятии её спеки.
