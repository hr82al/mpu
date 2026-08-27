# mpu node-CLI обёртки — семейство команд

Статус: к реализации (заморожена 2026-08-17; уточнена по приёмке
первой порции 2026-08-19 — счёт голденов, пустое значение флага,
отклонение про голый вызов; расширена второй порцией 2026-08-27 —
очереди задач, миграции и загрузчик Ozon, раскладка селектора у
группы)

## Назначение

Двадцать команд-обёрток, каждая запускает один метод sl-back CLI
(`node cli service:<сервис> <метод>`) в cli-контейнере сервера
клиента. Общая машинерия (режимы, сборка inner-команды, валидация,
auto-pick) — `platform/portainer.md`; здесь — CLI-поверхность и таблица
«обёртка → inner-команда → эффект». Не путать с `mpu api wb-loader-*`
(HTTP-семейство, отдельные спеки).

## CLI-контракт

Общий синопсис:
`mpu <обёртка> [<sub>] SELECTOR [--server sl-N] [--print/-p] [--local]
[--client-id N] [доменные флаги]`

- `SELECTOR` — базовый резолв `platform/selector.md`; `--server sl-N` —
  override сервера.
- `--client-id` — явное значение; без него auto-pick из кандидатов
  (`platform/portainer.md`).
- `--print`/`-p`, `--local` — режимы печати (`platform/portainer.md`);
  `--print` — read-only-вариант семейства
  (`platform/readonly-default.md`, паттерн exec-обёрток: дефолт — писать
  немедленно).
- У каждого доменного флага два равнозначных написания: kebab и snake
  (`--date-from` / `--date_from`); канон в inner-команде — kebab.
- Команда (или группа) без аргументов/подкоманды печатает справку,
  exit 2.

Раскладка селектора у семейства **две**, и обе сохранены от рабочей
версии: команды набирают руками каждый день, и «сделаем везде
одинаково» стоило бы переучивания.

1. **Селектор у подкоманды** (умолчание реестра):
   `mpu <группа> <подкоманда> SELECTOR [флаги]`. Так работают
   `wb-loader`, `clients-migrations`, `datasets-migrations`,
   `ozon-loader` и все листовые обёртки.
2. **Селектор у группы**: `mpu <группа> [-p [--local]] SELECTOR
   <подкоманда> [флаги]` — селектор и режимы печати набираются до имени
   подкоманды. Так работают `wb-jobs`, `data-loader-jobs`, `ozon-jobs`,
   `app-migrations` и `users`.

Вторую раскладку объявляет сама группа (`layout: "selector-first"` в
реестре, `platform/registry.md`): точка входа опознаёт имя подкоманды с
пропуском и вырезает его из аргументов, а разбирает вход всё та же
схема листа. Своей схемы аргументов у группы нет — второго разборщика
argv в системе не заводится.

Таблица семейства (сервис и метод — дословно; `<C>` = client_id):

| Обёртка | Inner-команда | Доменные флаги | Эффект |
| --- | --- | --- | --- |
| `ss-update` | `service:ssUpdater update --client-id <C> --spreadsheet-id <S> --update-type <T> --logs <L>` | `--spreadsheet-id` (auto-pick), `--update-type` (default `schedule`), `--logs` (default `info`) | запуск пайплайна обновления Google-таблицы клиента |
| `wb-loader <sub>` | `service:wbLoader <метод> --client-id <C> --sid <SID>` | `--sid` — обязательный | загрузка данных WB-кабинета в БД клиента |
| `data-loader` | `service:dataLoader findCandidate --client-id <C> --sids <S1> [<S2> …]` | `--sids` (алиас `--sid`) — повторяемый, обязательный; в inner-команде флаг стоит один раз, значения идут подряд отдельными токенами | поиск кандидата загрузки по кабинетам |
| `wb-recalculate-expenses` | `service:wbUnitCalculatedData recalculateExpenses --client-id <C> --date-from <F> --date-to <T> [--nm-ids <[..]>]` | `--date-from` (default `2025-01-01`), `--date-to` (default — сегодняшняя локальная дата), `--nm-ids` — одна строка вида `[1,2,3]` без пробелов | пересчёт расходов WB UNIT за период |
| `wb-save-expenses` | `service:wbUnitCalculatedData saveExpenses …` (флаги как строкой выше) | те же | сохранение расходов WB UNIT за период |
| `ozon-recalculate-expenses` | `service:ozonUnitCalculatedData recalculateExpenses --client-id <C> --date-from <F> --date-to <T> [--ref-date <D>] [--ref-fields <F1> …] [--skus <[..]>] [--logs-level <L>]` | `--ref-date`; `--ref-fields` — повторяемый; `--skus` — повторяемый int, эмитится одним токеном `[v1,v2,…]`; `--logs-level`; `-v/--verbose` | пересчёт расходов Ozon UNIT за период (с опц. копированием полей из ref-даты) |
| `ozon-save-expenses` | `service:ozonUnitCalculatedData saveExpenses --client-id <C> --date-from <F> --date-to <T>` | только даты (дефолты как у wb-*) | сохранение расходов Ozon UNIT за период |

