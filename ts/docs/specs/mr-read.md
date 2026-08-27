# mpu mr — чтение (view, files, diff, comments, show)

Статус: черновик

## Назначение

Read-подкоманды `mpu mr`: шапка MR, изменённые файлы, unified diff,
треды ревью, один тред целиком. Мутаций нет. Авторизация, резолв
`--mr`, эндпоинты, модель дискуссий и тексты ошибок резолва —
`platform/gitlab-api.md` (далее — атом); write-подкоманды —
`mr-write.md`.

## CLI-контракт

Общее: каждая подкоманда принимает `--mr REF` (URL |
`'group/repo!iid'` | iid; без флага — открытый MR текущей ветки cwd;
резолв — атом). JSON-вывод (`--json`) везде: отступ 2,
не-ASCII-символы как есть, завершающий перевод строки.

`mpu mr view [--mr REF] [--json]`

- default — четыре строки + описание:
  ```
  MR {project}!{iid} — {title} [{state}]
  author: {имя автора; пустое → username} (@{username})
  branch: {source_branch} → {target_branch}
  url:    {web_url}
  ```
  описание непустое → пустая строка + описание без хвостовых переводов
  строки;
- `--json` — объект MR: project, iid, title, state, source_branch,
  target_branch, web_url, author_name, author_username, description,
  diff_refs (`{base_sha, start_sha, head_sha}` | null), project_id,
  sha, merge_commit_sha, squash_commit_sha.

`mpu mr files [--mr REF] [--json]`

- таблица с колонками ST / + / - / FILE (рамки и выравнивание таблицы
  не фиксируются): ST — статус A/D/R/M (атом); `+N` / `-M` — счётчики
  added/removed строк из разбора diff файла; FILE — new_path (пустой →
  old_path), для R с разными путями — `{old_path} → {new_path}`;
- хвост `({N} files, +{A} / -{D})` — суммы по всем файлам;
- `--json` — массив `{status, old_path, new_path, additions,
  deletions}`.

`mpu mr diff [--mr REF] [--file SUBSTR] [--json]`

- блок на файл, блоки разделены пустой строкой; заголовок
  `diff --git a/{old_path} b/{new_path}` + суффикс `  [new file]` /
  `  [deleted file]` / `  [renamed]` при статусе A/D/R; тело — diff
  без хвостовых переводов строки; пустой diff →
  `(binary / без текстового диффа)`;
- `--file SUBSTR` — substring-фильтр по new_path ИЛИ old_path; ни
  одного совпадения → exit 1
  `нет изменённых файлов по подстроке '<SUBSTR>'`;
- без фильтра и без изменённых файлов →
  `(MR без изменённых файлов)`, exit 0;
- `--json` — массив (после фильтра) `{old_path, new_path, diff,
  new_file, renamed_file, deleted_file}`.

`mpu mr comments [--mr REF] [--unresolved] [--file SUBSTR]
[--author SUBSTR] [--json | --md]`

- базовый список — треды MR без системных нот (атом); фильтры
  складываются:
  - `--unresolved` — только resolvable и не resolved;
  - `--file` — substring по new_path или old_path позиции треда; тред
    без позиции отпадает;
  - `--author` — substring без учёта регистра по строке
    `{username} {имя}` первой ноты;
- default: строка `MR {project}!{iid} — {title} [{state}]` + таблица
  DISC / RES / LOCATION / AUTHOR / NOTES / EXCERPT (оформление не
  фиксируется) + хвост `({N} discussions, {M} unresolved)`, где M —
  число тредов resolvable и не resolved после фильтров:
  - DISC — первые 8 символов id;
  - RES — `✓` (resolved), `·` (open), пусто (general-тред);
  - LOCATION — `{new_path}:{new_line}`; у позиции только со старой
    стороной — `{old_path}:{old_line} (old)`; у позиции без номеров —
    только путь; у треда без позиции — пусто;
  - AUTHOR — username первой ноты (пустой → имя);
  - NOTES — число нот; EXCERPT — первая строка первой ноты до 60
    символов, при обрезке последний символ — `…`;
- `--json` — массив `{id, resolvable, resolved, location:
  <строка-как-LOCATION> | null, notes: [...]}`; нота: id, body,
  author_name, author_username, created_at, updated_at, system,
  resolvable, resolved, type, position (`{old_path, new_path,
  old_line, new_line}` | null);
- `--md` — markdown: `# MR {project}!{iid} — {title} [{state}]`,
  пустая строка; на тред — `## {id[:8]} · {LOCATION | general} ·
  {status}`, где status — `note` (general) | `open` | `resolved`;
  затем на каждую ноту: `**{имя; пустое → username}** (@{username}) ·
  note {id} · {YYYY-MM-DD HH:MM}` (первые 16 символов created_at,
  `T` → пробел), пустая строка, тело, пустая строка; после нот треда —
  `---` и пустая строка.

`mpu mr show DISCUSSION [--mr REF] [--json]`

- DISCUSSION — полный id или уникальный префикс ≥6 символов (матчинг
  и ошибки — атом);
