# mpu node-CLI обёртки — семейство команд

Статус: к реализации (заморожена 2026-08-17; уточнена по приёмке
первой порции 2026-08-19 — счёт голденов, пустое значение флага,
отклонение про голый вызов)

## Назначение

Семь команд-обёрток, каждая запускает один метод sl-back CLI
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
- Подкоманды есть только у `wb-loader`. Остальные шесть — листовые:
  метод у каждой один и зашит, селектор идёт первым аргументом
  (`mpu data-loader <селектор> --sids …`).

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
- Незаданный опциональный флаг не оставляет следа в inner-команде.
  «Незаданный» — это отсутствие флага; явная пустая строка значением
  флага не исчезает молча, а отвергается SafeToken (минимум один
  символ) — как в оригинале.

## Граничные случаи и ошибки

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
- **preserve** — `--skus` и `--nm-ids` передаются одним JSON-литералом
  `[1,2,3]`. Причина: парсер sl-back CLI распознаёт целочисленный
  JSON-массив, форма не подвержена схлопыванию. (Три разных обхода
  одного нижестоящего квирка — идея унификации в журнал переезда.)

## Открытые вопросы

нет