Вторая порция (2026-08-27); `<C>` = client_id, `<S>` = кабинет Ozon:

| Обёртка | Подкоманды | Inner-команда | Доменные флаги | Эффект |
| --- | --- | --- | --- | --- |
| `wb-jobs <sub>` | `show` | `service:wbJobs showJobs` | `--pattern` | очередь задач WB-загрузчика на сервере |
| `data-loader-jobs <sub>` | `show` | `service:dataLoaderJobs showJobs` | `--pattern` | очередь задач загрузчика данных |
| `ozon-jobs <sub>` | `show`, `prune` | `service:ozonJobs showJobs` / `pruneJobs` | `--pattern` | очередь задач Ozon-загрузчика; `prune` её чистит |
| `app-migrations <sub>` | `latest`, `up` | `service:appMigrations <метод>` | `--name` | миграции схемы приложения на сервере |
| `clients-migrations <sub>` | `latest`, `up`, `rollback`, `down`, `init` | `service:clientsMigrations <метод> --client-id <C> --type <T>` | `--type` обязателен; `--name`, `--forced` | миграции клиентской схемы |
| `clients-migrations latest-all` | — | `service:clientsMigrations latestAll --type <T>` | `--type` обязателен | `latest` по всем клиентам сервера |
| `datasets-migrations <sub>` | `latest`, `up`, `rollback`, `down`, `list` | `service:datasetsMigrations <метод> --client-id <C> --dataset <D>` | `--dataset` обязателен; `--name` | миграции датасетов клиента |
| `ozon-loader <sub>` | `postings-reports`, `performance-reports`, `search-promo`, `campaign-daily-statistics`, `campaigns`, `transactions` | `service:ozonLoader <метод> --client-id <C> --seller-client-id <S>` | `--seller-client-id` обязателен, не повторяется | загрузка данных Ozon-кабинета в БД клиента |
| `ozon-loader load-data` | — | `service:ozonLoader loadData --client-id <C> --seller-client-ids <S…> --sequence <18 токенов>` | `--seller-client-id` обязателен, повторяемый | загрузка всех данных кабинетов по зашитой последовательности |

Третья порция (2026-08-27), штучные обёртки:

| Обёртка | Inner-команда | Доменные флаги | Эффект |
| --- | --- | --- | --- |
| `ss-load` | `service:ssLoader load --dataset <D> --client-id <C> --spreadsheet-id <S> [--sheet-name <N>] [--forced] --logs <L>` | `--dataset` обязателен; `--sheet-name`, `--forced`, `--logs` (default `info`, эмитится всегда), `--spreadsheet-id` (auto-pick) | загрузка листа Google-таблицы клиента в БД |
| `ss-datasets` | `service:ssDatasets add --spreadsheet-id <S> --dataset <D> [--sheet-name <N>] [--is-active]` | `--dataset` обязателен; `--sheet-name`, `--is-active`, `--spreadsheet-id` (auto-pick) | регистрация датасета таблицы клиента |
| `wb-unit-calc` | `service:wbUnitCalc getUnitDataByDateNmId --client-id <C> --nm-id <N> --date <D>` | `--nm-id` обязателен; `--date` (default — сегодняшняя локальная дата, эмитится всегда) | расчётные данные WB UNIT по товару за дату |
| `wb-unit-proto-new` | `service:wbUnitProtoNew copyDataFromOldTable --client-id <C>` | нет | перелив данных WB UNIT из старой таблицы в новую |
| `users add` | `service:users add --email <E> [--id <I>] [--user <U>] [--name <N>] [--password <P>] [--is-active]` | `--email` обязателен; остальные необязательны | заведение пользователя sl-back на сервере |
| `users add-role` | `service:users addRole --id <I> --role <R>` | `--id` и `--role` обязательны | выдача роли пользователю sl-back |