- default: `discussion {полный id} · {LOCATION | general} ·
  {note|open|resolved}` + на каждую ноту: пустая строка, заголовок
  ноты (как в `--md`), тело;
- `--json` — объект в форме элемента `comments --json`.

## Ввод/вывод

stdout — данные; stderr — `mpu mr <подкоманда>: <сообщение>` (атом),
без трейсбеков. Exit: 0 — успех; **2 — всё, что разобрано до сети**
(неизвестный флаг, пропущенный DISCUSSION, нераспознанный `--mr`,
взаимоисключающие флаги); **1 — всё после обращения наружу**: ответы
GitLab, «MR не найден», «дискуссия не найдена», ошибки данных.
Разведение кодов — решение 2026-08-27, обоснование в «Открытых
вопросах»; прежняя редакция отдавала `1` и ошибкам резолва тоже.

## Побочные эффекты

Только чтение: HTTP GET к GitLab и локальные git-подпроцессы при
неполном `--mr` (атом). Ни записи, ни кэша, ни БД; stdin не читается.

## Конфигурация

`GLAB_TOKEN` (обязателен), `GITLAB_BASE_URL` — атом.

## Инварианты

- Ни одна подкоманда не выполняет пишущий HTTP-запрос
  (POST/PUT/DELETE).
- Системные ноты не появляются ни в одном выводе, ни в одном формате.
- Порядок файлов и тредов — порядок ответа API; одинаков в таблице,
  `--json` и `--md`.
- Человекочитаемый вывод и `--json` построены из одних данных:
  счётчики хвостов равны суммам по `--json`.
- Токен не попадает ни в stdout, ни в stderr.

## Граничные случаи и ошибки

- `--mr` задан, но не распознан (не URL, не `group/repo!iid`, не iid) →
  exit 2, до сети.
- `--mr` не задан + detached HEAD / 0 / >1 открытых MR ветки →
  exit 1, тексты — атом: это исход обращения к git, а не разбор ввода.
- HTTP 401 / 404 → exit 1, `gitlab error: …` с подсказкой (атом).
- MR без изменённых файлов: `files` — пустая таблица +
  `(0 files, +0 / -0)`; `diff` — `(MR без изменённых файлов)`; exit 0.
- Binary-файл: в `files` `+0` / `-0`; в `diff` —
  `(binary / без текстового диффа)`.
- `comments` после фильтров пусто → заголовок + пустая таблица +
  `(0 discussions, 0 unresolved)`, exit 0.
- `show` с префиксом короче 6 / не найденным / неоднозначным →
  exit 1, тексты — атом.

## Golden-примеры

Сняты 2026-08-27 с рабочей версии на живом MR (все вызовы read-only), затем
обезличены: путь проекта → `group/repo`, хост → `gitlab.example.test`, имена,
ветки, заголовок, описание и тела комментариев заменены, длинные массивы
урезаны до 2–3 элементов. Форма и состав ключей — как в ответе.

- `fixtures/mr-read/view.json` — `mr view --json`: пятнадцать ключей, включая
  `diff_refs` и `project_id`;
- `fixtures/mr-read/files.json` — `mr files --json`: массив
  `{status, old_path, new_path, additions, deletions}`;
- `fixtures/mr-read/comments.json` — `mr comments --json`: массив тредов
  `{id, resolvable, resolved, location, notes}`; `location` непустой у
  инлайн-треда и `null` у общего;
- `fixtures/mr-read/err-mr-not-found.stderr` — `mr view` на несуществующий
  iid: одна строка с методом, путём, кодом и телом ответа плюс подсказка по
  форме `--mr`, exit 1;
- `fixtures/mr-read/err-diff-no-match.stderr` — `mr diff --file` без
  совпадений: `нет изменённых файлов по подстроке '<строка>'`, exit 1.

Человекочитаемые формы (`view` без `--json`, `files`, `comments --md`)
голденами не закрываются: `files` рисуется рамкой по ширине терминала, и
побайтовое сравнение ловило бы ширину, а не контракт. Для них спека фиксирует
состав колонок и порядок строк, а тест проверяет наличие полей, не раскладку.

## Известные отклонения

- **fix** — конфликт `--json`/`--md` у `comments` не валидируется:
  заданы оба — молча печатается JSON. Правильное поведение — exit 2
  `only one of --json / --md can be set` (по образцу конфликтов
  форматов вывода в `xlsx.md`).

## Открытые вопросы

нет.

Коды выхода разведены (решение спецификатора 2026-08-27, вердикт **fix**):
**2** — ошибки ввода, разбираемые до сети (нераспознанный `--mr`, отсутствующий
обязательный аргумент, взаимоисключающие флаги, файл тела не найден); **1** —
всё, что случилось после обращения наружу (HTTP-коды GitLab, недоступность
сети) и «сущность не найдена» на стороне GitLab (MR, дискуссия, файл в диффе).
Рабочая версия отвечает `1` на всё подряд — это противоречит контракту команд
монорепо (`platform/command-contract.md`), где `2` закреплено за ошибками
ввода; сохранять единицу значило бы вносить исключение в общее правило ради
одной семьи команд.
