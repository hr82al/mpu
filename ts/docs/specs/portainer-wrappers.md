# mpu node-CLI обёртки — семейство команд

Статус: к реализации (заморожена 2026-08-17; уточнена по приёмке
первой порции 2026-08-19 — счёт голденов, пустое значение флага,
отклонение про голый вызов; расширена второй порцией 2026-08-27 —
очереди задач, миграции и загрузчик Ozon, раскладка селектора у
группы)

## Назначение

Четырнадцать команд-обёрток, каждая запускает один метод sl-back CLI
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
   подкоманды. Так работают `wb-jobs`, `data-loader-jobs`, `ozon-jobs`
   и `app-migrations`.

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
- **preserve** — `--skus` и `--nm-ids` передаются одним JSON-литералом
  `[1,2,3]`. Причина: парсер sl-back CLI распознаёт целочисленный
  JSON-массив, форма не подвержена схлопыванию. (Три разных обхода
  одного нижестоящего квирка — идея унификации в журнал переезда.)

## Открытые вопросы

нет