`ss-load`, `ss-datasets`, `wb-unit-calc`, `wb-unit-proto-new` — листовые,
селектор идёт первым аргументом. `users` — группа с раскладкой «селектор у
группы»: `mpu users -p sl-1 add --email …`. `--client-id` нет у `ss-datasets`
(датасет адресуется таблицей) и у обеих подкоманд `users` (пользователь
принадлежит серверу). У `ss-load` он есть, но стоит вторым: порядок флагов
метода начинается с `--dataset`.

Ни аргументы, ни вывод `users add` в журнал вызовов не пишутся: среди
аргументов пароль, а в режиме `-p` тот же пароль виден в напечатанной
строке — поэтому у команды обе пометки, «аргументы не журналируются» и
«без записи вывода» (`platform/invoke-log.md`). У `users add-role`
пометок нет — скрывать там нечего.

Четвёртая порция (2026-08-27), самая широкая обёртка семейства:

| Обёртка | Inner-команда | Доменные флаги | Эффект |
| --- | --- | --- | --- |
| `process` | `service:dataProcessor process --client-id <C> [--spreadsheet-id <S>] [--date-from <F>] [--date-to <T>] [--domain <D>] [--dataset <N>] [--datasets <N…>] [--modules <M…>] [--exclude-datasets <N…>] [--exclude-modules <M…>] [--with-tags <T…>] [--without-tags <T…>] [--no-deps] [--forced] [--forced-update] [--dry-run] [--sid <SID>] [--nm-ids <[..]>] [--skus <[..]>] [--logs <L>]` | все необязательны; `--spreadsheet-id` — auto-pick; `-v/--verbose` | пересчёт витрин клиента |

Порядок флагов в inner-команде — порядок этой строки; пропущенные не
эмитятся. `--spreadsheet-id` подставляется из кандидатов селектора, если
значение там одно; **неоднозначность здесь не ошибка** — флаг просто не
эмитится, в отличие от `ss-load`, где таблица адресует вызов.

### Три правила списков

Внешне похожи, но обходят разные квирки парсера sl-back CLI, и
унифицировать их нельзя:

1. **Строковые списки** (`--datasets`, `--modules`, `--exclude-datasets`,
   `--exclude-modules`, `--with-tags`, `--without-tags`): флаг один раз,
   значения подряд отдельными токенами — но **единственное значение
   дублируется**: `--datasets wb_unit` → `--datasets wb_unit wb_unit`.
2. **`--skus`**: повторяемый у оператора, в inner-команде — один токен
   `[1,2]` без пробелов.
3. **`--nm-ids`**: приходит от оператора уже строкой `[7,8]` и уходит как
   есть; содержимое не проверяется.

`--dataset` (единственное число) — обычная строка: дублирования нет.

### Ветка `dev:N`

Селектор `dev:N` идёт мимо резолва: на dev-ноде прод-кэша клиентов нет,
поэтому `--client-id` там **обязателен**, а его отсутствие — ошибка
ввода, exit 2. Печать в этом режиме даёт не ssh-обёртку, а строку
`mpu ssh dev:N -- <inner>`: до dev-ноды ходит соседняя команда, и второй
копии её ключа и хоста здесь не заводится. Выполнение идёт ssh в
контейнер `mp-sl-N-cli` (`platform/exec-transport.md`, ветка `dev`).
Нечисловой хвост селектора → `mpu process: dev-селектор ожидает номер
sl-сервера: ``dev:N`` (например dev:1)`, exit 2.

