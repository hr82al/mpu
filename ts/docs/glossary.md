# Глоссарий — термин → имя в TS-коде

Изолированные Deno-сессии не видят кода друг друга; без глоссария каждая
переведёт термины по-своему. Новый термин — новая строка.

| Термин             | Имя в коде            | Пояснение                                                                                   |
| ------------------ | --------------------- | ------------------------------------------------------------------------------------------- |
| реестр команд      | `registry`            | единый список команд: маршрутизация + справка                                               |
| точка входа        | `entrypoint`          | режим вызова команды: CLI для человека или MCP-сервер для агента                            |
| маршрут            | `route`               | способ исполнения команды: `native` (код на TS) или `legacy` (подпроцесс Python-реализации) |
| политика           | `policy`              | объявленный класс команды: `ro` — только читает, `rw` — мутирует                            |
| профиль            | `profile`             | набор тулов одной политики, публикуемый MCP-сервером (`ro` или `rw`)                        |
| тул                | `tool`                | команда маршрута `native`, опубликованная в MCP                                             |
| инструкции профиля | `profileInstructions` | текст, объясняющий клиенту, для каких задач искать тулы этого профиля                       |
| схема аргументов   | `argsSchema`          | описание входа команды; из него строятся и разбор argv, и `inputSchema` тула                |
| схема результата   | `resultSchema`        | описание выхода команды; из него строится `outputSchema` тула                               |
| рендер             | `render`              | преобразование результата команды в текст для человека                                      |
| токен доступа      | `accessToken`         | статический Bearer для MCP-сервера; файл 0600                                               |
| селектор | `Selector` | строка адресации: `sl-N`, client_id, email, IP, spreadsheet_id, sid, заголовок |
| номер сервера | `ServerNumber` | `N` из `sl-N`; main-сервер — `sl-0`, особых веток не имеет |
| клиент | `Client`, `ClientId` | арендатор системы; схема клиента в PG — `schema_<client_id>` |
| кандидат | `Candidate` | строка выдачи резолва селектора (клиент/таблица/сервер) |
| таблица | `Spreadsheet`, `SpreadsheetId` | Google-таблица клиента |
| sid | `Sid` | идентификатор кабинета WB |
| кэш-БД | `Store` | локальная служебная SQLite-БД (`~/.config/mpu/mpu.db`) |
| env-файл | `EnvFile` | `~/.config/mpu/.env`, слой секретов/подключений |
| журнал вызовов | `InvokeLog`, `RunId` | одна запись на вызов команды; `run_id` = время+pid |
| dev-стенд | `Dev` | отдельная нода; одна PG-БД на всех клиентов |
| read-only сессия | `ReadOnlySession` | PG-сессия с серверным запретом записи |
| инстанс | `Instance` | сервер `sl-N` (N > 0) с per-client схемами; main — `sl-0` |
| оркестратор | `Portainer` | Portainer API — реестр endpoint'ов и контейнеров стенда |
| контейнер | `Container` | Docker-контейнер стенда; `mp-sl-<N>-cli` — CLI-контейнер сервера N |
| discovery | `Discovery` | обход Portainer (endpoints → контейнеры) с записью в кэш-БД |
| снапшот кэша | `Snapshot` | полная перезапись клиентских таблиц кэш-БД одной транзакцией |
| точечный синк | `ClientSync` | upsert одного клиента в кэш-БД без полного снапшота |
| книга | `Workbook` | содержимое `.xlsx` целиком |
| лист | `Sheet` | вкладка книги/таблицы |
| диапазон | `Range` | `Лист!A1:B2`; открытый — без одной из границ |
| алиас | `Alias` | короткое имя пути к `.xlsx` в кэш-БД |
| хост стенда | `Host` | значение Loki-label `host`: `sl-N`, `wb-N`, `dt-N`, `wb-clusters`, `wb-positions` |
| сервис стенда | `ComposeService` | значение Loki-label `compose_service` (`api`, `wb-loader`, …) |
| запись лога | `LogEntry` | единица ответа Loki: наносекундный ts + строка лога |
| meta-блок | `MetaBlock` | служебная шапка SQL-команд в stderr (server/host/БД/search_path/режим/SQL) при `--dry`/`-v` |
| БД воркспейсов | `WorkspacesDb` | PG-база sw-back; SQL к ней исполняется изнутри контейнера sw-back (sw-алиасы селектора) |
| транспорт | `Transport` | способ доставки exec: `ssh` \| `portainer`; выбирается per-server |
| таргет | `Target` | адресат выполнения: сервер (`sl-N`/dev) либо контейнер по точному имени |
| Portainer-endpoint | `Endpoint`, `EndpointId` | окружение Portainer; пара (base_url, endpoint_id) адресует Docker API сервера |
| кэш контейнеров | `ContainerCache` | таблица `portainer_containers` в кэш-БД: снапшот discovery всех контейнеров фермы |
| fan-out | `FanOut` | прогон одной команды по списку таргетов (последовательно или параллельно) |
| фоновый запуск | `DetachedRun`, `DetachId` | detach-режим `run-js`; id — 8 hex-символов, скрипт и лог в `/tmp` контейнера |
| one-shot контейнер | `OneShotContainer` | разовый job (`migrations`/`init-`): `Exited (0)` — норма, не сбой |
| лоадер-контейнер | `LoaderContainer` | демон с лоадер-подстрокой в имени — цель tail в `mpu health` |
| карточка | `Card`, `CardId` | карточка Kaiten; web-URL — `{base}/{id}` |
| селектор карточки | `CardRef` | адрес карточки: голый ID или URL (id — последний числовой сегмент пути) |
| пространство | `Space` | пространство Kaiten — контейнер досок |
| доска | `Board` | доска Kaiten внутри пространства |
| дорожка | `Lane` | горизонтальная дорожка доски Kaiten |
| колонка доски | `Column` | колонка доски Kaiten; по её названию выводится этап |
| роль | `Role` | роль компании Kaiten — «тип работ» записей учёта времени |
| этап | `Stage` | канонический шаг конвейера (Очередь…Готово) из названия колонки |
| метка состояния | `StateLabel` | числовой state карточки → `queued`/`in progress`/`done` |
| источник строки | `Source` | почему карточка в выдаче `status`: assigned/time/activity |
| касание | `Touch` | карточка только из ленты действий: не назначена, время не списывал |
| справочник Kaiten | `KaitenRefs` | локальный кэш пространств/досок/дорожек/колонок/ролей/кастомных полей в кэш-БД |
| токен-кэш | `TokenCache` | файл `.api-token.json`: JWT sl-back + срок годности, общий для процессов |
| декларативный эндпоинт | `EndpointSpec` | запись реестра `mpu api`: метод + путь + поля тела → команда |
| загрузчик | `Loader` | per-sid конечный автомат wb-loader-app; ровно 25 |
| имя загрузчика | `LoaderName` | camelCase-форма (`wbCards`) — фильтры blocked/resume |
| слаг загрузчика | `LoaderEntity` | kebab-форма (`cards`) — сегмент URL loader-роутов |
| причина блокировки | `BlockedReason` | значение `blocked_reason`: operational либо permanent |
| кэш wb-серверов | `WbServersCache` | файл `.wb-loader-servers.json`: имена инстансов для автодополнения `--server` |
| прямой sid-режим | `DirectSid` | адресация по явному sid (UUID-форма / `--sid`) без резолва клиента |
| curl-сниппет | `CurlSnippet` | вывод `--print`: эквивалентный curl без выполнения, копия в буфер |
| релог | `Relog` | повторная фиксация перемещения в ту же колонку: PATCH в соседнюю колонку и обратно |
| журнал перемещений | `MoveLog` | локальный журнал перемещений карточек в кэш-БД; пополняют `move`/`ready`/`review`/`close` |
| журнал полей | `FieldLog` | локальная история значений скалярных полей карточки; поле карточки = последняя запись пары (карточка, поле) |
| вид поля | `FieldKind` | закрытый список скалярных полей карточки: `mr`, `hypothesis`, `done`, `result` |
| кастомное поле | `CustomProperty` | кастомное поле карточки Kaiten; ключ в PATCH-теле — `id_<NNN>` |
| артефакт | `Artefact` | файловое поле карточки «9. AI-артефакт» (id 610303); заполняется md-вложением |
| владелец карточки | `Owner` | owner карточки Kaiten (заказчик); цель раскрытия `@all` |
| адресат | `Recipient` | токен `@handle` первой строки комментария |
| вложение | `Attachment` | файл, прикреплённый к комментарию карточки |
| запись времени | `TimeLog`, `TimeLogId` | запись учёта времени на карточке Kaiten; единица длительности — целая минута (wire-поле time_spent) |
| таймер | `Timer`, `TimerId` | личный таймер пользователя Kaiten на карточке; источник истины — поле timer в GET /cards/{id} |
| подсказка таймера | `TimeHint` | локальная строка кэш-БД (одна на карточку): id таймера, роль, комментарий, метка старта, момент последнего списания; эвристика, всегда перепроверяется сервером |
| webapp | `Webapp` | Apps Script-прокси Google Sheets; единственный сетевой канал области sheet (POST {action, …} на WB_PLUS_WEB_APP_URL) |
| экшен webapp | `Action` | имя операции webapp в теле POST (`spreadsheets/values/batchGet`, `spreadsheets/get`, …) |
| кэш листов | `SheetCache` | whole-tab кэш содержимого листов в кэш-БД (таблица sheet_tabs); единица кэширования — лист целиком |
| метаданные листа | `SheetInfo` | title/sheetId/index/rows/cols листа из экшена spreadsheets/get; кэшируются ключом sheet:info:<ss_id> |
| режим рендера | `RenderMode` | слой значений sheet get: both \| values \| formulas \| formatted |
| вид резолва цели | `ResolveKind` | как разобрано значение цели-spreadsheet: url \| id \| alias \| client_id \| title_fuzzy (поле kind в выводе resolve) |
| скрипт мини-языка | `Script` | текст из инструкций batch-мини-языка (из -e/--from/stdin), компилируется целиком |
| инструкция | `Statement` | одна единица скрипта (строка или ;-сегмент); номер инструкции — N в префиксе ошибок «строка N:» |
| глагол | `Verb` | ведущее слово (или пара слов) инструкции записи: set, label, cols insert, … |
| стиль-флаг | `StyleFlag` | токен оформления (bold, bg=#hex, fmt=…) → userEnteredFormat + fields-маска |
| условие | `Condition` | токен условия validate/cond add (num>=N, one-of=…, blank…) → BooleanCondition Sheets API |
| аспект | `Aspect` | sheet-level срез структуры в read-языке batch-get (merges, cond, protected, …) |
| план чтения | `ReadPlan` | результат компиляции batch-get: параметры values/batchGet и/или аспекты+листы для spreadsheets/get |
| грид-диапазон | `GridRange` | каноническая форма диапазона Sheets API: sheetId + 0-based полуоткрытые границы, открытые опущены |
| диапазон размерности | `DimensionRange` | диапазон столбцов/строк Sheets API: sheetId, dimension COLUMNS\|ROWS, 0-based полуоткрытые индексы |
| MR (merge request) | `MergeRequest` | GitLab merge request; адресуется project!iid, iid — внутрипроектный номер |
| MR-селектор | `MrRef` | строка адресации MR: URL \| 'group/repo!iid' \| голый iid \| пусто (автодетект из ветки cwd) |
| проект GitLab | `Project` | путь group/repo; в REST-путях URL-encoded (/ → %2F) |
| дискуссия (тред) | `Discussion` | тред комментариев MR, id — 40-hex; general-тред — без привязки к строке |
| нота | `Note` | одно сообщение треда; системные (system=true) исключаются из ревью всегда |
| позиция | `Position` | привязка инлайн-комментария к строке диффа: 3 SHA + old/new path + old/new line, только form-urlencoded |
| дифф файла | `FileDiff` | изменение одного файла MR: old/new path, unified diff, флаги new/renamed/deleted (статус A/D/R/M) |
| строка диффа | `DiffLine` | строка unified diff: added/removed/context + номера на old/new-сторонах |
| сторона диффа | `Side` | new (правая колонка диффа GitLab) / old (левая); адресация строки комментария |
| ветка пайплайна | `PipelineBranch` | одна из шести веток деплой-конвейера (trunk/main/dev/qa/predprod/prod) — фиксированные колонки таблицы glab-status |
| landing-коммит | `LandingCommit` | коммит, которым MR попал в целевую ветку: первый непустой из merge_commit_sha → squash_commit_sha → sha; по нему определяются галочки веток |
| прочие ветки | `OtherBranches` | ветки с landing-коммитом вне шести веток пайплайна и без source-ветки самого MR; null = данных нет (не запрашивали/недоступно), [] = запросили, пусто |
| диалог | `Dialog` | строка выдачи `telegram ls`: id, title, kind (user\|bot\|group\|channel\|unknown), username |
| маркированный id | `MarkedId` | id чата в клиентской конвенции Telegram: канал/супергруппа −(10^12+raw), базовая группа −raw, пользователь/бот raw; пригоден как адресат |
| строка сессии | `SessionString` | сериализованная MTProto-сессия пользователя в env `TELEGRAM_SESSION`; пишется `mpu init` |
| 10X | `X10` | web-платформа (sw-back API); admin-доступ через staff-аккаунт, база URL X10_URL c авто-суффиксом /api |
| воркспейс | `Workspace`, `WorkspaceId` | воркспейс 10X; инвариант workspace.id == client_id (user.id != workspace.id) |
| impersonation | `Impersonation` | вход в 10X от лица клиента через staff-права; создание сессии пишет audit-запись на проде |
| 10X-сессия | `X10Session` | кэшированный Bearer-токен 10X (вид staff\|impersonation, субъект — логин-email\|user.id); TTL = exp из JWT минус 60 с, fallback 600 с |
| staff-поиск | `StaffSearch` | поиск цели impersonation в 10X: GET /users/staff/search?query&scope; названием клиента/кабинета не ищет |
| scope staff-поиска | `Scope` | трактовка селектора 10X-резолва: auto\|user\|access; auto → access для целого и полного uuid sid, иначе user |
| email-кэш 10X | `EmailClient` | локальная строка кэша email → owned client_ids + сырые воркспейсы (таблица x10_email_clients, PK email в нижнем регистре) |
| owned-воркспейс | `OwnedWorkspace` | воркспейс, где цель impersonation — владелец (ownerId == user.id); источник owned client_id |
| проекция | `Projection` | режим вывода mpu search: одно поле результата голыми строками (null → пустая строка, список sid — CSV); не больше одного флага |
| inner-команда | `InnerCommand` | команда sl-back CLI `node cli service:<сервис> <метод> [флаги]`, собираемая node-CLI обёрткой |
| режим обёртки | `WrapMode` | способ доставки inner-команды: exec через Portainer \| печать ssh-формы \| печать локальной формы; выбирается флагами --print/--local |
| безопасный токен | `SafeToken` | whitelist-валидация значения флага inner-команды (только `A-Za-z0-9 _ . / : - , @ [ ]`); нарушение — exit 2 до сети и печати |
| фрейм | `Frame` | фрейм доски Miro; единица идемпотентного рендера d2-miro (одноимённый удаляется и пересоздаётся на прежнем месте) |
| доска Miro | `MiroBoard` | доска Miro (env MIRO_BOARD_ID / --board); отличать от Board — доски Kaiten |
| shared-таблицы | `SharedTables` | фиксированный список из 18 общих справочных таблиц PG-схемы shared, переносимых copy-shared |
| dt-host | `DtHost` | локальный контейнер переноса данных (compose.sl-dt-host.yaml, `exec cli`); исполняет перенос shared-таблиц и клиентов |
| локальный стенд | `LocalStack` | локальный docker dev-стек (mp-config-local + local-stack): core sl-0/sl-1/nats/nginx/dt-host + web; единственный допустимый target записи копий, host всегда 127.0.0.1 |
| compose-стек | `Stack` | набор env-файлов/compose-файлов/сервисов для одного вызова docker compose up куска стенда (mp-nats, sl-0, sl-1, mp-nginx, dt-host, sw-back-deps); порядок core-стеков — упорядоченная последовательность |
| keep-лист | `KeepList` | инверсный список client_id, которые clean-local-clients оставляет (дефолт 54,776); схема shared сохраняется всегда неявно |
| ход клиента | `Move` | запись «source → target» последнего переноса клиента в кэш-БД (таблица client_moves, PK client_id — одна запись на клиента); пишет move-client, читает/удаляет move-client-back |
| job переноса | `TransferJob` | постановка clientsTransfer createJob (--destroy всегда) в контейнере mp-dt-cli; реальный перенос исполняют внешние воркеры, команда отслеживает только постановку |
| проводка входа | `LoginSeed` | идемпотентный посев user+workspace+кабинеты+подписки в БД воркспейсов для входа в локальный sw-front (email client_<id>@local.host, workspace.id == client_id); best-effort шаг copy-client, снимается clean-local-clients только по своей email-сигнатуре |
| public-строки клиента | `PublicRows` | строки public-таблиц клиента на инстансе (clients, *_loader_info*, clients_modules, spreadsheets и её дети по spreadsheet_id), сопровождающие схему при копии и очистке |
| токен-строки | `TokenRows` | clients/wb_tokens/clients_wb_cabinets на main (sl-0) — authoritative store токенов, копируются отдельно от инстансовых public-строк |