Автодополнения значений (`--domain`, `--logs`, теги, живой список SKU из
БД) у команды **нет**: у нас дополнение собирается из реестра, а живой
SQL ради подсказки — отдельный разговор.

Подкоманда → метод: `show` → `showJobs`; `prune` → `pruneJobs`;
`latest-all` → `latestAll`; `postings-reports` → `ozonPostingsReports`;
`performance-reports` → `ozonPerformanceReports`; `search-promo` →
`ozonSearchPromo`; `campaign-daily-statistics` →
`ozonCampaignDailyStatistics`; `campaigns` → `ozonCampaigns`;
`transactions` → `ozonTransactions`; `load-data` → `loadData`. У
миграций и `list` имя метода совпадает с именем подкоманды.

`--client-id` есть не у всех: у `wb-jobs`, `data-loader-jobs`,
`ozon-jobs`, `app-migrations` и `clients-migrations latest-all` его нет
ни в inner-команде, ни в CLI. Вызов адресуется сервером, а метод сам
разъезжается по клиентам; принимать значение, которое некуда девать,
значило бы молча его терять.

Правило эмиссии значения одно на семейство: `None`/`false` — флага нет
вовсе; `true` — голый флаг без значения (`--forced`); строка или число
— `--флаг значение`; список — флаг **один раз**, значения подряд
отдельными токенами (`--sids`, `--seller-client-ids`, `--sequence`).

Подкоманды `wb-loader` → метод: `reports` → `wbReports`; `cards` →
`wbCards`; `adv-auto-keywords-stats` → `wbAdvAutoKeywordsStats`;
`adv-fullstats` → `wbAdvFullstats`; `search-texts` → `wbSearchTexts`;
`analytics-by-period` → `wbAnalyticsByPeriod`; `adverts` → `wbAdverts`;
`search-clusters-bids` → `wbSearchClustersBids`.

Особенности:

- `-v/--verbose` (только `ozon-recalculate-expenses`): перед доставкой
  печатает `# inner: <inner-команда>` в stderr — во всех режимах.
- `--ref-fields` с единственным значением эмитится дважды
  (см. «Известные отклонения», preserve).
- Порядок флагов в inner-команде — как в таблице (стабилен).
- Имя `<команда>` в ошибках: `mpu <обёртка>`; у группы с подкомандами —
  имя группы (`mpu wb-loader`) для всех подкоманд.
- Подкоманды первой порции есть только у `wb-loader`. Остальные шесть —
  листовые: метод у каждой один и зашит, селектор идёт первым
  аргументом (`mpu data-loader <селектор> --sids …`). Все семь команд
  второй порции — группы с подкомандами.

## Ввод/вывод

exec-режим: stdout/stderr inner-команды стримятся (одним потоком —
`platform/exec-transport.md`), код выхода наследуется 1:1, собственных
сообщений об успехе нет. print-режимы: единственная строка команды в
stdout + буфер обмена, exit 0. Ошибки — stderr
`<команда>: <причина>` (+ список кандидатов, если есть), exit 2.

## Побочные эффекты

exec-режим — прод-мутация: recalculate/save-expenses пересчитывают и
пишут расчётные данные UNIT клиента за период; `ss-update` запускает
запись в Google-таблицу; `wb-loader` — загрузку из WB API в БД клиента;
`data-loader find-candidate` — серверную операцию поиска кандидата.
print-режимы — без выполнения и сети (кроме чтения кэш-БД при резолве).

## Конфигурация

Всё — через `platform/portainer.md` (env `sl_<N>`, `PG_MY_USER_NAME` —
только ssh-печать), `platform/exec-transport.md` (Portainer) и
`platform/env-file.md`; собственных ключей у семейства нет.

## Инварианты

- Все обёртки трактуют `SELECTOR`, `--server`, `--print`, `--local`,
  `--client-id` идентично — одна машинерия, не копии по командам.
- Резолв селектора и auto-pick выполняются до печати: набор ошибок
  ввода одинаков в exec- и print-режимах.
- `--sid` никогда не выводится из кандидатов автоматически, даже если
  кабинет единственный, — только явное значение.
- Дефолт `--date-to` вычисляется в момент вызова (сегодняшняя дата) и
  всегда попадает в inner-команду явным токеном.
- Раскладка селектора — свойство группы, а не подкоманды: у всех
  подкоманд одной группы она одна и та же.
- Дефолт `--logs` у `ss-load` и `--date` у `wb-unit-calc` попадают в
  inner-команду всегда явным токеном: напечатанную команду вставляют в
  чужой терминал, и умолчание должно быть видно в строке.
- Обёртка без `--client-id` не спрашивает кандидатов ради него: отказ
  auto-pick не может отменить вызов, которому client_id не нужен.
- Последовательность шагов `load-data` зашита: восемнадцать токенов в
  порядке рабочей версии, опции у списка нет.
- Незаданный опциональный флаг не оставляет следа в inner-команде.
  «Незаданный» — это отсутствие флага; явная пустая строка значением
  флага не исчезает молча, а отвергается SafeToken (минимум один
  символ) — как в оригинале.

## Граничные случаи и ошибки

- Имя подкоманды перед селектором у раскладки «селектор у группы»
  (`mpu ozon-jobs show sl-2`) → `mpu <группа>: селектор ставится перед
  именем подкоманды`, exit 2, до сети. Голый `mpu ozon-jobs show` и
  `mpu ozon-jobs show --help` ошибкой не являются: позиционного токена
  за именем нет, и подкоманда отвечает своей справкой.
- Подкоманда не названа вовсе либо названа с опечаткой
  (`mpu ozon-jobs sl-2`, `mpu ozon-jobs sl-2 shwo`) → индекс группы в
  stdout, exit 2. Отличить забытую подкоманду от опечатки в ней при
  этой раскладке нельзя — оба выглядят как лишний позиционный токен, а
  индекс называет доступные подкоманды.
- `--dataset` (`ss-load`, `ss-datasets`), `--nm-id` (`wb-unit-calc`),
  `--email` (`users add`), `--id`/`--role` (`users add-role`) не заданы →
  ошибка обязательного входа разбора, exit 2, до сети.
- `--spreadsheet-id` не резолвится (у клиента две таблицы) →
  `mpu <команда>: cannot resolve --spreadsheet-id from selector; pass
  --spreadsheet-id` + строки-кандидаты, exit 2 — правило семейства,
  общее с `ss-update`.
- `dev:N` без `--client-id` → `mpu process: dev-селектор требует
  --client-id: кандидатов на dev-ноде нет`, exit 2, до сети.
- `--seller-client-id` не задан → `mpu ozon-loader: нужен
  --seller-client-id`, exit 2. Проверка идёт после резолва селектора, а
  не в схеме: у флага два смысла (один кабинет у шести подкоманд,
  повторяемый у `load-data`), и обязательность у них общая, а форма —
  нет. До сети отказ приходит в обоих случаях. Повтор флага вне `load-data` → `mpu
  ozon-loader: --seller-client-id повторяется только у load-data`,
  exit 2: у остальных шести подкоманд кабинет один.
- Селектор пуст/неоднозначен → тексты и кандидаты
  `platform/selector.md`, exit 2 — в том числе в print-режимах.
- `--client-id` не резолвится → `<команда>: cannot resolve --client-id
  from selector; pass --client-id` + кандидаты, exit 2. Аналогично
  `--spreadsheet-id` у `ss-update`.
- `--sid` (wb-loader) / `--sids` (data-loader) не заданы → ошибка
  обязательной опции CLI-парсера, exit 2.
- Значение строкового флага с shell-небезопасными символами → stderr
  `<команда>: value contains shell-unsafe chars for <флаг>: '<значение>'`,
  exit 2, без сетевых вызовов. Числовые флаги (`--client-id`) до этой
  проверки не доходят: нечисловое значение отвергается разбором ввода.
- Inner-команда завершилась ненулевым кодом → тот же код выхода, без
  дополнительных сообщений (stderr дочернего процесса уже отстримлен).
- `--skus` не задан → флаг опущен; задан N раз → один токен
  `[v1,…,vN]`. Значения — целые: нецифровое отвергается разбором ввода
  до печати и до сети, exit 2 (как у `--client-id`). У `--nm-ids`
  такой проверки нет — это одна строка, и содержимое её не проверяется.
- Повторяемый флаг (`--sids`, `--ref-fields`, `--skus`) задаётся
  человеком **только повтором флага** (`--sids a --sids b`); значения
  подряд за одним флагом (`--sids a b`) — лишний позиционный аргумент,
  exit 2. Форма «значения подряд» существует лишь в собранной
  inner-команде, где её строит сама обёртка.

## Golden-примеры

`fixtures/portainer-wrappers/`. Одиннадцать файлов, сняты 2026-08-17
прогоном рабочей версии **в print-режимах** на синтетическом конфиге
(временный конфиг-каталог: вымышленный сервер `sl-9` → `10.9.9.9`,
пользователь `probeuser`, `--client-id 777`). Ничего не выполнялось и в
сеть не ходило; живых адресов, кабинетов и клиентов в фикстурах нет.

- `ss-update-print.stdout.txt` — ssh-форма, дефолты `--update-type`
  и `--logs`;
- `wb-loader-cards-print.stdout.txt` и
  `wb-loader-cards-print-local.stdout.txt` — обе формы печати одной
  подкоманды;
- `wb-recalculate-expenses-print.stdout.txt` — `--nm-ids` одним
  скобочным литералом;
- `wb-save-expenses-print.stdout.txt`, `ozon-save-expenses-print.stdout.txt`
  — пара save-обёрток;
- `ozon-recalculate-expenses-verbose-print.stdout.txt` и одноимённый
  `.stderr.txt` — `-v` печатает `# inner: …` в stderr, а команду — в
  stdout; в той же строке видны дубль `--ref-fields` и `--skus [123]`;
- `data-loader-print.stdout.txt` — повторённый `--sids`: флаг один,
  значения подряд;
- `err-no-pg-user.stderr.txt` — ssh-печать без `PG_MY_USER_NAME`:
  `mpu ss-update: PG_MY_USER_NAME not set in ~/.config/mpu/.env`, exit 2,
  stdout пуст;
- `err-unsafe-token.stderr.txt` — значение с пробелом в строковом флаге:
  `mpu ss-update: value contains shell-unsafe chars for --spreadsheet-id:
  'a b'`, exit 2, stdout пуст.

Восемь голденов второй порции (2026-08-27) — по одному на каждую из
семи команд плюс отдельный на `load-data`, все в ssh-форме печати и на
том же синтетическом конфиге (`sl-9` → `10.9.9.9`, `probeuser`,
`--client-id 777`, кабинет `999001`):

- `wb-jobs-show-print.stdout.txt`, `data-loader-jobs-show-print.stdout.txt`
  — очередь без `--pattern`: незаданный флаг следа не оставляет;
- `ozon-jobs-show-print.stdout.txt` — та же форма с `--pattern
  ozonLoader`;
- `app-migrations-latest-print.stdout.txt` — inner-команда без
  `--client-id`;
- `clients-migrations-latest-print.stdout.txt` и
  `datasets-migrations-list-print.stdout.txt` — обязательные `--type` и
  `--dataset` после `--client-id`;
- `ozon-loader-campaigns-print.stdout.txt` — кабинет единственным
  значением;
- `ozon-loader-load-data-print.stdout.txt` — множественное число флага
  и все восемнадцать шагов `--sequence` отдельными токенами; порядок
  шагов этот голден и стережёт.

Семь голденов третьей порции (2026-08-27), тот же синтетический конфиг:

- `ss-load-print.stdout.txt` — `--client-id` вторым флагом и `--logs info`
  дефолтом;
- `ss-datasets-print.stdout.txt` — inner-команда без `--client-id`;
- `wb-unit-calc-print.stdout.txt` — `--date` явным токеном (дата задана
  флагом: дефолт — сегодняшний день, и голден с ним протух бы назавтра);
- `wb-unit-proto-new-print.stdout.txt` — метод без доменных флагов;
- `users-add-print.stdout.txt`, `users-add-role-print.stdout.txt` — обе
  подкоманды группы с раскладкой «селектор у группы»;
- `err-ambiguous-spreadsheet.stderr.txt` — отказ auto-pick
  `--spreadsheet-id` у клиента с двумя таблицами, вместе со
  строками-кандидатами.

Три голдена четвёртой порции (2026-08-27): `process-print.stdout.txt` —
простой вызов с авто-подобранной таблицей; `process-lists-print.stdout.txt`
— все три правила списков в одной строке (дубль строкового списка,
`--skus [1,2]`, `--nm-ids [7,8]`) вместе с голыми флагами;
`process-dev-print.stdout.txt` — форма ветки `dev:N`, то есть
`mpu ssh dev:1 -- …` вместо ssh-обёртки.

Эталоны печати сняты с рабочей версии; адреса, пользователь, клиент и
кабинет в них заменены на синтетические — форма и порядок токенов
важнее. У `wb-jobs` и `data-loader-jobs` эталона, **снятого с рабочей
версии**, нет и быть не может: там обе неработоспособны (см. отклонение
ниже), и форма их голденов выведена из `ozon-jobs`.

Каждый файл оканчивается одним переводом строки. **Нормализовано одно**:
абсолютный путь ssh-ключа зависит от домашнего каталога запускающего, и
в голденах он записан как `<HOME>/.ssh/id_rsa`; при сравнении домашний
каталог подставляется обратно.

Даты в голденах заданы явными флагами намеренно: дефолт `--date-to` —
сегодняшняя дата, и голден с ним протух бы назавтра. Само правило
дефолта проверяется отдельно, не побайтовым сравнением.

## Известные отклонения

- **fix** — краткие справки `ss-update`, `wb-recalculate-expenses`,
  `wb-save-expenses`, `ozon-save-expenses` в общем списке команд
  называют командой «печать ssh-команды», тогда как дефолт — выполнение
  в проде. Справка обязана называть дефолт выполнением, `--print` —
  режимом печати.
- **fix** — `--local` без `--print` молча игнорируется и команда
  выполняется в проде. Правильно: exit 2 с текстом `<команда>: --local
  имеет смысл только вместе с --print`.
- **fix** — голый вызов в оригинале отвечает по-разному: листовая
  обёртка — ошибкой разбора «Missing argument 'VALUE'», группа
  `wb-loader` — своей справкой (обе exit 2). Правильно — справка команды
  или группы, exit 2 у всех семи: у обёртки нет осмысленного вызова без
  селектора, а список подкоманд и флагов человек ищет именно там.
- **fix** — отказ при незаданном `--sids` в оригинале приходит от
  CLI-парсера (`Missing option '--sids' / '--sid'`) и не называет ни
  команду, ни то, что флаг повторяемый. Правильно —
  `mpu data-loader: нужен --sids (повторяемый; алиас --sid)`, exit 2:
  единая форма отказов семейства `<команда>: <причина>`.
- **preserve** — `--ref-fields` с единственным значением эмитится
  дважды. Причина: парсер sl-back CLI схлопывает одиночное значение
  повторяемого флага в скаляр, а метод ждёт массив; дубль безопасен
  (повторный ключ поглощается при записи). Контракт нижестоящего
  парсера — вне скоупа переезда.
- **fix** — `wb-jobs` и `data-loader-jobs` в рабочей версии
  неработоспособны: у группы одна подкоманда, и typer схлопывает её в
  плоскую команду вместе с селектором и режимами печати. Наблюдаемо:
  `mpu wb-jobs -h` показывает `Usage: mpu wb-jobs [OPTIONS]` с
  единственным `--pattern`, `-p` не существует, а `mpu wb-jobs
  --pattern zzz` падает трейсбеком `TypeError: 'NoneType' object is not
  subscriptable` в `resolve_from_ctx`, exit 1 — передать селектор
  нечем. Правильно: обе работают группой, как `ozon-jobs`
  (`mpu wb-jobs sl-1 show [--pattern …]`).
- **preserve** — `ss-datasets`, `wb-unit-calc` и `wb-unit-proto-new` в
  рабочей версии объявлены группами с единственной подкомандой (`add`,
  `get-unit-data-by-date-nm-id`, `copy-data-from-old-table`), но typer
  группу схлопывает, и наблюдаемая форма имени подкоманды не содержит:
  `mpu wb-unit-proto-new 4326 -p` печатает, а
  `mpu wb-unit-proto-new copy-data-from-old-table 4326 -p` падает
  `Got unexpected extra argument(s) (4326)`. Здесь это листовые команды
  ровно в наблюдаемой форме: имя подкоманды не вводится ни как
  обязательное, ни как допустимое. Появится вторая подкоманда — группа
  вернётся сама. Это НЕ случай `wb-jobs`/`data-loader-jobs` выше: там
  тем же схлопыванием команда сломана насмерть (селектор передать
  нечем), и потому там `fix`.
- **preserve** — `--no-is-active` у `ss-datasets` не эмитит ничего:
  эмиссия семейства выбрасывает `false` наравне с `None`, поэтому
  выключить признак командой нельзя, и оператор об этом не узнаёт.
  Поведение рабочей версии сохранено намеренно: как метод sl-back
  принимает выключение (`--is-active false`? `--no-is-active`? никак?)
  — не проверено, а гадать в обёртке нельзя (см. «Открытые вопросы»).
- **improve** — имя подкоманды перед селектором рабочая версия отбивает
  сообщением click'а `No such command 'sl-2'.` (exit 2), называя не ту
  причину: имя подкоманды ей известно, не туда поставлен селектор.
  Правильно — `mpu <группа>: селектор ставится перед именем
  подкоманды`.
- **improve** — в рабочей версии флаги уровня группы обязаны стоять
  перед селектором: `mpu ozon-jobs -p sl-2 show` печатает, а
  `mpu ozon-jobs sl-2 -p show` падает с `No such command '-p'`. У нас
  оба порядка равноправны: имя подкоманды опознаётся с пропуском, а
  флаги достаются схеме листа в любом месте argv. Расширение
  намеренное — сузить его обратно значило бы завести группе разбор
  argv, которого у неё нет.
- **preserve** — у `load-data` человек набирает `--seller-client-id`, а
  в inner-команду уходит `--seller-client-ids` (множественное число).
  Причина: так называется флаг метода sl-back CLI; контракт
  нижестоящего парсера — вне скоупа переезда.
- **preserve** — последовательность шагов `load-data` зашита
  восемнадцатью токенами и опцией не управляется. Причина: порядок
  шагов — часть контракта метода, а не выбор оператора; выведи его
  наружу — и первый же вызов с переставленными шагами сломает загрузку
  молча.
- **preserve** — единственное значение строкового списка `process`
  эмитится дважды (`--datasets wb_unit wb_unit`). Причина: парсер
  sl-back CLI схлопывает одиночное значение повторяемого флага в
  скаляр, а потребитель идёт по нему циклом и получает буквы вместо
  элементов; для Set-семантики дубль равнозначен одному значению. Тот
  же квирк, что у `--ref-fields`, и третий его обход — `--skus`.
- **preserve** — `--skus` и `--nm-ids` передаются одним JSON-литералом
  `[1,2,3]`. Причина: парсер sl-back CLI распознаёт целочисленный
  JSON-массив, форма не подвержена схлопыванию. (Три разных обхода
  одного нижестоящего квирка — идея унификации в журнал переезда.)

## Открытые вопросы

Как метод `ssDatasets add` принимает **выключение** признака активности:
`--is-active false`, `--no-is-active` или никак. От ответа зависит одна
строка обёртки — сейчас `--no-is-active` не эмитит ничего (см. «Известные
отклонения»). До ответа поведение закреплено тестом, чтобы правка была
осознанной, а не случайной.
